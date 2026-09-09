import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  escapeTitle, baselineTitles, shardTitles, buildFragment, checkTitleCollisions,
  pairKey, listedPairs, baselinePairs, verifySelection, verifyReportLines, VERIFY_NAME_CAP,
} from "./build-triage-grep.mjs";
import { makeTempDir } from "./lib/tmp-dir.mjs";

const SCRIPT = fileURLToPath(new URL("./build-triage-grep.mjs", import.meta.url));

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

// Finding A3, the consumer side. The refusal was only ever fed the in-scope <->
// OUT-of-scope collision class; two IN-scope tests sharing a title now reach it
// too (`classifyBacklog`, scripts/lib/inherited-backlog.ts). This asserts what
// that class costs if it slips past: `baselineTitles` dedupes the two into ONE
// alternative, so the fragment silently selects both tests under one title and
// the table renders two indistinguishable rows.
test("a title held by two in-scope tests collapses to one alternative -- which is why it must refuse", () => {
  const colliding = {
    version: 1,
    titleCollisions: ["same name"],
    specs: [
      { relativePath: "a/x.spec.ts", tests: [{ title: "same name" }] },
      { relativePath: "b/y.spec.ts", tests: [{ title: "same name" }] },
    ],
  };
  // Two tests, one alternative: the fragment cannot address them separately.
  assert.deepEqual(baselineTitles(colliding), ["same name"]);
  assert.throws(
    () => checkTitleCollisions(colliding, "baseline.json"),
    /1 title collision\(s\)/,
    "an in-scope collision must be refused, not silently deduped",
  );
});

// ─── --verify: set-exactness, which is the check ruling P14 actually made ────
//
// Both committed verification steps asked only that "the three counts sum to 92
// with no shard at 0". P14's own words are that "92 can be reached by dropping
// some and adding others" — so the controller verified SET-exactness by hand,
// twice, while the runbook kept prescribing the weaker check. This mode is that
// verification as one command.
//
// The comparison keys on `spec::title` PAIRS, not titles: a title selected in
// the WRONG FILE is one extra plus one missing here, and a match under a
// title-only comparison.

const vBaseline = {
  version: 1,
  titleCollisions: [],
  specs: [
    { relativePath: "a/x.spec.ts", tests: [{ title: "alpha" }, { title: "beta" }] },
    { relativePath: "b/y.spec.ts", tests: [{ title: "gamma" }] },
  ],
};

/** A `--list --reporter=json` report, in the real shape (rootDir is `tests/`). */
const listReport = (pairs, { nest = false } = {}) => ({
  suites: pairs.map(([spec, title]) => (nest
    ? {
        title: spec, file: `tests-automations/regression/${spec}`, specs: [],
        suites: [{ title: "outer", specs: [], suites: [{ title: "inner", specs: [{ file: `tests-automations/regression/${spec}`, title }], suites: [] }] }],
      }
    : {
        title: spec, file: `tests-automations/regression/${spec}`,
        specs: [{ file: `tests-automations/regression/${spec}`, title }], suites: [],
      })),
});

test("listedPairs strips Playwright's rootDir prefix so the keys match the baseline's", () => {
  const pairs = listedPairs(listReport([["a/x.spec.ts", "alpha"]]));
  assert.deepEqual([...pairs], [pairKey("a/x.spec.ts", "alpha")]);
});

test("listedPairs descends through nested describe suites and dedupes", () => {
  const nested = listedPairs(listReport([["a/x.spec.ts", "alpha"]], { nest: true }));
  assert.deepEqual([...nested], [pairKey("a/x.spec.ts", "alpha")]);
  // The same test listed twice (e.g. once per project) is one selection.
  const twice = listedPairs(listReport([["a/x.spec.ts", "alpha"], ["a/x.spec.ts", "alpha"]]));
  assert.equal(twice.size, 1);
});

test("baselinePairs is the wanted set, keyed spec::title", () => {
  assert.deepEqual([...baselinePairs(vBaseline)].sort(), [
    "a/x.spec.ts::alpha", "a/x.spec.ts::beta", "b/y.spec.ts::gamma",
  ]);
});

test("verifySelection is ok only when the selection is set-exact", () => {
  const v = verifySelection(vBaseline, [
    listedPairs(listReport([["a/x.spec.ts", "alpha"], ["a/x.spec.ts", "beta"]])),
    listedPairs(listReport([["b/y.spec.ts", "gamma"]])),
  ]);
  assert.equal(v.ok, true);
  assert.deepEqual([v.wanted, v.selected, v.missing.length, v.extra.length], [3, 3, 0, 0]);
  assert.deepEqual(v.counts, [2, 1]);
  assert.match(verifyReportLines(v)[0], /verified set-exact: 3 wanted \/ 3 selected \/ 0 missing \/ 0 extra; shards 2\/1/);
});

// THE CASE THE COUNT CHECK CANNOT SEE, and P14's exact wording: the total is
// right, no shard is empty, and the selection is still wrong.
test("verifySelection catches a right-total selection that dropped one and added another", () => {
  const v = verifySelection(vBaseline, [
    listedPairs(listReport([["a/x.spec.ts", "alpha"], ["a/x.spec.ts", "beta"]])),
    listedPairs(listReport([["c/z.spec.ts", "stranger"]])),   // gamma dropped, stranger added
  ]);
  assert.equal(v.selected, 3, "the count check would pass here: 3 selected, 3 wanted, no empty shard");
  assert.equal(v.ok, false);
  assert.deepEqual(v.missing, ["b/y.spec.ts::gamma"]);
  assert.deepEqual(v.extra, ["c/z.spec.ts::stranger"]);
  const out = verifyReportLines(v).join("\n");
  assert.match(out, /NOT SET-EXACT/);
  assert.match(out, /b\/y\.spec\.ts::gamma/);
  assert.match(out, /c\/z\.spec\.ts::stranger/);
});

// The same class one level subtler: the right title, in the wrong FILE. A
// title-only comparison calls this a match.
test("verifySelection catches the right title selected in the wrong spec file", () => {
  const v = verifySelection(vBaseline, [
    listedPairs(listReport([["a/x.spec.ts", "alpha"], ["a/x.spec.ts", "beta"]])),
    listedPairs(listReport([["OTHER/y.spec.ts", "gamma"]])),
  ]);
  assert.equal(v.ok, false);
  assert.deepEqual(v.missing, ["b/y.spec.ts::gamma"]);
  assert.deepEqual(v.extra, ["OTHER/y.spec.ts::gamma"]);
});

test("verifySelection calls out an EMPTY shard by number, even when the total is right", () => {
  // An empty shard is a green `manual.yml` dispatch that measures nothing, and
  // it hides inside a correct total whenever another shard over-selects.
  const v = verifySelection(vBaseline, [
    listedPairs(listReport([["a/x.spec.ts", "alpha"], ["a/x.spec.ts", "beta"], ["b/y.spec.ts", "gamma"]])),
    listedPairs(listReport([])),
  ]);
  assert.equal(v.selected, 3);
  assert.deepEqual(v.missing, []);
  assert.deepEqual(v.extra, []);
  assert.equal(v.ok, false, "set-exact is not enough: a shard that ran nothing measured nothing");
  assert.deepEqual(v.emptyShards, [2]);
  assert.match(verifyReportLines(v).join("\n"), /shard\(s\) 2 selected NOTHING/);
});

test("verifyReportLines caps the named pairs and prints how many it elided", () => {
  const many = { specs: [{ relativePath: "a/x.spec.ts", tests: Array.from({ length: VERIFY_NAME_CAP + 3 }, (_, i) => ({ title: `t${i}` })) }] };
  const out = verifyReportLines(verifySelection(many, [new Set()])).join("\n");
  assert.match(out, /3 more not listed here/);
});

// ── CLI: --verify over pre-captured reports, so this needs no Playwright run ──

test("CLI: --verify --list-json reports a set-exact selection and exits 0", () => {
  const dir = makeTempDir("triage-grep-verify-");
  const baselinePath = join(dir, "baseline.json");
  writeFileSync(baselinePath, JSON.stringify(vBaseline));
  const s1 = join(dir, "s1.json");
  const s2 = join(dir, "s2.json");
  // Shards are contiguous slices of the SORTED title list: ["alpha","beta"] and
  // ["gamma"], and "beta" lives in a/x.spec.ts while "gamma" lives in b/y.
  writeFileSync(s1, JSON.stringify(listReport([["a/x.spec.ts", "alpha"], ["a/x.spec.ts", "beta"]])));
  writeFileSync(s2, JSON.stringify(listReport([["b/y.spec.ts", "gamma"]])));

  const stdout = execFileSync(
    process.execPath,
    [SCRIPT, "--baseline", baselinePath, "--verify", "--shards", "2", "--list-json", s1, "--list-json", s2],
    { encoding: "utf-8", stdio: "pipe" },
  );
  assert.match(stdout, /verified set-exact: 3 wanted \/ 3 selected \/ 0 missing \/ 0 extra/);
});

test("CLI: --verify exits 1 and names the drift when the selection is not set-exact", () => {
  const dir = makeTempDir("triage-grep-verify-");
  const baselinePath = join(dir, "baseline.json");
  writeFileSync(baselinePath, JSON.stringify(vBaseline));
  const s1 = join(dir, "s1.json");
  const s2 = join(dir, "s2.json");
  writeFileSync(s1, JSON.stringify(listReport([["a/x.spec.ts", "alpha"], ["a/x.spec.ts", "beta"]])));
  writeFileSync(s2, JSON.stringify(listReport([["c/z.spec.ts", "stranger"]])));

  let stderr = "";
  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        [SCRIPT, "--baseline", baselinePath, "--verify", "--shards", "2", "--list-json", s1, "--list-json", s2],
        { encoding: "utf-8", stdio: "pipe" },
      ),
    (error) => {
      stderr = String(error.stderr ?? "");
      return error.status === 1;
    },
  );
  assert.match(stderr, /NOT SET-EXACT/);
  assert.match(stderr, /b\/y\.spec\.ts::gamma/);
});

test("CLI: --verify refuses a --list-json count that does not match --shards", () => {
  // Silently verifying a subset would read as "a shard selected nothing" —
  // exactly the false verdict this mode exists to produce loudly.
  const dir = makeTempDir("triage-grep-verify-");
  const baselinePath = join(dir, "baseline.json");
  writeFileSync(baselinePath, JSON.stringify(vBaseline));
  const s1 = join(dir, "s1.json");
  writeFileSync(s1, JSON.stringify(listReport([["a/x.spec.ts", "alpha"]])));

  let stderr = "";
  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        [SCRIPT, "--baseline", baselinePath, "--verify", "--shards", "3", "--list-json", s1],
        { encoding: "utf-8", stdio: "pipe" },
      ),
    (error) => {
      stderr = String(error.stderr ?? "");
      return error.status === 1;
    },
  );
  assert.match(stderr, /^\[triage-grep\] --verify got 1 --list-json report\(s\) for 3 shard\(s\)/m);
  assert.doesNotMatch(stderr, /\n\s+at /, "a named refusal, not a stack");
});

test("CLI: --verify still refuses a recorded title collision before listing anything", () => {
  const dir = makeTempDir("triage-grep-verify-");
  const baselinePath = join(dir, "baseline.json");
  writeFileSync(baselinePath, JSON.stringify({ ...vBaseline, titleCollisions: ["alpha"] }));

  let stderr = "";
  assert.throws(
    () => execFileSync(process.execPath, [SCRIPT, "--baseline", baselinePath, "--verify"], { encoding: "utf-8", stdio: "pipe" }),
    (error) => {
      stderr = String(error.stderr ?? "");
      return error.status === 1;
    },
  );
  assert.match(stderr, /1 title collision\(s\)/);
  assert.ok(existsSync(baselinePath));
});
