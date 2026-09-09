import { test } from "node:test";
import assert from "node:assert/strict";
import { escapeTitle, baselineTitles, shardTitles, buildFragment, checkTitleCollisions } from "./build-triage-grep.mjs";

const baseline = {
  version: 1,
  titleCollisions: [],
  specs: [
    { relativePath: "a/x.spec.ts", tests: [{ title: "beta" }, { title: "alpha" }] },
    { relativePath: "b/y.spec.ts", tests: [{ title: "gamma (v2)" }] },
  ],
};

test("escapeTitle neutralises regex metacharacters", () => {
  const f = buildFragment([escapeTitle("gamma (v2)")]);
  assert.ok(new RegExp(f).test("suite > gamma (v2)"));
  assert.ok(!new RegExp(f).test("gamma v2"));
});

test("baselineTitles is sorted and deduped", () => {
  assert.deepEqual(baselineTitles(baseline), ["alpha", "beta", "gamma (v2)"]);
});

test("shards partition the titles exactly once each", () => {
  const titles = baselineTitles(baseline);
  const seen = [1, 2, 3].flatMap((i) => shardTitles(titles, 3, i));
  assert.deepEqual(seen.slice().sort(), titles.slice().sort());
  assert.equal(new Set(seen).size, titles.length);
});

test("buildFragment wraps in a non-capturing group", () => {
  // `(...)` would renumber a backreference a caller wrote in its own fragment,
  // and a bare alternation would not be ANDed as a unit by build-grep-filter.
  assert.match(buildFragment(["a", "b"]), /^\(\?:a\|b\)$/);
});

test("a fragment matches only its own titles", () => {
  const re = new RegExp(buildFragment(shardTitles(baselineTitles(baseline), 3, 1).map(escapeTitle)));
  assert.ok(re.test("alpha"));
  assert.ok(!re.test("something else"));
});

test("shardTitles rejects an out-of-range shard", () => {
  assert.throws(() => shardTitles(["a", "b"], 2, 3), /shard/i);
  assert.throws(() => shardTitles(["a", "b"], 2, 0), /shard/i);
});

test("an empty shard is refused rather than emitted", () => {
  // An empty fragment compiles to a regex matching every test, turning a
  // narrowed dispatch into a full-suite run.
  assert.throws(() => buildFragment([]), /empty/i);
});

// The tests above are the brief's; none of them would fail if `escapeTitle` only
// escaped metacharacters and did not anchor. Running the real baseline's fragments
// through `npx playwright test --list --grep` (Task 4 Step 4) found that the naive
// version overselects: the three shards summed to 106 matches against this suite
// instead of the baseline's 92. The extra 14 all trace back to ONE baseline title,
// the standalone word "save" (from `flowPage.spec.ts`), colliding with Playwright's
// real grep target -- `TestCase._grepTitleWithTags()` space-joins the file's
// relative path, every enclosing `describe` title, the test's own title, and its
// tags -- in two different ways. These three tests pin both collisions against
// realistic joined strings (derived from the actual repo) plus the true positive,
// so a future change to the anchoring can't silently regress back to 106.
test("escapeTitle does not match a title that is merely a substring of an unrelated file path", () => {
  const f = buildFragment([escapeTitle("save")]);
  // Real case: save-flow-as-template.spec.ts's third test title never says "save",
  // but the naive pattern matched anyway because the file path (joined ahead of the
  // title) contains "save" as a kebab-case prefix.
  assert.ok(
    !new RegExp(f).test(
      "core-functionality/templates/save-flow-as-template.spec.ts Flow can be exported and re-imported as a template JSON @release @workspace @regression @templates",
    ),
  );
});

test("escapeTitle does not match a title that only occurs in an unrelated describe block", () => {
  const f = buildFragment([escapeTitle("save")]);
  // Real case: describe("save component tests", ...) in saveComponents.spec.ts wraps
  // a differently-titled, already-@stable test. Whitespace-only anchoring is not
  // enough here -- "save" IS a standalone, space-bounded word in the describe title
  // -- so this pins the trailing tag-tail requirement specifically.
  assert.ok(
    !new RegExp(f).test(
      "core-components/saveComponents.spec.ts save component tests saving a canvas component as a template makes it reusable from the sidebar @stable @regression @components @ui-ux",
    ),
  );
});

test("escapeTitle still matches the real test whose own title is exactly the short word", () => {
  const f = buildFragment([escapeTitle("save")]);
  // The legitimate target: flowPage.spec.ts's own (untitled-describe) test really is
  // titled just "save", followed only by its own tags.
  assert.ok(new RegExp(f).test("core-functionality/project-management/flowPage.spec.ts save @release"));
});

// checkTitleCollisions is the third mandated refusal (alongside shardTitles' rejection
// of an out-of-range shard and buildFragment's rejection of an empty fragment). It used
// to be inlined in main(), which is CLI-only -- reachable only via `node scripts/...`,
// never via `node --test` -- so this behavior had nothing pinning it. Extracted into its
// own pure function so main() has a single copy of the check to call, and so it can be
// tested directly like the other two.
test("checkTitleCollisions refuses when the baseline records a title collision, naming the reason and the titles", () => {
  assert.throws(
    () =>
      checkTitleCollisions(
        { titleCollisions: ["save", "load"] },
        "tests/assets/triage/inherited-backlog-baseline.json",
      ),
    (err) =>
      /2 title collision\(s\)/.test(err.message) &&
      err.message.includes("tests/assets/triage/inherited-backlog-baseline.json") &&
      err.message.includes("save") &&
      err.message.includes("load"),
  );
});

test("checkTitleCollisions does not refuse -- and returns the empty list -- when there are none", () => {
  assert.deepEqual(checkTitleCollisions({ titleCollisions: [] }), []);
  assert.deepEqual(checkTitleCollisions({}), []); // no field at all: same `?? []` guard main() used to inline
});
