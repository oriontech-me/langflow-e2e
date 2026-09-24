// Unit tests for scripts/check-push-credential.mjs.
// Run with: npm run test:scripts
//
// What these protect: the answers that differ from the umbrella's check. No token is a
// refusal here, not "could not tell", because the write path has no fallback. A token
// GitHub reports as unable to push is a refusal even though it reads the source. And
// the check asks about the repository the push actually goes to.
import { test } from "node:test";
import assert from "node:assert/strict";
import { verdict, parseRemote, main, EXIT_USABLE, EXIT_UNKNOWN, EXIT_REFUSED } from "./check-push-credential.mjs";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 24, 8, 0, 0);

/** Runs main with console.log captured. */
async function run(env, fetchImpl) {
  const lines = [];
  const log = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  try {
    return { code: await main(env, fetchImpl), out: lines.join("\n") };
  } finally {
    console.log = log;
  }
}

const answer = (status, { expiry, body = {} } = {}) => async () => ({
  status,
  headers: new Headers(expiry ? { "github-authentication-token-expiration": expiry } : {}),
  json: async () => body,
});

test("refusal is its own answer, and says what it costs", () => {
  for (const status of [401, 403, 404]) {
    const r = verdict({ status, now: NOW, warnDays: 21 });
    assert.equal(r.code, EXIT_REFUSED, `HTTP ${status} was not treated as a refusal`);
    assert.match(r.headline, /made and not pushed/);
  }
});

test("no answer is UNKNOWN, never refused", () => {
  assert.equal(verdict({ status: null, now: NOW, warnDays: 21 }).code, EXIT_UNKNOWN);
  assert.equal(verdict({ status: 502, now: NOW, warnDays: 21 }).code, EXIT_UNKNOWN);
});

test("a token that reads the source but cannot push is refused", () => {
  // The source is public: reading it proves nothing about the token. This is the one
  // signal the API gives about write, and it must not be read as "works".
  const r = verdict({ status: 200, canPush: false, expiresAt: NOW + 80 * DAY, now: NOW, warnDays: 21 });
  assert.equal(r.code, EXIT_REFUSED);
  assert.match(r.headline, /no push permission/);
});

test("without a push permission in the answer, write is not claimed", () => {
  const r = verdict({ status: 200, canPush: null, expiresAt: NOW + 80 * DAY, now: NOW, warnDays: 21 });
  assert.equal(r.code, EXIT_USABLE);
  assert.doesNotMatch(r.headline, /can push/);
  assert.match(r.headline, /did not report push permission/);
});

test("a lapsed token is refused, not 'expires in -2 days'", () => {
  const r = verdict({ status: 200, canPush: true, expiresAt: NOW - 2 * DAY, now: NOW, warnDays: 21 });
  assert.equal(r.code, EXIT_REFUSED);
  assert.match(r.headline, /expired 2 day\(s\) ago/);
});

test("the warning arrives with days to spare, and a healthy token reports its days left", () => {
  const soon = verdict({ status: 200, canPush: true, expiresAt: NOW + 10 * DAY, now: NOW, warnDays: 21 });
  assert.equal(soon.code, EXIT_USABLE, "an expiring token still works today");
  assert.equal(soon.expiring, true);
  assert.match(soon.headline, /expires in 10 day\(s\)/);

  const later = verdict({ status: 200, canPush: true, expiresAt: NOW + 87 * DAY, now: NOW, warnDays: 21 });
  assert.equal(later.expiring, undefined);
  assert.match(later.headline, /can push to the source and expires in 87 day\(s\)/);
});

test("the remote is parsed from the URL the push uses", () => {
  assert.deepEqual(parseRemote("https://github.com/oriontech-me/langflow-e2e"), { host: "github.com", repo: "oriontech-me/langflow-e2e" });
  assert.deepEqual(parseRemote("https://github.com/oriontech-me/langflow-e2e.git"), { host: "github.com", repo: "oriontech-me/langflow-e2e" });
  assert.deepEqual(parseRemote("https://github.ibm.com/Langflow/e2e-qa/"), { host: "github.ibm.com", repo: "Langflow/e2e-qa" });
  // A URL carrying credentials is not a shape this lane uses, and parsing it would put
  // the secret in a log line.
  assert.equal(parseRemote("https://x:secret@github.com/a/b"), null);
  assert.equal(parseRemote("git@github.com:a/b.git"), null);
});

test("no token is REFUSED, and nothing goes to the network", async () => {
  // Where this parts from the umbrella's check: there is no `gh` fallback on the write
  // path, so "could not tell" would understate a configuration that cannot push.
  let called = false;
  const { code, out } = await run({}, async () => { called = true; });
  assert.equal(code, EXIT_REFUSED);
  assert.equal(called, false);
  assert.match(out, /REFUSED: SOURCE_PUSH_TOKEN is unset/);
});

test("end to end: the URL, the token, the header and the permission all reach the verdict", async () => {
  // An hour of slack, because the header carries whole seconds and daysLeft floors.
  const soon = new Date(Date.now() + 6 * DAY + 3_600_000).toISOString().replace("T", " ").slice(0, 19) + " UTC";
  const seen = {};
  const { code, out } = await run(
    { SOURCE_PUSH_TOKEN: "t", SOURCE_REMOTE_URL: "https://github.com/oriontech-me/langflow-e2e" },
    async (url, init) => {
      seen.url = url;
      seen.auth = init.headers.Authorization;
      return answer(200, { expiry: soon, body: { permissions: { push: true } } })();
    },
  );
  assert.equal(code, EXIT_USABLE);
  assert.equal(seen.url, "https://api.github.com/repos/oriontech-me/langflow-e2e");
  assert.equal(seen.auth, "Bearer t");
  assert.match(out, /EXPIRING: the push credential can push to the source but expires in 6 day\(s\)/);
});

test("push: false in a real answer is a refusal end to end", async () => {
  const { code, out } = await run(
    { SOURCE_PUSH_TOKEN: "t" },
    answer(200, { body: { permissions: { push: false, pull: true } } }),
  );
  assert.equal(code, EXIT_REFUSED);
  assert.match(out, /REFUSED: .*no push permission/);
});

test("an unreadable body claims nothing about write", async () => {
  const { code, out } = await run({ SOURCE_PUSH_TOKEN: "t" }, async () => ({
    status: 200,
    headers: new Headers(),
    json: async () => { throw new SyntaxError("not json"); },
  }));
  assert.equal(code, EXIT_USABLE);
  assert.match(out, /did not report push permission/);
});

test("an enterprise remote is asked on its own API path", async () => {
  let url = null;
  await run({ SOURCE_PUSH_TOKEN: "t", SOURCE_REMOTE_URL: "https://github.ibm.com/Langflow/e2e-qa" },
    async (u) => { url = u; return answer(200)(); });
  assert.equal(url, "https://github.ibm.com/api/v3/repos/Langflow/e2e-qa");
});
