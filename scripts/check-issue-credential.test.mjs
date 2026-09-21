// Unit tests for scripts/check-issue-credential.mjs.
// Run with: npm run test:scripts
//
// What these protect: the two answers that must never be confused. "Refused" stops a
// run; "could not tell" must not, or a thirty-second network blip would cost the day's
// data. And the expiry warning has to arrive with enough days left to be acted on in a
// working week — a warning on the morning it dies is a post-mortem.
import { test } from "node:test";
import assert from "node:assert/strict";
import { verdict, parseExpiry, main, EXIT_USABLE, EXIT_REJECTED, EXIT_UNKNOWN } from "./check-issue-credential.mjs";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 21, 8, 0, 0);

test("GitHub's header is not ISO-8601, and is parsed anyway", () => {
  // The real header, copied from the destination: a space before the time and a
  // trailing ` UTC`. `Date.parse` on it directly is implementation-defined.
  assert.equal(parseExpiry("2026-12-19 22:56:58 UTC"), Date.UTC(2026, 11, 19, 22, 56, 58));
  assert.equal(parseExpiry(""), null);
  assert.equal(parseExpiry("not a date"), null);
});

test("a refused credential is its own answer, and it is the one worth stopping for", () => {
  for (const status of [401, 403]) {
    const r = verdict({ status, now: NOW, warnDays: 21 });
    assert.equal(r.code, EXIT_REJECTED);
    assert.match(r.headline, /a red morning would pass in silence/);
  }
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

test("no token at all is refused, without asking anyone", () => {
  const lines = [];
  const log = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  let called = false;
  const code = main({ ISSUE_HOST: "github.ibm.com", ISSUE_REPO: "x/y" }, async () => { called = true; });
  return code.then((c) => {
    console.log = log;
    assert.equal(c, EXIT_REJECTED);
    assert.equal(called, false, "it went to the network to learn what it already knew");
    assert.match(lines.join("\n"), /no GH_TOKEN/);
  });
});

test("end to end against a stubbed API: the header travels into the verdict", async () => {
  const lines = [];
  const log = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  // An hour of slack, because the header carries whole seconds and `daysLeft` floors:
  // a stamp built at exactly +5 days loses its milliseconds and reads as 4.
  const soon = new Date(Date.now() + 5 * DAY + 3_600_000).toISOString().replace("T", " ").slice(0, 19) + " UTC";
  const code = await main(
    { ISSUE_HOST: "github.ibm.com", ISSUE_REPO: "Langflow/e2e-qa", GH_TOKEN: "t" },
    async (url, init) => {
      assert.match(url, /^https:\/\/github\.ibm\.com\/api\/v3\/repos\/Langflow\/e2e-qa$/, "the enterprise API path is wrong");
      assert.match(init.headers.Authorization, /^Bearer /);
      return { status: 200, headers: new Headers({ "github-authentication-token-expiration": soon }) };
    },
  );
  console.log = log;
  assert.equal(code, EXIT_USABLE);
  assert.match(lines.join("\n"), /EXPIRING: the credential works but expires in 5 day\(s\)/);
});
