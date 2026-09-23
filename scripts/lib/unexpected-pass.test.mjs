// Unit tests for the unexpected-pass predicate (#2009).
// Run with: node --test scripts/lib/unexpected-pass.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { UNEXPECTED_PASS_SIGNATURE, collectUnexpectedPasses, isUnexpectedPass } from "./unexpected-pass.mjs";

const r = (status) => ({ status });

test("an `unexpected` test whose last attempt passed is an unexpected pass", () => {
  assert.equal(isUnexpectedPass({ status: "unexpected", results: [r("passed"), r("passed")] }), true);
  assert.equal(isUnexpectedPass({ status: "unexpected", results: [r("timedOut"), r("passed")] }), true);
});

test("nothing else is — a hard failure, a green test, a flake, an empty result list", () => {
  assert.equal(isUnexpectedPass({ status: "unexpected", results: [r("passed"), r("failed")] }), false);
  assert.equal(isUnexpectedPass({ status: "unexpected", results: [] }), false);
  assert.equal(isUnexpectedPass({ status: "expected", results: [r("passed")] }), false);
  assert.equal(isUnexpectedPass({ status: "flaky", results: [r("failed"), r("passed")] }), false);
  assert.equal(isUnexpectedPass(undefined), false);
});

test("the signature is a fixed string — it is a recurrence key", () => {
  assert.equal(UNEXPECTED_PASS_SIGNATURE, "expected to fail but passed");
});

test("collection walks nested suites, inherits the suite file and survives junk", () => {
  const report = {
    suites: [
      {
        file: "a.spec.ts",
        suites: [
          {
            specs: [
              { title: "p", line: 3, tests: [{ status: "unexpected", results: [r("passed")] }] },
              { title: "f", line: 4, tests: [{ status: "unexpected", results: [r("failed")] }] },
              null,
            ],
          },
          "junk",
        ],
      },
    ],
  };
  assert.deepEqual(collectUnexpectedPasses(report), [
    { file: "a.spec.ts", line: 3, title: "p", attempts: 1, passedAttempts: 1 },
  ]);
  assert.deepEqual(collectUnexpectedPasses(null), []);
  assert.deepEqual(collectUnexpectedPasses({ suites: "x" }), []);
});
