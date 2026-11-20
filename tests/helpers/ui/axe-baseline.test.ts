// Unit tests for the accessibility baseline verdict (#2304).
// Run with: npm run test:units
//
// The verdict is two-sided (#1084): an undeclared violation fails, and so does a
// declared one that stopped firing. Both halves are asserted, because a verdict
// that only checks one of them passes every test written for the other.
import { test } from "node:test";
import assert from "node:assert/strict";
import { baselineMessage, baselineVerdict, type FoundViolation, WCAG_TAGS } from "./axe-baseline";

const contrast: FoundViolation = { rule: "color-contrast", impact: "serious", targets: ["#a", "#b"] };
const label: FoundViolation = { rule: "label", impact: "critical", targets: ["input"] };

test("a clean scan against an empty baseline has nothing to report", () => {
  assert.deepEqual(baselineVerdict([], []), { unexpected: [], stale: [] });
});

test("an undeclared violation is unexpected", () => {
  const v = baselineVerdict([contrast], []);
  assert.deepEqual(v.unexpected, [contrast]);
  assert.deepEqual(v.stale, []);
});

test("a declared violation that fires is neither unexpected nor stale", () => {
  assert.deepEqual(baselineVerdict([contrast], [{ rule: "color-contrast", reason: "r" }]), {
    unexpected: [],
    stale: [],
  });
});

test("a declared violation that no longer fires is stale", () => {
  const known = [{ rule: "color-contrast", reason: "tracked upstream" }];
  const v = baselineVerdict([], known);
  assert.deepEqual(v.unexpected, []);
  assert.deepEqual(v.stale, known);
});

test("declaring one rule does not hide another", () => {
  const v = baselineVerdict([contrast, label], [{ rule: "color-contrast", reason: "r" }]);
  assert.deepEqual(v.unexpected, [label]);
});

test("the message names the surface, the rule and the nodes, and tells what to do with a stale entry", () => {
  const msg = baselineMessage("Add dialog", {
    unexpected: [label],
    stale: [{ rule: "color-contrast", reason: "tracked upstream" }],
  });
  assert.match(msg, /Add dialog: undeclared violation label \(critical\) on 1 node\(s\): input/);
  assert.match(msg, /Add dialog: declared violation color-contrast no longer fires — delete it/);
  assert.match(msg, /tracked upstream/);
});

test("the rule set is WCAG A and AA only, without best-practice", () => {
  assert.deepEqual([...WCAG_TAGS], ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]);
  assert.ok(!WCAG_TAGS.some((t) => t.includes("best-practice")));
});
