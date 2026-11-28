// Unit tests for scripts/mint-app-token.mjs (#2518). Run with: npm run test:scripts
//
// Against a fake GitHub that VERIFIES the JWT's RS256 signature with the App's public
// key, so a token is minted only when the request is one GitHub would accept. No real
// App is needed: the key pair is generated per run.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { spawn } from "node:child_process";
import { writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { appJwt, apiBase, explainRefusal, mint, MintError } from "./mint-app-token.mjs";
import { makeTempDir } from "./lib/tmp-dir.mjs";

const CLI = fileURLToPath(new URL("./mint-app-token.mjs", import.meta.url));
const dir = makeTempDir("mint-app-token-");
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const KEY = join(dir, "app.pem");
writeFileSync(KEY, privateKey.export({ type: "pkcs1", format: "pem" }));
chmodSync(KEY, 0o600);
const OTHER_KEY = join(dir, "other.pem");
writeFileSync(OTHER_KEY, generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }));
const EC_KEY = join(dir, "ec.pem");
writeFileSync(EC_KEY, generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }));

const decode = (part) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));

/** A fake REST API: `mode` decides the answer; `seen` records what reached it. */
let server;
let base;
let mode = "ok";
const seen = [];
before(async () => {
  server = createServer((req, res) => {
    const auth = req.headers.authorization || "";
    const jwt = auth.replace(/^Bearer /, "");
    const [h, p, s] = jwt.split(".");
    const valid = !!s && createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, Buffer.from(s, "base64url"));
    seen.push({ method: req.method, url: req.url, header: h && decode(h), payload: p && decode(p), valid, accept: req.headers.accept });
    const reply = (status, body, headers = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(body === undefined ? "" : JSON.stringify(body));
    };
    if (mode === "skew") return reply(401, { message: "'Expiration time' claim ('exp') is too far in the future" }, { date: new Date(Date.now() - 20 * 60 * 1000).toUTCString() });
    if (mode === "500") return reply(502, { message: "Bad gateway" });
    if (mode === "notoken") return reply(201, { expires_at: "2026-01-01T00:00:00Z" });
    if (mode === "suspended") return reply(403, { message: "This installation has been suspended" });
    if (!valid) return reply(401, { message: "A JSON web token could not be decoded" });
    if (req.url !== "/app/installations/4242/access_tokens") return reply(404, { message: "Not Found" });
    return reply(201, { token: "ghs_minted_for_the_vm", expires_at: "2026-11-28T01:00:00Z" });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const ENV = () => ({ GITHUB_APP_ID: "777", GITHUB_APP_INSTALLATION_ID: "4242", GITHUB_APP_PRIVATE_KEY_FILE: KEY, GITHUB_APP_API_URL: base, GITHUB_APP_TIMEOUT_MS: "3000" });

/** The CLI, as the VM's shell runs it. */
function cli(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI], { env: { PATH: process.env.PATH, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("the JWT is RS256 over iat backdated 60 s, exp 9 minutes out, and the App id as iss", () => {
  const jwt = appJwt("777", privateKey.export({ type: "pkcs1", format: "pem" }), 1_800_000_000);
  const [h, p, s] = jwt.split(".");
  assert.deepEqual(decode(h), { alg: "RS256", typ: "JWT" });
  assert.deepEqual(decode(p), { iat: 1_800_000_000 - 60, exp: 1_800_000_000 + 540, iss: "777" });
  assert.ok(createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, Buffer.from(s, "base64url")), "signed by the App's key");
  assert.doesNotMatch(jwt, /[=+/]/, "base64url, unpadded");
});

test("a valid App mints a token: stdout is the token alone", async () => {
  mode = "ok";
  seen.length = 0;
  const r = await cli(ENV());
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "ghs_minted_for_the_vm\n");
  assert.match(r.stderr, /minted an installation token, expires 2026-11-28T01:00:00Z/);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].method, "POST");
  assert.equal(seen[0].url, "/app/installations/4242/access_tokens");
  assert.equal(seen[0].valid, true);
  assert.equal(seen[0].accept, "application/vnd.github+json");
  assert.doesNotMatch(r.stderr, /ghs_minted/, "the token never reaches the log");
});

test("the destination host gives the REST base: api.github.com, or /api/v3 on Enterprise", () => {
  assert.equal(apiBase({ ISSUE_HOST: "github.com" }), "https://api.github.com");
  assert.equal(apiBase({ ISSUE_HOST: "github.ibm.com" }), "https://github.ibm.com/api/v3");
  assert.equal(apiBase({ ISSUE_HOST: "x", GITHUB_APP_API_URL: "http://127.0.0.1:9/" }), "http://127.0.0.1:9");
  assert.throws(() => apiBase({}), (e) => e instanceof MintError && e.code === 2 && /set ISSUE_HOST/.test(e.message));
  assert.throws(() => apiBase({ ISSUE_HOST: "evil.com/x?y" }), /is not a host name/);
});

test("configuration faults exit 2 and send nothing", async () => {
  seen.length = 0;
  for (const [over, why] of [
    [{ GITHUB_APP_ID: "" }, /missing: GITHUB_APP_ID/],
    [{ GITHUB_APP_ID: "", GITHUB_APP_INSTALLATION_ID: "", GITHUB_APP_PRIVATE_KEY_FILE: "" }, /missing: GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID, GITHUB_APP_PRIVATE_KEY_FILE/],
    [{ GITHUB_APP_ID: "abc" }, /is not a numeric App id/],
    [{ GITHUB_APP_INSTALLATION_ID: "12a" }, /is not a numeric installation id/],
    [{ GITHUB_APP_PRIVATE_KEY_FILE: join(dir, "missing.pem") }, /private key file .*missing\.pem cannot be read \(ENOENT\)/],
    [{ GITHUB_APP_PRIVATE_KEY_FILE: CLI }, /could not be read as PEM/],
    [{ GITHUB_APP_PRIVATE_KEY_FILE: EC_KEY }, /the private key is ec, and a GitHub App key is RSA/],
    [{ GITHUB_APP_API_URL: "", ISSUE_HOST: "" }, /no destination/],
  ]) {
    const r = await cli({ ...ENV(), ...over });
    assert.equal(r.status, 2, `${JSON.stringify(over)}: ${r.stderr}`);
    assert.match(r.stderr, why, JSON.stringify(over));
    assert.equal(r.stdout, "");
  }
  assert.equal(seen.length, 0, "nothing was sent for a configuration fault");
});

test("a refusal exits 3 and names its cause: key, installation, suspension, clock", async () => {
  mode = "ok";
  const wrongKey = await cli({ ...ENV(), GITHUB_APP_PRIVATE_KEY_FILE: OTHER_KEY });
  assert.equal(wrongKey.status, 3);
  assert.match(wrongKey.stderr, /refused the App's JWT \(401: A JSON web token could not be decoded\): the App id or the private key is wrong/);

  const wrongInstall = await cli({ ...ENV(), GITHUB_APP_INSTALLATION_ID: "1" });
  assert.equal(wrongInstall.status, 3);
  assert.match(wrongInstall.stderr, /installation was not found \(404: Not Found\): the installation id is wrong, or it is not this App's/);

  mode = "suspended";
  assert.match((await cli(ENV())).stderr, /forbade the token \(403: This installation has been suspended\)/);

  mode = "skew";
  const skew = await cli(ENV());
  assert.equal(skew.status, 3);
  assert.match(skew.stderr, /rejected the JWT's time claims — the clock is off: this clock is 1200 s ahead of the destination's/);
  assert.match(skew.stderr, /Fix the clock/);
});

test("no answer, a 5xx, or a 201 without a token exit 4: try again, not a new key", async () => {
  mode = "500";
  const bad = await cli(ENV());
  assert.equal(bad.status, 4);
  assert.match(bad.stderr, /answered HTTP 502: try again later/);

  mode = "notoken";
  const empty = await cli(ENV());
  assert.equal(empty.status, 4);
  assert.match(empty.stderr, /201 with no token/);

  // A port nothing listens on: bound, then released (fetch refuses some well-known
  // ports outright, which would test its blocklist instead of the network).
  const probe = createServer();
  await new Promise((r) => probe.listen(0, "127.0.0.1", r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  const closed = await cli({ ...ENV(), GITHUB_APP_API_URL: `http://127.0.0.1:${port}` });
  assert.equal(closed.status, 4);
  assert.match(closed.stderr, new RegExp(`no answer from http://127\\.0\\.0\\.1:${port} \\(ECONNREFUSED\\): the network or the destination, not the key`));
  mode = "ok";
});

test("a 401 with a skewed Date and no claim message is still read as the clock", () => {
  const now = Date.parse("2026-11-28T12:00:00Z");
  assert.match(explainRefusal(401, { message: "Bad credentials" }, "Fri, 28 Nov 2026 11:50:00 GMT", now), /clock is 600 s ahead/);
  assert.match(explainRefusal(401, { message: "Bad credentials" }, "Fri, 28 Nov 2026 12:00:10 GMT", now), /App id or the private key is wrong/);
  assert.match(explainRefusal(418, null, null), /HTTP 418: no message/);
});

test("mint() is importable and resolves the token for a caller in the same process", async () => {
  mode = "ok";
  const r = await mint(ENV());
  assert.equal(r.token, "ghs_minted_for_the_vm");
});
