// Unit tests for the report-integrity guard (issue #1012).
// Run with: node --test scripts/check-run-integrity.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze, errorSignature, errorSignatures, testsTotal } from "./check-run-integrity.mjs";

// The real shape of the merged report from run 30351107916 (2026-07-28), where
// all four shards aborted in globalSetup: stats all zero, suites empty, and one
// top-level error per shard. Trimmed to the fields the guard reads.
const emptyRun = {
  config: {},
  suites: [],
  errors: [
    {
      message:
        "Error: [preflight] Langflow backend at http://localhost:7860/ is not reachable after 120000ms " +
        "(last: TimeoutError: apiRequestContext.get: Timeout 8000ms exceeded.\nCall log:\n" +
        "  - → GET http://localhost:7860/api/v1/version\n",
      stack: "...",
    },
    { message: "Error: [preflight] Langflow backend at http://localhost:7860/ is not reachable after 120000ms" },
    { message: "Error: [preflight] Langflow backend at http://localhost:7860/ is not reachable after 120000ms" },
    { message: "Error: [preflight] Langflow backend at http://localhost:7860/ is not reachable after 120000ms" },
  ],
  stats: {
    startTime: "2026-07-28T10:42:53.805Z",
    duration: 456176.048,
    expected: 0,
    skipped: 0,
    unexpected: 0,
    flaky: 0,
  },
};

const healthyRun = {
  suites: [{ file: "a.spec.ts", specs: [] }],
  errors: [],
  stats: { expected: 385, skipped: 9, unexpected: 8, flaky: 5, duration: 1086214 },
};

test("the 2026-07-28 zero-test run is detected as empty", () => {
  const r = analyze(emptyRun);
  assert.equal(r.empty, true);
  assert.equal(r.testsTotal, 0);
  assert.equal(r.reportErrors, 4);
  assert.equal(r.unreadable, false);
  assert.match(r.signatures[0], /^Error: \[preflight\] Langflow backend/);
});

test("a normal run is not empty and totals every status", () => {
  const r = analyze(healthyRun);
  assert.equal(r.empty, false);
  assert.equal(r.testsTotal, 385 + 9 + 8 + 5);
  assert.equal(r.reportErrors, 0);
  assert.deepEqual(r.signatures, []);
});

test("a missing or unparseable report counts as empty, never as green", () => {
  const r = analyze(null);
  assert.equal(r.empty, true);
  assert.equal(r.unreadable, true);
  assert.equal(r.testsTotal, 0);
  assert.deepEqual(r.signatures, []);
});

test("a run that only SKIPPED is not empty — that is coverage erosion, not an infra abort", () => {
  // The distinction matters: skipped specs were collected and evaluated, so the
  // shards did run. Silent-skip erosion is the #570 class, tracked separately —
  // this guard must not swallow it into the infra-abort bucket.
  const r = analyze({ suites: [], errors: [], stats: { expected: 0, unexpected: 0, flaky: 0, skipped: 42 } });
  assert.equal(r.empty, false);
  assert.equal(r.testsTotal, 42);
});

test("a report with errors but tests that still ran is not empty", () => {
  // A worker-level error can coexist with a run that produced results; only the
  // absence of results makes a run empty.
  const r = analyze({ stats: { expected: 10, unexpected: 1, flaky: 0, skipped: 0 }, errors: [{ message: "boom" }] });
  assert.equal(r.empty, false);
  assert.equal(r.reportErrors, 1);
  assert.deepEqual(r.signatures, ["boom"]);
});

test("testsTotal tolerates a missing or partial stats block", () => {
  assert.equal(testsTotal({}), 0);
  assert.equal(testsTotal({ stats: {} }), 0);
  assert.equal(testsTotal({ stats: { expected: 3 } }), 3);
});

test("errorSignature takes the first non-empty line, capped at 240 chars", () => {
  assert.equal(errorSignature({ message: "\n\n  real cause  \nstack frame\n" }), "real cause");
  assert.equal(errorSignature({ value: "from value" }), "from value");
  assert.equal(errorSignature({ message: "x".repeat(300) }).length, 240);
  assert.equal(errorSignature({}), null);
  assert.equal(errorSignature({ message: "\n \n" }), null);
});

test("errorSignatures drops entries that carry no message", () => {
  assert.deepEqual(errorSignatures({ errors: [{ message: "a" }, {}, { message: "b" }] }), ["a", "b"]);
  assert.deepEqual(errorSignatures({}), []);
});
