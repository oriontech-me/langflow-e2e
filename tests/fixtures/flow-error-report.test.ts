// Unit tests for the flow-error report accessor's verdict (issue #1452).
//
// What is worth pinning here is ONE rule and its edges: `clean` may only be true
// when a verdict was reached for every run stream and all of them were clean.
// Every other field is a rendering of that. The rule is the whole point of the
// accessor — a spec asserting `clean` must not be able to pass on a run the
// fixture never managed to read, which is the failure mode #1012 names and the
// one the four give-up paths in `fixtures.ts` produce silently.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import { buildFlowErrorReport } from "./flow-error-report";

const CLEAN = {
  failures: [],
  unevaluated: new Map<string, number>(),
  pending: 0,
  v2Watched: true,
};

test("a watched run with no verdicts is clean", () => {
  const report = buildFlowErrorReport(CLEAN);
  assert.equal(report.clean, true);
  assert.equal(report.unevaluatedTotal, 0);
  assert.match(report.summary, /none carried a flow error/);
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
  // Unreachable from the fixture (`openStreams()` is a `Map.size`) and pinned
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
  }
});

// Structural, and it pins an ABSENCE rather than a spelling: the accessor must
// not be reachable through the same `allow*` bypass as the gate. A hatch that
// also emptied the report would make `expect(report.clean).toBe(true)` pass on a
// test that had declared it tolerates failures — the exact shape of assertion
// that looks strongest and asserts least.
test("the accessor does not consult allowFlowErrors", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "fixtures.ts"),
    "utf8",
  );
  const start = source.indexOf("(page as any).flowErrorReport = async");
  assert.ok(start > 0, "the accessor is gone or was renamed — update this guard");
  const body = source.slice(start, source.indexOf("};", start));
  assert.ok(
    !body.includes("allowFlowErrors"),
    "the report is gated on a hatch — it must report what happened, not what the test tolerates",
  );
  assert.ok(
    body.includes("runStreamCapture.settle()"),
    "the accessor stopped settling closed streams — it would race the verdict it is asked for",
  );
  assert.ok(
    !body.includes("runStreamCapture.drain()"),
    "the accessor drains the capture — that judges streams still open on a partial body and steals the teardown's verdict",
  );
});
