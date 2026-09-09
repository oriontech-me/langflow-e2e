// Unit tests for the inherited-backlog baseline writer (issue #1769, Task 3).
// Run with: npm run test:units
//
// The wave needs a fixed target and the ownership guard (a later task) needs a
// set of specs that are ALLOWED to be unowned -- both read the committed
// `tests/assets/triage/inherited-backlog-baseline.json`. Only the pure parts
// are covered here (`renderBaseline`, `diffBaseline`, `formatParseRefusal`):
// `main()`'s IO -- reading the real corpus, writing the file -- is exercised
// by actually running the script (see the task report for the write / --check
// / drift-detection transcript), the same split `update-component-catalog-
// baseline.test.ts` uses for its own writer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderBaseline, diffBaseline, formatParseRefusal } from "./update-inherited-backlog-baseline";
import type { Backlog } from "./lib/inherited-backlog";

function spec(relativePath: string, tier: "T1" | "T2" = "T2") {
  return {
    relativePath, tier, hasMirroredDoc: tier === "T1", hasIdScopedCleanup: false,
    tests: [{ title: "t", modifier: "", tags: ["@release"], line: 1 }],
  };
}
const backlog = (specs: ReturnType<typeof spec>[]): Backlog =>
  ({ specs, testCount: specs.length, titleCollisions: [] });

test("renderBaseline is deterministic and newline-terminated", () => {
  const a = renderBaseline(backlog([spec("b/y.spec.ts"), spec("a/x.spec.ts")]));
  const b = renderBaseline(backlog([spec("a/x.spec.ts"), spec("b/y.spec.ts")]));
  assert.equal(a, b);
  assert.ok(a.endsWith("\n"));
  assert.ok(a.indexOf('"a/x.spec.ts"') < a.indexOf('"b/y.spec.ts"'));
});

test("renderBaseline carries no timestamp", () => {
  // A generated-at field would make every regeneration a diff, which is how a
  // committed baseline stops being reviewable.
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(renderBaseline(backlog([spec("a/x.spec.ts")]))));
});

test("diffBaseline names added, removed and retiered specs", () => {
  const committed = JSON.parse(renderBaseline(backlog([spec("a/x.spec.ts"), spec("b/y.spec.ts")])));
  const d = diffBaseline(committed, backlog([spec("a/x.spec.ts", "T1"), spec("c/z.spec.ts")]));
  assert.deepEqual(d.added, ["c/z.spec.ts"]);
  assert.deepEqual(d.removed, ["b/y.spec.ts"]);
  assert.deepEqual(d.changed, ["a/x.spec.ts"]);
});

test("a missing committed baseline reports every spec as added", () => {
  const d = diffBaseline(null, backlog([spec("a/x.spec.ts")]));
  assert.deepEqual(d.added, ["a/x.spec.ts"]);
  assert.deepEqual(d.removed, []);
});

// ─── Ruling P8 -- collectBacklog()'s parse-warning throw must not escape main()
// as a raw stack trace. `collectBacklog()` intentionally takes no injectable
// dependency (Task 2), and there are zero parse warnings in the corpus today,
// so `main()`'s try/catch around it is exercised here via the pure formatter
// it delegates to rather than by forcing a real warning through the AST walk
// -- the same choice Task 2 made for `assertNoWarnings` itself.

test("formatParseRefusal names the failure in the floor's own voice", () => {
  const msg = formatParseRefusal(new Error("collectBacklog(): collectTaggedTests() reported 1 parse warning(s) (printed above)."));
  assert.equal(
    msg,
    "[triage-baseline] refusing: the AST parser could not fully read the corpus — " +
      "collectBacklog(): collectTaggedTests() reported 1 parse warning(s) (printed above).",
  );
});

test("formatParseRefusal handles a non-Error throw", () => {
  assert.equal(
    formatParseRefusal("boom"),
    "[triage-baseline] refusing: the AST parser could not fully read the corpus — boom",
  );
});
