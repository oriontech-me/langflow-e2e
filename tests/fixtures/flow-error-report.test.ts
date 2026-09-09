// Unit tests for the flow-error report accessor's verdict (issue #1452).
//
// What is worth pinning here is ONE rule and its edges: `clean` may only be true
// when a verdict was reached for every run stream and all of them were clean.
// Every other field is a rendering of that. The rule is the whole point of the
// accessor — a spec asserting `clean` must not be able to pass on a run the
// fixture never managed to read, which is the failure mode #1012 names and the
// one the give-up paths in `fixtures.ts` produce silently — SEVEN
// `countUnevaluated(...)` call sites at the time of writing, not the "four" an
// earlier version of this line claimed, which was a count of reason CATEGORIES
// and short even of those. Count the call sites rather than quoting a number.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import { buildFlowErrorReport } from "./flow-error-report";

const CLEAN = {
  failures: [],
  unevaluated: new Map<string, number>(),
  pending: 0,
  evaluated: 1,
  v2Watched: true,
};

test("a watched run with a verdict and no failure is clean", () => {
  const report = buildFlowErrorReport(CLEAN);
  assert.equal(report.clean, true);
  assert.equal(report.unevaluatedTotal, 0);
  assert.match(report.summary, /none carried a flow error/);
});

test("clean with NO run at all says so — the vacuous case (#1092's shape)", () => {
  // `clean` is deliberately still true: nothing failed. What would make a spec
  // adopting it as a gate useless is that this state is indistinguishable from a
  // healthy run — a send that never fired, or a run over an endpoint
  // `runStreamSurface()` does not classify. So the summary has to carry it, and
  // `evaluated` has to be readable.
  const report = buildFlowErrorReport({ ...CLEAN, evaluated: 0 });
  assert.equal(report.clean, true);
  assert.equal(report.evaluated, 0);
  assert.match(report.summary, /nothing ran either/);
  assert.match(report.summary, /evaluated > 0/);
});

test("evaluated is carried through and normalised", () => {
  assert.equal(buildFlowErrorReport({ ...CLEAN, evaluated: 3 }).evaluated, 3);
  assert.equal(buildFlowErrorReport({ ...CLEAN, evaluated: -2 }).evaluated, 0);
  assert.equal(buildFlowErrorReport({ ...CLEAN, evaluated: Number.NaN }).evaluated, 0);
});

test("a non-2xx run is unevaluated, not clean", () => {
  // The worst false-clean the review found: `POST /api/v2/workflows` answering
  // 500 produces no stream to capture, and an HTTP error never fails a test on
  // its own (#1084) — so the hardest possible crash used to read back as the
  // absence of one. The fixture funnels it in as an unevaluated reason.
  const report = buildFlowErrorReport({
    ...CLEAN,
    unevaluated: new Map([["run answered non-2xx (no stream to judge)", 1]]),
  });
  assert.equal(report.clean, false);
  assert.equal(report.failures.length, 0);
  assert.match(report.summary, /non-2xx/);
});

test("a reached flow-error verdict is not clean, and the summary names it", () => {
  const report = buildFlowErrorReport({
    ...CLEAN,
    failures: [
      { url: "http://x/api/v2/workflows", message: "Error code: 400 - boom" },
    ],
  });
  assert.equal(report.clean, false);
  assert.equal(report.failures.length, 1);
  assert.match(report.summary, /1 flow error\(s\)/);
  assert.match(report.summary, /boom/);
});

// The reason this accessor exists at all. Each of these is a path that today
// prints "unknown, not clean" and then leaves the test green.
for (const reason of [
  "read timed out",
  "stream cancelled before any data",
  "read failed (stream aborted?)",
  "provider outage (credit-exhausted)",
  "v2 capture unavailable (no CDP session)",
]) {
  test(`an unevaluated run (${reason}) is NOT clean`, () => {
    const report = buildFlowErrorReport({
      ...CLEAN,
      unevaluated: new Map([[reason, 1]]),
    });
    assert.equal(
      report.clean,
      false,
      "an unread run stream was reported as clean — unknown is not clean (#1012)",
    );
    assert.equal(report.unevaluatedTotal, 1);
    assert.match(report.summary, new RegExp(reason.replace(/[(){}?*+.[\]\\^$|]/g, "\\$&")));
  });
}

test("a provider outage is not clean even though it never fails the gate", () => {
  // The one downgrade that is deliberate (#1165): the fixture must NOT fail a
  // test because the account is dry, or `remove-stable-from-failures.ts` would
  // strip `@stable` for an outage. That decision is about the GATE. A spec
  // asking for the verdict must still be told the run says nothing about
  // Langflow — otherwise the accessor re-creates, for its own callers, the
  // false-clean the gate avoids by staying silent.
  const report = buildFlowErrorReport({
    ...CLEAN,
    unevaluated: new Map([["provider outage (credit-exhausted)", 2]]),
  });
  assert.equal(report.clean, false);
  assert.equal(report.failures.length, 0, "an outage must not be reported as a flow error");
  assert.match(report.summary, /2× provider outage/);
});

test("a run stream still open is pending — not failed, not unevaluated, not clean", () => {
  const report = buildFlowErrorReport({ ...CLEAN, pending: 1 });
  assert.equal(report.clean, false);
  assert.equal(report.pending, 1);
  assert.equal(report.failures.length, 0);
  assert.equal(report.unevaluatedTotal, 0);
  assert.match(report.summary, /still open/);
  assert.match(
    report.summary,
    /wait for the run to finish/,
    "a pending stream must tell the caller what to do — it is the one not-clean state that is nobody's defect",
  );
});

test("an unwatched v2 surface is not clean, however empty the counts are", () => {
  // The nastiest of the five: with no CDP session there is no stream to time out
  // and no body to fail on, so every count is zero and the run looks perfect.
  const report = buildFlowErrorReport({ ...CLEAN, v2Watched: false });
  assert.equal(
    report.clean,
    false,
    "an unwatched v2 surface was reported clean — that is every Playground and agent run on 1.12.x",
  );
  assert.match(report.summary, /NOT watched/);
});

test("counts add up across reasons, and the order is stable", () => {
  const report = buildFlowErrorReport({
    ...CLEAN,
    // Inserted in the order network events happen to arrive — which is not
    // stable between two runs of the same spec, so the report sorts.
    unevaluated: new Map([
      ["read timed out", 2],
      ["empty body", 1],
      ["provider outage (rate-limited)", 3],
    ]),
  });
  assert.equal(report.unevaluatedTotal, 6);
  assert.deepEqual(
    report.unevaluated.map((e) => e.reason),
    ["empty body", "provider outage (rate-limited)", "read timed out"],
  );
});

test("the report is a copy — the fixture keeps mutating its own accounting", () => {
  const unevaluated = new Map<string, number>();
  const failures = [{ url: "u", message: "m" }];
  const report = buildFlowErrorReport({ ...CLEAN, failures, unevaluated });

  unevaluated.set("read timed out", 1);
  failures.push({ url: "u2", message: "m2" });
  failures[0].message = "mutated";

  assert.equal(report.unevaluatedTotal, 0);
  assert.equal(report.failures.length, 1);
  assert.equal(
    report.failures[0].message,
    "m",
    "the report handed back a live reference — a verdict that changes after it is read is worse than none",
  );
});

test("a nonsensical pending count cannot buy a clean verdict", () => {
  // Unreachable from the fixture (`pendingStreams()` sums counters it owns) and pinned
  // anyway, because the obvious defensive move here — clamping to zero — points
  // the wrong way: it converts a count nobody can explain into a CLEAN verdict.
  // Caught reviewing this file's own first draft, where the clamp shipped with a
  // comment claiming it prevented exactly what it caused.
  for (const pending of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const report = buildFlowErrorReport({ ...CLEAN, pending });
    assert.equal(
      report.clean,
      false,
      `pending=${pending} produced a clean verdict — an uninterpretable count must not read as "no runs in flight"`,
    );
    assert.match(report.summary, /not a non-negative integer/);
    assert.equal(
      report.pending,
      0,
      "the FIELD is normalised to 0 — `clean` and `summary` are what carry the refusal, and the docs must not tell a caller to test `pending`",
    );
  }
});

// NOT pinned here, on purpose. An earlier draft grepped `fixtures.ts` for the
// accessor's body to assert it does not consult `allowFlowErrors`, calls
// `settle()` and does not call `drain()`. All three are already pinned
// BEHAVIOURALLY in `flow-error-gate.spec.ts` (each fails under the mutation it
// exists to catch — measured), and #1226 is the standing lesson that a guard
// pinning a spelling passes the mutations it was written for: moving the filter
// into a helper turns it green while the defect stands. It was also brittle in
// its own right — it sliced the body to the first `};`, which any object literal
// would have cut short.

// The ONE exception, and it is labelled the weaker thing it is. The residual
// `settle()` could not drain is folded into the unevaluated tally at teardown,
// and teardown output is the one region no test in this repo can observe — the
// same structural limit `flow-error-gate.spec.ts` records for its own v1
// interrupt and for the advisory block. Nothing behavioural can reach it, so
// this pins that the block is still there at all: it catches deletion, and
// #1226 says it will not catch a rewrite that keeps the spelling and loses the
// effect. Recorded rather than dressed up.
//
// Why it matters: `drain()` empties and judges `open`, but `settling` past the
// budget and `requests` whose headers never came survive it, and the session is
// detached immediately after — so they never settle. The capped `settle()` this
// PR introduced is what made that residual reachable; the unbounded `drain()` it
// replaced could not leave one. Dropping it in silence is #1012's rule broken by
// the change that enforces it everywhere else.
test("the teardown counts what the drain could not settle (#1012)", () => {
  const source = fs.readFileSync(path.join(__dirname, "fixtures.ts"), "utf-8");
  const drain = source.indexOf("runStreamCapture.drain()");
  const residual = source.indexOf("runStreamCapture.pendingStreams()", drain);
  assert.ok(drain > -1, "the teardown still drains the v2 capture");
  assert.ok(
    residual > -1,
    "the teardown reads the residual `pendingStreams()` after draining",
  );
  assert.match(
    source.slice(residual, residual + 400),
    /countUnevaluated\(/,
    "the residual is COUNTED as unevaluated, not merely read",
  );
});
