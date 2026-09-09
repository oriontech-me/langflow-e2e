// Unit tests for the inherited-spec backlog predicate (issue #1769).
// Run with: npm run test:units
//
// `classifyBacklog` is the ONE place three later consumers (a committed
// baseline, a `--grep` selector, an ownership guard -- see the plan's Tasks
// 3-6) read "which tests have never carried @stable". It is pure and takes
// its facts as an injected function specifically so this file never has to
// touch the filesystem to test the four clauses; `collectBacklog()` is the
// thin IO shell wired to the real AST walk, covered separately at the bottom.
//
// Design: `docs/triage/inherited-spec-triage-design.md` §1.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertNoWarnings,
  classifyBacklog,
  collectBacklog,
  LANE_SELECTORS,
} from "./inherited-backlog";
import type { TaggedTest } from "./stable-tests";

function t(
  relativePath: string,
  title: string,
  tags: string[],
  line = 1,
  modifier = "",
): TaggedTest {
  const parts = relativePath.split("/");
  return {
    title, tags, modifier, line, relativePath,
    specFile: parts[parts.length - 1],
    modulePath: parts.slice(0, -1).join("/") || ".",
  };
}
const NO_FACTS = () => ({ hasMirroredDoc: false, hasIdScopedCleanup: false });

test("an unstable test in a file with no @stable test is in scope", () => {
  const b = classifyBacklog([t("a/x.spec.ts", "one", ["@release"])], NO_FACTS);
  assert.equal(b.specs.length, 1);
  assert.equal(b.testCount, 1);
  assert.equal(b.specs[0].tier, "T2");
});

test("every lane selector excludes its test", () => {
  for (const lane of LANE_SELECTORS) {
    const b = classifyBacklog([t("a/x.spec.ts", "one", ["@release", lane])], NO_FACTS);
    assert.equal(b.specs.length, 0, `${lane} should be out of scope`);
  }
});

// Clause 4. A file with a mix lost the tag per test and belongs to #1746.
test("a file holding any @stable test is excluded entirely", () => {
  const b = classifyBacklog([
    t("a/x.spec.ts", "kept", ["@stable", "@release"]),
    t("a/x.spec.ts", "lost", ["@release"]),
  ], NO_FACTS);
  assert.equal(b.specs.length, 0);
});

// Ruling P7 (Task 2 review). The naive reading of clauses 2 and 4 is
// `tags.includes(STABLE_TAG)`, full stop. But `parseStableTests`
// (./stable-tests.ts -- the function the QA-CHECKLIST generator and the
// checklist guard both read) additionally requires `modifier === ""`, so a
// `test.fixme(..., { tag: ["@stable"] })` is NOT `@stable` to this repo: it
// runs in no lane whatever its tags claim. Using the looser check here would
// give the suite's single most load-bearing tag a second, looser definition
// inside the one module whose entire justification is that there is only
// one. So a quarantined declaration must stay IN the backlog -- clause 4 must
// not read it as the file's stable test, and clause 2 must not read it as
// already-validated. A single-test file makes both halves load-bearing at
// once: getting either clause wrong empties the file (specs.length would
// read 0 instead of 1).
test("a test.fixme carrying @stable does not exempt its file, and is itself in scope", () => {
  const b = classifyBacklog(
    [t("a/x.spec.ts", "quarantined", ["@stable", "@release"], 1, "fixme")],
    NO_FACTS,
  );
  assert.equal(b.specs.length, 1);
  assert.equal(b.testCount, 1);
  assert.deepEqual(b.specs[0].tests.map((x) => x.title), ["quarantined"]);
  assert.equal(b.specs[0].tests[0].modifier, "fixme");
});

// The complementary case: a REAL @stable test (modifier "") in the same file
// as a fixme'd one that merely claims the tag. Clause 4 must still fire on
// the real one -- the P7 fix narrows what counts as stable, it must not stop
// clause 4 from working at all.
test("a file with one real @stable test is excluded even when a fixme'd test also claims @stable", () => {
  const b = classifyBacklog([
    t("a/x.spec.ts", "kept", ["@stable"]),
    t("a/x.spec.ts", "quarantined but tagged stable", ["@stable"], 2, "fixme"),
    t("a/x.spec.ts", "plain backlog test", ["@release"], 3),
  ], NO_FACTS);
  assert.equal(b.specs.length, 0);
});

test("tier is T1 when the spec has a doc or id-scoped cleanup", () => {
  const facts = (rel: string) => rel === "a/doc.spec.ts"
    ? { hasMirroredDoc: true, hasIdScopedCleanup: false }
    : { hasMirroredDoc: false, hasIdScopedCleanup: true };
  const b = classifyBacklog([
    t("a/doc.spec.ts", "one", ["@release"]),
    t("a/clean.spec.ts", "two", ["@release"]),
  ], facts);
  assert.deepEqual(b.specs.map((s) => s.tier), ["T1", "T1"]);
});

test("a title shared with an out-of-scope test is reported as a collision", () => {
  const b = classifyBacklog([
    t("a/x.spec.ts", "same name", ["@release"]),
    t("b/y.spec.ts", "same name", ["@stable"]),
  ], NO_FACTS);
  assert.deepEqual(b.titleCollisions, ["same name"]);
});

// Finding A3. Only the in-scope <-> OUT-of-scope class was recorded, while
// `build-triage-grep.mjs`'s docstring claimed a recorded collision meant "two
// different tests in the underlying suite share the exact same title text".
// Two IN-scope tests sharing a title were therefore invisible to the refusal
// and silent in three further places: `baselineTitles` dedupes them into one
// alternative, `rowsFor` renders two identical rows, and `verdictFor` folds
// both tests' observations into ONE verdict -- a green one able to mask a red.
// Zero such collisions in the corpus today, which is exactly why this is
// pinned by a fixture instead of by the suite.
test("two IN-SCOPE tests sharing a title are reported as a collision too", () => {
  const b = classifyBacklog([
    t("a/x.spec.ts", "same name", ["@release"]),
    t("b/y.spec.ts", "same name", ["@release"]),
  ], NO_FACTS);
  assert.deepEqual(b.titleCollisions, ["same name"]);
  // Both are genuinely in the population -- this is not the out-of-scope case
  // wearing a different hat, and the two rows would be indistinguishable.
  assert.equal(b.testCount, 2);
  assert.deepEqual(b.specs.map((s) => s.relativePath), ["a/x.spec.ts", "b/y.spec.ts"]);
});

test("two in-scope tests sharing a title INSIDE one file are reported as a collision", () => {
  const b = classifyBacklog([
    t("a/x.spec.ts", "same name", ["@release"], 10),
    t("a/x.spec.ts", "same name", ["@release"], 40),
  ], NO_FACTS);
  assert.deepEqual(b.titleCollisions, ["same name"]);
  assert.equal(b.testCount, 2);
});

test("distinct titles are not collisions, and a title is reported at most once", () => {
  const clean = classifyBacklog([
    t("a/x.spec.ts", "one", ["@release"]),
    t("b/y.spec.ts", "two", ["@release"]),
  ], NO_FACTS);
  assert.deepEqual(clean.titleCollisions, []);

  // Three declarations on one title (two in scope, one out) must yield ONE
  // entry, not three -- the refusal prints the list and a triplicated name
  // would misreport how many titles need resolving.
  const dup = classifyBacklog([
    t("a/x.spec.ts", "same name", ["@release"]),
    t("b/y.spec.ts", "same name", ["@release"]),
    t("c/z.spec.ts", "same name", ["@stable"]),
  ], NO_FACTS);
  assert.deepEqual(dup.titleCollisions, ["same name"]);
});

test("specs are sorted and tests keep source order", () => {
  const b = classifyBacklog([
    t("z/last.spec.ts", "z", ["@release"]),
    t("a/first.spec.ts", "second", ["@release"], 20),
    t("a/first.spec.ts", "first", ["@release"], 10),
  ], NO_FACTS);
  assert.deepEqual(b.specs.map((s) => s.relativePath), ["a/first.spec.ts", "z/last.spec.ts"]);
  assert.deepEqual(b.specs[0].tests.map((x) => x.title), ["first", "second"]);
});

test("an empty suite yields an empty backlog rather than throwing", () => {
  const b = classifyBacklog([], NO_FACTS);
  assert.deepEqual(b, { specs: [], testCount: 0, titleCollisions: [] });
});

// ─── assertNoWarnings -- collectBacklog()'s IO-shell warning guard ──────────
//
// `parseTaggedTests` (./stable-tests.ts, the single AST walker
// `collectTaggedTests()` forwards) emits "unparseable tag" warnings that
// `collectTaggedTests()` surfaces to every caller, including `collectBacklog()`
// here. Zero occurrences in the corpus today, but a silent drop is exactly the
// #1012 failure mode: a future declaration that trips a warning must not
// quietly vanish into a smaller-than-real backlog. Tested as its own unit
// rather than by forcing a real parse warning, because `collectBacklog()`
// intentionally takes no injectable dependency (it must match the produced
// `(): Backlog` interface Tasks 3-6 consume).

test("assertNoWarnings is a no-op when there is nothing to report", () => {
  assert.doesNotThrow(() => assertNoWarnings([]));
});

test("assertNoWarnings throws rather than letting a parse warning pass silently", () => {
  assert.throws(
    () => assertNoWarnings(["some.spec.ts:1 — tag option is not an inline array"]),
    /1 parse warning/,
  );
});

// ─── Invariant over the real suite ───────────────────────────────────────────

test("collectBacklog() walks the real suite (via collectTaggedTests()) and returns a well-shaped, non-empty backlog", () => {
  // Not a fixture: `collectTaggedTests()` itself shipped with no direct unit
  // test (Task 1 review), and this is the only production call site. Counts
  // are volatile by design -- the suite moves -- so only shape and
  // non-emptiness are asserted here; the exact figures are sanity-checked
  // manually against the design's own measurement (Task 2 brief, Step 4).
  const b = collectBacklog();
  assert.ok(b.specs.length > 0, "no backlog specs found under regression/");
  assert.ok(b.testCount > 0, "no backlog tests found under regression/");
  assert.equal(
    b.testCount,
    b.specs.reduce((n, s) => n + s.tests.length, 0),
    "testCount must equal the sum of each spec's tests",
  );
  for (const spec of b.specs) {
    assert.ok(
      spec.tier === "T1" || spec.tier === "T2",
      `${spec.relativePath} has an invalid tier: ${spec.tier}`,
    );
    assert.ok(spec.tests.length > 0, `${spec.relativePath} has zero tests`);
  }
});
