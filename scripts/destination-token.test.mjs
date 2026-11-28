// Unit tests for the minted destination credential's wiring (#2518):
// scripts/lib/destination-token.sh, scripts/git-credential-destination.sh, and the
// reachability alarm's use of them. Run with: npm run test:scripts
//
// The real minter runs against a fake GitHub that verifies the JWT with the App's public
// key, so "minted" below means a request GitHub would have accepted.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { spawn } from "node:child_process";
import { writeFileSync, readFileSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "./lib/tmp-dir.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const LIB = join(REPO, "scripts", "lib", "destination-token.sh");
const HELPER = join(REPO, "scripts", "git-credential-destination.sh");
const ALARM = join(REPO, "scripts", "destination-reachability-alarm.sh");
const dir = makeTempDir("destination-token-");
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const KEY = join(dir, "app.pem");
writeFileSync(KEY, privateKey.export({ type: "pkcs1", format: "pem" }));
chmodSync(KEY, 0o600);
const WRONG_KEY = join(dir, "wrong.pem");
writeFileSync(WRONG_KEY, generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" }));

let server;
let port;
let mints = 0;
before(async () => {
  server = createServer((req, res) => {
    const [h, p, s] = (req.headers.authorization || "").replace(/^Bearer /, "").split(".");
    const ok = !!s && createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, Buffer.from(s, "base64url"));
    res.writeHead(ok ? 201 : 401, { "content-type": "application/json" });
    if (ok) mints += 1;
    res.end(JSON.stringify(ok ? { token: `ghs_minted_${mints}`, expires_at: "2026-11-28T01:00:00Z" } : { message: "A JSON web token could not be decoded" }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  port = server.address().port;
});
after(() => server.close());

const APP = (over = {}) => ({ GITHUB_APP_ID: "777", GITHUB_APP_INSTALLATION_ID: "4242", GITHUB_APP_PRIVATE_KEY_FILE: KEY, GITHUB_APP_API_URL: `http://127.0.0.1:${port}`, ...over });

function sh(script, args, env, input = "") {
  return new Promise((resolve) => {
    const child = spawn("bash", ["-c", script, "x", ...args], { env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env }, cwd: REPO });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(input);
  });
}

/** Sources the lib, refreshes, and prints the two names and the return code. */
const refresh = (env) =>
  sh(`. "$1"; set +e; destination_token_refresh "$2"; rc=$?; printf 'rc=%s GITHUB_TOKEN=%s GH_TOKEN=%s\\n' "$rc" "\${GITHUB_TOKEN:-}" "\${GH_TOKEN:-}"`, [LIB, REPO], env);

test("with no App configured, the static token is left exactly as it is", async () => {
  const r = await refresh({ GITHUB_TOKEN: "static", GH_TOKEN: "static" });
  assert.equal(r.stdout.trim(), "rc=0 GITHUB_TOKEN=static GH_TOKEN=static");
  assert.equal(r.stderr, "", "and says nothing: temporary mode is a normal state");
});

test("an incomplete App says what is missing and keeps the static token", async () => {
  const r = await refresh({ ...APP({ GITHUB_APP_INSTALLATION_ID: "", GITHUB_APP_PRIVATE_KEY_FILE: "" }), GITHUB_TOKEN: "static" });
  assert.match(r.stdout, /^rc=2 GITHUB_TOKEN=static /);
  assert.match(r.stderr, /incomplete \(missing: GITHUB_APP_INSTALLATION_ID, GITHUB_APP_PRIVATE_KEY_FILE\)/);
});

test("a complete App mints into both names, and a fresh token each time", async () => {
  const before = mints;
  const r = await refresh({ ...APP(), GITHUB_TOKEN: "static", GH_TOKEN: "static" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout.trim(), /^rc=0 GITHUB_TOKEN=(ghs_minted_\d+) GH_TOKEN=\1$/);
  assert.equal(mints, before + 1);
  const again = await refresh(APP());
  assert.notEqual(again.stdout, r.stdout, "the second use gets its own token");
});

test("a refused App leaves the environment unchanged and names the cause", async () => {
  const r = await refresh({ ...APP({ GITHUB_APP_PRIVATE_KEY_FILE: WRONG_KEY }), GITHUB_TOKEN: "static", GH_TOKEN: "static" });
  assert.equal(r.stdout.trim(), "rc=3 GITHUB_TOKEN=static GH_TOKEN=static");
  assert.match(r.stderr, /refused the App's JWT \(401/);
  assert.match(r.stderr, /could not mint the destination token .* \(exit 3, cause above\); the environment is unchanged/);
});

test("the destination host comes from the lane's ISSUE_HOST when no API URL is given", async () => {
  // Not reachable here, which is the point: the minter must have built the Enterprise
  // base from ISSUE_HOST and failed on the network, not on configuration.
  const r = await refresh({ ...APP({ GITHUB_APP_API_URL: "", GITHUB_APP_TIMEOUT_MS: "2000" }), ISSUE_HOST: "ghe.example.invalid" });
  assert.match(r.stdout, /^rc=4 /);
  assert.match(r.stderr, /no answer from https:\/\/ghe\.example\.invalid\/api\/v3/);
});

/** The helper, as git calls it: `get` with the request on stdin. */
function helper(op, request, files) {
  const secrets = join(dir, `secrets-${Math.random().toString(36).slice(2)}.env`);
  const lane = join(dir, `lane-${Math.random().toString(36).slice(2)}.env`);
  writeFileSync(secrets, Object.entries(files.secrets || {}).map(([k, v]) => `export ${k}=${JSON.stringify(v)}`).join("\n") + "\n");
  writeFileSync(lane, "ISSUE_HOST=ghe.example.invalid\nISSUE_REPO=org/repo\n");
  return sh(`exec bash "$1" "$2"`, [HELPER, op], { E2E_SECRETS: secrets, E2E_LANE: lane }, request);
}

test("git's helper answers the destination's https host with a minted token, and nothing else", async () => {
  const app = { secrets: { ...APP(), GITHUB_TOKEN: "static-personal" } };
  const ok = await helper("get", "protocol=https\nhost=ghe.example.invalid\n\n", app);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /^username=x-access-token\npassword=ghs_minted_\d+\n$/);

  for (const [request, why] of [
    ["protocol=https\nhost=github.com\n\n", "another host"],
    ["protocol=http\nhost=ghe.example.invalid\n\n", "plain http"],
  ]) {
    const r = await helper("get", request, app);
    assert.equal(r.stdout, "", why);
  }
  assert.equal((await helper("store", "protocol=https\nhost=ghe.example.invalid\npassword=x\n\n", app)).stdout, "", "store is ignored");
  // No App: the static personal token is never handed to git.
  const noApp = await helper("get", "protocol=https\nhost=ghe.example.invalid\n\n", { secrets: { GITHUB_TOKEN: "static-personal" } });
  assert.equal(noApp.stdout, "");
  // A refused App answers nothing, so git fails as it would without a helper.
  const refused = await helper("get", "protocol=https\nhost=ghe.example.invalid\n\n", { secrets: APP({ GITHUB_APP_PRIVATE_KEY_FILE: WRONG_KEY }) });
  assert.equal(refused.stdout, "");
});

test("the reachability alarm reads a refused App as a refused credential", async () => {
  const state = join(dir, "alarm-state");
  mkdirSync(state, { recursive: true });
  const secrets = join(dir, "alarm-secrets.env");
  writeFileSync(secrets, "\n");
  const lane = join(dir, "alarm-lane.env");
  // The fake API's own address, so the real port probe finds it open.
  writeFileSync(lane, "ISSUE_HOST=127.0.0.1\nISSUE_REPO=org/repo\n");
  const env = { ...APP({ GITHUB_APP_PRIVATE_KEY_FILE: WRONG_KEY }), STATE_DIR: state, SECRETS_FILE: secrets, LANE_FILE: lane, PROBE_PORTS: String(port), PROBE_TIMEOUT: "3", THRESHOLD: "1", ANNOUNCE: "0" };
  const r = await sh(`exec bash "$1"`, [ALARM], env);
  assert.match(r.stdout, /ports open, but the GitHub App credential was refused — the destination refused the App's JWT \(401/);
  // And a good App lets the API check run with the minted token: it is the token that
  // reaches check-issue-credential, which this fake does not serve, so it cannot confirm.
  const good = await sh(`exec bash "$1"`, [ALARM], { ...env, ...APP() });
  assert.doesNotMatch(good.stdout, /GitHub App credential was refused/);
  assert.match(good.stdout, /ports open/);
});
