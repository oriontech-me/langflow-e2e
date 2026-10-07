// Unit tests for the unexpected-pass predicate (#2009).
// Run with: node --test scripts/lib/unexpected-pass.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PARTIAL_UNEXPECTED_PASS_SIGNATURE,
  UNEXPECTED_PASS_SIGNATURE,
  collectPartialUnexpectedPasses,
  collectUnexpectedPasses,
  isPartialUnexpectedPass,
  isPartialUnexpectedPassEntry,
  isUnexpectedPass,
  isUnexpectedPassEntry,
} from "./unexpected-pass.mjs";

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

test("#2027 a history row is an unexpected pass only by the appender's own signature", () => {
  assert.equal(isUnexpectedPassEntry({ error_signature: UNEXPECTED_PASS_SIGNATURE }), true);
  assert.equal(isUnexpectedPassEntry({ error_signature: ` ${UNEXPECTED_PASS_SIGNATURE}\n` }), true);
  // A pre-#2009 row said "unknown" for the same case and cannot be told from a lost error.
  assert.equal(isUnexpectedPassEntry({ error_signature: "unknown" }), false);
  assert.equal(isUnexpectedPassEntry({ error_signature: "Error: expected to fail but passed, then failed" }), false);
  assert.equal(isUnexpectedPassEntry({}), false);
  assert.equal(isUnexpectedPassEntry(null), false);
});

// --- #2217: partial unexpected pass ---

const declared = (status, results) => ({ status, expectedStatus: "failed", results: results.map(r) });

test("#2217 a declared-failing flake with a passing attempt is a partial unexpected pass", () => {
  // The measured shape: VM dailies 2026-09-18 and 2026-10-07.
  assert.equal(isPartialUnexpectedPass(declared("flaky", ["passed", "failed"])), true);
  assert.equal(isPartialUnexpectedPass(declared("flaky", ["passed", "timedOut", "failed"])), true);
});

test("#2217 nothing else is: a declared timeout flake, a plain flake, a full pass", () => {
  assert.equal(isPartialUnexpectedPass(declared("flaky", ["timedOut", "failed"])), false, "no attempt passed");
  assert.equal(isPartialUnexpectedPass({ status: "flaky", results: [r("failed"), r("passed")] }), false, "not declared");
  assert.equal(isPartialUnexpectedPass(declared("unexpected", ["passed", "passed"])), false, "that is a full pass");
  assert.equal(isPartialUnexpectedPass(declared("expected", ["failed"])), false);
  assert.equal(isPartialUnexpectedPass(undefined), false);
  assert.equal(isUnexpectedPass(declared("flaky", ["passed", "failed"])), false, "the two predicates never overlap");
});

test("#2217 the partial signature is fixed and distinct from the full one", () => {
  assert.equal(PARTIAL_UNEXPECTED_PASS_SIGNATURE, "expected to fail but passed on some attempts");
  assert.equal(isPartialUnexpectedPassEntry({ error_signature: PARTIAL_UNEXPECTED_PASS_SIGNATURE }), true);
  assert.equal(isPartialUnexpectedPassEntry({ error_signature: UNEXPECTED_PASS_SIGNATURE }), false);
  assert.equal(isUnexpectedPassEntry({ error_signature: PARTIAL_UNEXPECTED_PASS_SIGNATURE }), false);
  assert.equal(isPartialUnexpectedPassEntry({ error_signature: "Error: a completed job must report" }), false, "a pre-#2217 row");
});

test("#2217 each collector returns only its own kind", () => {
  const report = {
    suites: [
      {
        file: "a.spec.ts",
        specs: [
          { title: "full", line: 3, tests: [declared("unexpected", ["passed", "passed"])] },
          { title: "partial", line: 4, tests: [declared("flaky", ["passed", "failed"])] },
        ],
      },
    ],
  };
  assert.deepEqual(collectUnexpectedPasses(report).map((p) => p.title), ["full"]);
  assert.deepEqual(collectPartialUnexpectedPasses(report), [
    { file: "a.spec.ts", line: 4, title: "partial", attempts: 2, passedAttempts: 1 },
  ]);
  assert.deepEqual(collectPartialUnexpectedPasses({ suites: "junk" }), []);
});
