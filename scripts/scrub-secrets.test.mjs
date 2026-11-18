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
const { yazl } = require("playwright-core/lib/zipBundle");

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
  const { yauzl } = require("playwright-core/lib/zipBundle");
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

test("collectSecrets: takes secret-named env vars, every JSON entry, and skips short values", () => {
  const { secrets, tooShort } = collectSecrets({
    env: { OPENAI_API_KEY: KEY, PLAYWRIGHT_BASE_URL: "http://localhost:7860/", SHORT_TOKEN: "abc" },
    envFiles: [{ ANTHROPIC_API_KEY: TOKEN }],
    json: { ODD_NAME: "a-secret-with-no-secret-name" },
  });
  const names = secrets.map((s) => s.name);
  assert.ok(names.includes("OPENAI_API_KEY"));
  assert.ok(names.includes("ANTHROPIC_API_KEY"));
  assert.ok(names.includes("ODD_NAME"), "a JSON entry is taken whatever its name");
  assert.ok(!names.includes("PLAYWRIGHT_BASE_URL"), "a URL is not a secret by name");
  assert.deepEqual(tooShort, ["SHORT_TOKEN"]);
  assert.ok("abc".length < MIN_SECRET_LENGTH);
});

test("collectSecrets: adds the percent-encoded form and sorts longest first", () => {
  const { secrets } = collectSecrets({ env: { X_KEY: "abc/def+ghi=jkl" } });
  assert.deepEqual(secrets.map((s) => s.value), ["abc%2Fdef%2Bghi%3Djkl", "abc/def+ghi=jkl"]);
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
    // An APIRequestContext has no public tracing API; `_tracing` is the object the test
    // runner itself drives, which is why `request.newContext()` lands in a test's trace.
    // Internal, so a Playwright bump that renames it fails here, loudly.
    const tracing = ctx._tracing;
    assert.equal(typeof tracing?.start, "function", "APIRequestContext._tracing is gone: rewrite this fixture");
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

test("main: reads every value from the JSON variable whatever its name", async () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "r.json"), `x ${KEY} y`);
    const code = await main(["--secrets-json-env", "ALL", dir], { ALL: JSON.stringify({ WHATEVER: KEY }) }, () => {});
    assert.equal(code, 0);
    assert.equal(readFileSync(join(dir, "r.json"), "utf8"), `x ${redactionMarker("WHATEVER")} y`);
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
