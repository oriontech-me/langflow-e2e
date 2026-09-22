// Unit tests for scripts/check-issue-credential.mjs.
// Run with: npm run test:scripts
//
// What these protect: the two answers that must never be confused. "Refused" stops a
// run; "could not tell" must not, or a thirty-second network blip would cost the day's
// data. And the expiry warning has to arrive with enough days left to be acted on in a
// working week — a warning on the morning it dies is a post-mortem.
import { test } from "node:test";
import assert from "node:assert/strict";
import { verdict, parseExpiry, main, EXIT_USABLE, EXIT_UNKNOWN, EXIT_REFUSED } from "./check-issue-credential.mjs";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 21, 8, 0, 0);

test("GitHub's header is not ISO-8601, and is parsed anyway", () => {
  // The real header, copied from the destination: a space before the time and a
  // trailing ` UTC`. `Date.parse` on it directly is implementation-defined.
  assert.equal(parseExpiry("2026-12-19 22:56:58 UTC"), Date.UTC(2026, 11, 19, 22, 56, 58));
  assert.equal(parseExpiry(""), null);
  assert.equal(parseExpiry("not a date"), null);
});

test("refusal is its own answer, and 404 is the likeliest shape of it", () => {
  // GitHub answers 404, not 403, for a repository a credential cannot see — which is
  // what a token that lost access looks like from outside. Left in UNKNOWN it would
  // only warn, and the umbrella would go missing anyway.
  for (const status of [401, 403, 404]) {
    const r = verdict({ status, now: NOW, warnDays: 21 });
    assert.equal(r.code, EXIT_REFUSED, `HTTP ${status} was not treated as a refusal`);
    assert.match(r.headline, /a red morning would pass in silence/);
  }
});

test("refusal does not share an exit code with node crashing", () => {
  // The caller kills the run on refusal. Node exits 1 on a syntax error, a missing
  // import or an unhandled rejection — a broken script must not abort the daily with
  // a message blaming the token.
  assert.notEqual(EXIT_REFUSED, 1);
  assert.notEqual(EXIT_UNKNOWN, 1);
});

test("a credential that already lapsed is refused, not 'works but expires in -3 days'", () => {
  const r = verdict({ status: 200, expiresAt: NOW - 3 * DAY, now: NOW, warnDays: 21 });
  assert.equal(r.code, EXIT_REFUSED);
  assert.match(r.headline, /expired 3 day\(s\) ago/);
});

test("no answer at all is UNKNOWN, never refused", () => {
  // The distinction that keeps a blip from costing a day: the server did not say no,
  // it said nothing.
  const r = verdict({ status: null, now: NOW, warnDays: 21 });
  assert.equal(r.code, EXIT_UNKNOWN);
  assert.match(r.headline, /not the same as refused/);
  assert.equal(verdict({ status: 500, now: NOW, warnDays: 21 }).code, EXIT_UNKNOWN);
});

test("a healthy credential reports how long it has left", () => {
  const r = verdict({ status: 200, expiresAt: NOW + 89 * DAY, now: NOW, warnDays: 21 });
  assert.equal(r.code, EXIT_USABLE);
  assert.equal(r.expiring, undefined);
  assert.match(r.headline, /expires in 89 day\(s\)/);
});

test("the warning arrives with days to spare, and says what the failure looks like", () => {
  const r = verdict({ status: 200, expiresAt: NOW + 14 * DAY, now: NOW, warnDays: 21 });
  assert.equal(r.code, EXIT_USABLE, "an expiring credential still works today");
  assert.equal(r.expiring, true);
  assert.match(r.headline, /expires in 14 day\(s\)/);
  // The sentence has to carry WHY it matters, or it reads as bookkeeping.
  assert.match(r.headline, /the umbrella simply does not appear/);
});

test("a token with no expiry is reported as that, not as unknown", () => {
  // It is a real configuration, and calling it "unknown" would train the reader to
  // skip the line that matters.
  const r = verdict({ status: 200, expiresAt: null, now: NOW, warnDays: 21 });
  assert.equal(r.code, EXIT_USABLE);
  assert.match(r.headline, /carries no expiry date/);
});

test("no token is UNKNOWN, because the creator can still fall back to `gh`", () => {
  const lines = [];
  const log = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  let called = false;
  const code = main({ ISSUE_HOST: "github.ibm.com", ISSUE_REPO: "x/y" }, async () => { called = true; });
  return code.then((c) => {
    console.log = log;
    // Refusing here would abort a lane that can still open the issue: the creator
    // documents and implements a `gh` fallback for exactly this machine.
    assert.equal(c, EXIT_UNKNOWN);
    assert.equal(called, false, "it went to the network to learn what it already knew");
    assert.match(lines.join("\n"), /fall back to the `gh` CLI/);
  });
});

test("end to end against a stubbed API: the header travels into the verdict", async () => {
  const lines = [];
  const log = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  // An hour of slack, because the header carries whole seconds and `daysLeft` floors:
  // a stamp built at exactly +5 days loses its milliseconds and reads as 4.
  const soon = new Date(Date.now() + 5 * DAY + 3_600_000).toISOString().replace("T", " ").slice(0, 19) + " UTC";
  const seen = {};
  const code = await main(
    { ISSUE_HOST: "github.ibm.com", ISSUE_REPO: "Langflow/e2e-qa", GH_TOKEN: "t" },
    // Recorded, NOT asserted in here: a throw inside the stub is swallowed by main's
    // own catch and comes back as "no answer", so the message naming the broken
    // enterprise URL would never reach the reader.
    async (url, init) => {
      seen.url = url;
      seen.auth = init.headers.Authorization;
      return { status: 200, headers: new Headers({ "github-authentication-token-expiration": soon }) };
    },
  );
  console.log = log;
  assert.equal(code, EXIT_USABLE);
  assert.match(seen.url, /^https:\/\/github\.ibm\.com\/api\/v3\/repos\/Langflow\/e2e-qa$/, "the enterprise API path is wrong");
  assert.match(seen.auth, /^Bearer /);
  assert.match(lines.join("\n"), /EXPIRING: the credential works but expires in 5 day\(s\)/);
});

test("the precedence matches the script that actually opens the issue", async () => {
  // `create-failure-issue.mjs` reads GITHUB_TOKEN || GH_TOKEN. Inverted here, this
  // would validate a credential the creator never uses and pass while the real one is
  // dead — the silent failure it exists to close, wearing its own uniform.
  let sent = null;
  const log = console.log;
  console.log = () => {};
  await main({ ISSUE_HOST: "github.ibm.com", ISSUE_REPO: "x/y", GITHUB_TOKEN: "the-real-one", GH_TOKEN: "the-other-one" },
    async (_url, init) => { sent = init.headers.Authorization; return { status: 200, headers: new Headers() }; });
  console.log = log;
  assert.equal(sent, "Bearer the-real-one");
});
