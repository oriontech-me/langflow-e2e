// Unit tests for scrub-secrets.mjs (#2486). Run with: npm run test:scripts
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "./lib/tmp-dir.mjs";
import { createRequire } from "node:module";
import {
  collectSecrets,
  parseEnvFile,
  scrubBuffer,
  scrubPaths,
  newStats,
  main,
  redactionMarker,
  MIN_SECRET_LENGTH,
} from "./scrub-secrets.mjs";

const require = createRequire(import.meta.url);
const yazl = require("yazl");

const KEY = "SECRET-PROVIDER-KEY-2486-abcdef";
const TOKEN = "SECRET-TOKEN-2486-zyxwvu";
const SECRETS = collectSecrets({ env: { FOO_API_KEY: KEY, BAR_TOKEN: TOKEN } }).secrets;

function zipOf(entries) {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    for (const [name, data] of Object.entries(entries)) zip.addBuffer(Buffer.from(data), name);
    const chunks = [];
    zip.outputStream.on("data", (c) => chunks.push(c));
    zip.outputStream.on("error", reject);
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    zip.end();
  });
}

function tmp() {
  return makeTempDir("scrub-secrets-");
}

/** Every byte of `buf`, nested zips and embedded base64 included, as one string. */
async function deepText(buf) {
  // An independent reader, so a test does not check the scrubber with its own walk.
  const seen = [];
  const yauzl = require("yauzl");
  async function visit(b) {
    if (b.subarray(0, 2).toString() === "PK") {
      const entries = await new Promise((res, rej) =>
        yauzl.fromBuffer(b, { lazyEntries: true }, (err, z) => {
          if (err) return rej(err);
          const out = [];
          z.on("end", () => res(out));
          z.on("entry", (e) =>
            z.openReadStream(e, (er, s) => {
              if (er) return rej(er);
              const c = [];
              s.on("data", (d) => c.push(d));
              s.on("end", () => {
                out.push(Buffer.concat(c));
                z.readEntry();
              });
            }),
          );
          z.readEntry();
        }),
      );
      for (const e of entries) await visit(e);
      return;
    }
    const t = b.toString("latin1");
    seen.push(t);
    for (const m of t.matchAll(/data:application\/zip;base64,([A-Za-z0-9+/=]+)/g)) await visit(Buffer.from(m[1], "base64"));
  }
  await visit(buf);
  return seen.join("\n");
}

test("collectSecrets: takes secret-named values from every source, and skips configuration and short values", () => {
  const { secrets, tooShort } = collectSecrets({
    env: { OPENAI_API_KEY: KEY, PLAYWRIGHT_BASE_URL: "http://localhost:7860/", SHORT_TOKEN: "abc" },
    envFiles: [{ ANTHROPIC_API_KEY: TOKEN }],
    json: { github_token: "ghs_0123456789abcdef", AZURE_AI_FOUNDRY_TEST_DEPLOYMENT: "gpt-4.1-mini" },
  });
  const names = secrets.map((s) => s.name);
  assert.ok(names.includes("OPENAI_API_KEY"));
  assert.ok(names.includes("ANTHROPIC_API_KEY"));
  assert.ok(names.includes("github_token"), "a JSON entry named like a credential is taken");
  // A deployment name that is also a model id would be replaced inside test titles.
  assert.ok(!names.includes("AZURE_AI_FOUNDRY_TEST_DEPLOYMENT"), "configuration kept as a secret is not scrubbed");
  assert.ok(!names.includes("PLAYWRIGHT_BASE_URL"), "a URL is not a secret by name");
  assert.deepEqual(tooShort, ["SHORT_TOKEN"]);
  assert.ok("abc".length < MIN_SECRET_LENGTH);
});

test("collectSecrets: adds the percent-encoded form and sorts longest first", () => {
  const { secrets } = collectSecrets({ env: { X_KEY: "abc/def+ghi=jkl" } });
  const values = secrets.map((s) => s.value);
  assert.ok(values.includes("abc%2Fdef%2Bghi%3Djkl") && values.includes("abc/def+ghi=jkl"));
  for (let i = 1; i < values.length; i++) assert.ok(values[i - 1].length >= values[i].length, "longest first");
});

test("a value stored as base64, at any byte alignment, is overwritten and the base64 still decodes", async () => {
  // `?` and `>` encode to `/` and `+`, so the URL-safe alphabet differs from the standard
  // one here; with a plain alphanumeric key the two are identical and one goes untested.
  const B64KEY = "SECRET-b64-???>>>~~~-2486";
  const SECRETS = collectSecrets({ env: { FOO_API_KEY: B64KEY } }).secrets;
  for (const prefix of ["", "x", "xy", "xyz"]) {
    for (const urlSafe of [false, true]) {
      let b64 = Buffer.from(`${prefix}api-key: ${B64KEY}\n`).toString("base64");
      assert.match(b64, urlSafe ? /[+/]/ : /./, "the fixture must exercise the alphabet difference");
      if (urlSafe) b64 = b64.replace(/\+/g, "-").replace(/\//g, "_");
      // The shape Playwright writes for an inline attachment body in results.json.
      const json = JSON.stringify({ attachments: [{ name: "log", contentType: "text/plain", body: b64 }] });
      const stats = newStats();
      const r = await scrubBuffer(Buffer.from(json), SECRETS, stats);
      assert.equal(r.changed, true, `prefix=${JSON.stringify(prefix)} urlSafe=${urlSafe}`);
      const body = JSON.parse(r.data.toString()).attachments[0].body;
      const decoded = Buffer.from(urlSafe ? body.replace(/-/g, "+").replace(/_/g, "/") : body, "base64").toString("latin1");
      assert.ok(!decoded.includes(B64KEY), `prefix=${JSON.stringify(prefix)} urlSafe=${urlSafe}: the key survives decoding`);
      assert.ok(decoded.startsWith(prefix), "the bytes before the value are intact");
      assert.ok(stats.counts.FOO_API_KEY >= 1);
    }
  }
});

test("a secret saved with surrounding whitespace is matched without it", async () => {
  const { secrets } = collectSecrets({ json: { PADDED_API_KEY: `${KEY}\n` } });
  const r = await scrubBuffer(Buffer.from(`Bearer ${KEY}"`), secrets, newStats());
  assert.equal(r.data.toString(), `Bearer ${redactionMarker("PADDED_API_KEY")}"`);
});

test("parseEnvFile reads a value the way dotenv does", () => {
  // dotenv ends an unquoted value at `#`; a parser that kept `abc#def` would search for a
  // value the shards never sent.
  assert.equal(parseEnvFile("A_KEY=abcdefghijklmn#def\n").A_KEY, "abcdefghijklmn");
});

test("parseEnvFile: quotes, export, comments", () => {
  const vars = parseEnvFile('# c\nexport A_KEY="q v"\nB_TOKEN=plain # trailing\nC_SECRET=\'s\'\nbad line\n');
  assert.deepEqual(vars, { A_KEY: "q v", B_TOKEN: "plain", C_SECRET: "s" });
});

test("text: every occurrence is replaced by a marker naming the variable", async () => {
  const stats = newStats();
  const r = await scrubBuffer(Buffer.from(`a ${KEY} b ${KEY} c ${TOKEN}`), SECRETS, stats);
  assert.equal(r.data.toString(), `a ${redactionMarker("FOO_API_KEY")} b ${redactionMarker("FOO_API_KEY")} c ${redactionMarker("BAR_TOKEN")}`);
  assert.deepEqual(stats.counts, { FOO_API_KEY: 2, BAR_TOKEN: 1 });
});

test("text that is not valid UTF-8 survives byte for byte outside the replaced value", async () => {
  const before = Buffer.concat([Buffer.from([0xff, 0xfe, 0x41]), Buffer.from(KEY), Buffer.from([0xc3])]);
  const r = await scrubBuffer(before, SECRETS, newStats());
  assert.deepEqual(r.data, Buffer.concat([Buffer.from([0xff, 0xfe, 0x41]), Buffer.from(redactionMarker("FOO_API_KEY")), Buffer.from([0xc3])]));
});

test("a zip nested in a zip nested in the HTML report's base64 block is scrubbed", async () => {
  const trace = await zipOf({ "test.trace": `{"params":{"value":"${KEY}"}}`, "resources/abc.json": `{"value":"${TOKEN}"}` });
  const reportData = await zipOf({ "report.json": `{"errors":["api-key: ${KEY}"]}`, "data/trace.zip": trace });
  const html = Buffer.from(
    `<html><script id="playwrightReportBase64" type="application/zip">data:application/zip;base64,${reportData.toString("base64")}</script></html>`,
  );
  const before = await deepText(html);
  assert.ok(before.includes(KEY) && before.includes(TOKEN), "the fixture carries both values");
  const r = await scrubBuffer(html, SECRETS, newStats());
  assert.equal(r.changed, true);
  const after = await deepText(r.data);
  assert.ok(!after.includes(KEY), "provider key removed at every depth");
  assert.ok(!after.includes(TOKEN));
  assert.ok(after.includes(redactionMarker("FOO_API_KEY")));
});

test("a binary file is left alone and counted, not corrupted", async () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]), Buffer.from(KEY)]);
  const stats = newStats();
  const r = await scrubBuffer(png, SECRETS, stats, "shot.png");
  assert.equal(r.changed, false);
  assert.deepEqual(stats.binary, ["shot.png"]);
});

// The fixtures above are hand-built. This one asks Playwright: a traced
// APIRequestContext request carrying the key in a header and in a JSON body, to a closed
// port, must leave the key in the trace, and the scrubbed trace must not carry it. The
// first assertion keeps the second meaningful (#2485's pattern).
test("a real Playwright trace carries the key, and the scrubbed one does not", async () => {
  const { request } = require("@playwright/test");
  const dir = tmp();
  try {
    const ctx = await request.newContext();
    // `APIRequestContext.tracing` is public since the 1.65.1 bump (#2167): typed in
    // `types.d.ts` as "Tracing recorder for requests made through this API request
    // context". On 1.58.2 the only way in was the internal `_tracing`, which 1.65.1
    // removed, so this fixture now uses the documented member. The check stays so a
    // later bump that drops it fails here by name, not on `undefined.start`.
    const tracing = ctx.tracing;
    assert.equal(typeof tracing?.start, "function", "APIRequestContext.tracing is gone: rewrite this fixture");
    await tracing.start({ snapshots: true });
    try {
      await ctx.post("http://127.0.0.1:9/api/v1/variables/", {
        headers: { "api-key": KEY },
        data: { name: "OPENAI_API_KEY", value: TOKEN },
        timeout: 5000,
      });
    } catch {
      // the port is closed: the request is still traced
    }
    const tracePath = join(dir, "trace.zip");
    await tracing.stop({ path: tracePath });
    await ctx.dispose();
    const before = await deepText(readFileSync(tracePath));
    assert.ok(before.includes(KEY), "Playwright traced the header value (the premise of #2486)");
    assert.ok(before.includes(TOKEN), "Playwright traced the body value");
    const stats = await scrubPaths([dir], SECRETS);
    assert.deepEqual(stats.residue, {});
    const after = await deepText(readFileSync(tracePath));
    assert.ok(!after.includes(KEY) && !after.includes(TOKEN));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("main: scrubs a directory in place and exits 0", async () => {
  const dir = tmp();
  try {
    mkdirSync(join(dir, "data"));
    writeFileSync(join(dir, "results.json"), `{"message":"${KEY}"}`);
    writeFileSync(join(dir, "data", "t.zip"), await zipOf({ "x.trace": KEY }));
    const lines = [];
    const code = await main([dir], { FOO_API_KEY: KEY }, (l) => lines.push(l));
    assert.equal(code, 0, lines.join("\n"));
    assert.ok(!readFileSync(join(dir, "results.json"), "utf8").includes(KEY));
    assert.ok(!(await deepText(readFileSync(join(dir, "data", "t.zip")))).includes(KEY));
    assert.ok(!lines.join("\n").includes(KEY), "the log never prints a value");
    assert.ok(lines.some((l) => l.includes("FOO_API_KEY×2")), lines.join("\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("main: reads the credentials from the JSON variable", async () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "r.json"), `x ${KEY} y`);
    const code = await main(["--secrets-json-env", "ALL", dir], { ALL: JSON.stringify({ SOME_NEW_API_KEY: KEY }) }, () => {});
    assert.equal(code, 0);
    assert.equal(readFileSync(join(dir, "r.json"), "utf8"), `x ${redactionMarker("SOME_NEW_API_KEY")} y`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("main: a corrupt zip fails the run, because its content could not be checked", async () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "broken.zip"), Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(`junk ${KEY}`)]));
    const lines = [];
    const code = await main([dir], { FOO_API_KEY: KEY }, (l) => lines.push(l));
    assert.equal(code, 1);
    assert.ok(lines.some((l) => l.includes("could not be read")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("main: a value stored literally in a binary file fails the run (it cannot be rewritten)", async () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "blob.bin"), Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(KEY)]));
    writeFileSync(join(dir, "shot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
    const lines = [];
    const code = await main([dir], { FOO_API_KEY: KEY }, (l) => lines.push(l));
    assert.equal(code, 1, lines.join("\n"));
    assert.ok(lines.some((l) => l.includes("STILL present") && l.includes("FOO_API_KEY")), lines.join("\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("main: invalid JSON in the secrets variable fails rather than scrubbing less", async () => {
  const dir = tmp();
  try {
    const code = await main(["--secrets-json-env", "ALL", dir], { ALL: "{not json" }, () => {});
    assert.equal(code, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("main: usage errors exit 2", async () => {
  assert.equal(await main([], {}, () => {}), 2);
  assert.equal(await main(["--env-file"], {}, () => {}), 2);
  assert.equal(await main(["--nope", "x"], {}, () => {}), 2);
});

test("the CLI's dotenv flag reaches the script: Node 20 swallows --env-file", () => {
  // Spawned for real, because the defect is in Node's own argument parsing and an
  // in-process main() call cannot see it.
  const { spawnSync } = require("node:child_process");
  const dir = tmp();
  try {
    writeFileSync(join(dir, ".env"), `FOO_API_KEY=${KEY}\n`);
    writeFileSync(join(dir, "r.json"), `x ${KEY} y`);
    const script = new URL("./scrub-secrets.mjs", import.meta.url).pathname;
    const r = spawnSync(process.execPath, [script, "--dotenv", join(dir, ".env"), "--dotenv", join(dir, "absent.env"), join(dir, "r.json")], {
      encoding: "utf8",
      env: { PATH: process.env.PATH },
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(readFileSync(join(dir, "r.json"), "utf8"), `x ${redactionMarker("FOO_API_KEY")} y`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("main: --require-secrets fails when no secret value reached the step", async () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "r.json"), "x");
    assert.equal(await main(["--require-secrets", "--secrets-json-env", "ALL", dir], { ALL: "" }, () => {}), 1);
    assert.equal(await main(["--require-secrets", "--secrets-json-env", "ALL", dir], { ALL: "{}" }, () => {}), 1);
    assert.equal(await main(["--secrets-json-env", "ALL", dir], { ALL: "{}" }, () => {}), 0, "without the flag, nothing known is not a failure");
    assert.equal(await main(["--require-secrets", "--secrets-json-env", "ALL", dir], { ALL: JSON.stringify({ github_token: KEY }) }, () => {}), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the CLI runs when its path has a space or is a symlink, instead of exiting 0 having done nothing", () => {
  const { spawnSync } = require("node:child_process");
  const { symlinkSync } = require("node:fs");
  const dir = tmp();
  try {
    const spaced = join(dir, "sp ace");
    mkdirSync(spaced);
    const link = join(spaced, "scrub-secrets.mjs");
    symlinkSync(new URL("./scrub-secrets.mjs", import.meta.url).pathname, link);
    writeFileSync(join(dir, "r.json"), `x ${KEY} y`);
    const r = spawnSync(process.execPath, [link, "--require-secrets", join(dir, "r.json")], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, FOO_API_KEY: KEY },
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /scrub-secrets: 1 file\(s\) read/, "main() did not run");
    assert.equal(readFileSync(join(dir, "r.json"), "utf8"), `x ${redactionMarker("FOO_API_KEY")} y`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A real assertion diff, from Playwright's own expect: the differing characters are
// wrapped in colour codes, so the key is not contiguous in results.json, while the
// report renders it whole and build-run-payload.mjs strips the codes and rejoins it.
test("a key split by colour codes in a real assertion diff is removed, raw and JSON-escaped", async () => {
  // In a child with FORCE_COLOR, as in a real run: under node:test Playwright decides
  // there is no colour and writes the diff plain. Same length as the key, so the diff
  // marks only the middle and splits the key.
  const { spawnSync } = require("node:child_process");
  const child = spawnSync(
    process.execPath,
    [
      "-e",
      `const { expect } = require("@playwright/test");
       const k = process.env.K;
       try { expect(k.slice(0, 12) + "*".repeat(k.length - 18) + k.slice(-6)).toBe(k); }
       catch (e) { process.stdout.write(JSON.stringify(e.message)); }`,
    ],
    { encoding: "utf8", cwd: new URL("..", import.meta.url).pathname, env: { PATH: process.env.PATH, FORCE_COLOR: "1", K: KEY } },
  );
  const message = JSON.parse(child.stdout || '""');
  const plain = message.replace(/\u001b\[[0-9;]*m/g, "");
  assert.ok(plain.includes(KEY), "the diff shows the key once its colour codes are stripped");
  assert.ok(!message.includes(KEY), "the premise: the key is not contiguous in the raw message");
  for (const text of [message, JSON.stringify({ message })]) {
    const r = await scrubBuffer(Buffer.from(text), SECRETS, newStats());
    const out = r.data.toString();
    const rendered = (text === message ? out : JSON.parse(out).message).replace(/\u001b\[[0-9;]*m/g, "");
    assert.ok(!rendered.includes(KEY), "the key survives once the codes are stripped");
    assert.ok(rendered.includes(redactionMarker("FOO_API_KEY")));
  }
});

test("a value with quotes, a backslash, a newline or non-ASCII is found as JSON and UTF-8 write it", async () => {
  const odd = 'pa"ss\\wörd-ç\nsecond-line';
  const { secrets } = collectSecrets({ env: { ODD_PASSWORD: odd } });
  const json = Buffer.from(JSON.stringify({ value: odd }), "utf8");
  const r = await scrubBuffer(json, secrets, newStats());
  assert.deepEqual(JSON.parse(r.data.toString("utf8")), { value: redactionMarker("ODD_PASSWORD") });
  const raw = await scrubBuffer(Buffer.from(`x ${odd} y`, "utf8"), secrets, newStats());
  assert.equal(raw.data.toString("utf8"), `x ${redactionMarker("ODD_PASSWORD")} y`);
});

test("a credential name with a numeric suffix is a credential", () => {
  const { secrets } = collectSecrets({ json: { ANTHROPIC_API_KEY_2: KEY } });
  assert.ok(secrets.some((s) => s.name === "ANTHROPIC_API_KEY_2"));
});
