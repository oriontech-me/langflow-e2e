// Unit tests for the shared `@stable` parser (issue #1017).
// Run with: npm run test:units
//
// This parser is the single source of truth two consumers read — the Phase 0
// generator (`scripts/stable-tests.ts`) and the checklist guard
// (`scripts/check-checklist-coverage.ts`) — which is exactly why #985 merged
// them into one module. What it must never do is COUNT a `@stable` that is not
// a real tag, or MISS one that is: the first inflates the release signal, the
// second hides a spec from every generated count.
//
// `@stable` appears in prose all over the suite (JSDoc promotion notes, removal
// comments recording a triage decision, commented-out `tag:` lines), so the
// negative cases below are the load-bearing ones.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
import {
  LANE_TAGS,
  REGRESSION_ROOT,
  REPO_ROOT,
  SPEC_FILE_PATTERN,
  STABLE_TAG,
  TESTS_ROOT,
  UNRESOLVED_TITLE,
  declaredStableSpecFiles,
  hasUnresolvedTitleSegment,
  collectDeclaredCounts,
  collectDeclaredTests,
  collectStableTests,
  parseDeclaredCounts,
  parseDeclaredTests,
  parseStableTests,
} from "./stable-tests";
import { makeTempDir } from "./tmp-dir.mjs";
import { resolveLane } from "../../tests/fixtures/lane";

// A path under REGRESSION_ROOT — it never has to exist, `parseStableTests`
// only uses it to derive modulePath / specFile / relativePath.
const SPEC = path.join(REGRESSION_ROOT, "core-components", "example.spec.ts");

function parse(source: string) {
  return parseStableTests(SPEC, source);
}

test("counts a test() whose inline tag array contains @stable", () => {
  const { tests, warnings } = parse(`
    import { test } from "../../fixtures/fixtures";

    test("renders the loop component", { tag: ["@stable", "@components"] }, async ({ page }) => {
      await page.goto("/");
    });
  `);
  assert.deepEqual(warnings, []);
  assert.equal(tests.length, 1);
  assert.deepEqual(
    { ...tests[0], line: typeof tests[0].line },
    {
      title: "renders the loop component",
      modulePath: "core-components",
      specFile: "example.spec.ts",
      relativePath: "core-components/example.spec.ts",
      line: "number",
    },
  );
  // 1-based source line of the `test(...)` call.
  assert.equal(tests[0].line, 4);
});

test("counts @stable regardless of its position in the tag array", () => {
  const { tests } = parse(`
    test("first", { tag: ["@release", "@stable"] }, async () => {});
    test("second", { tag: ["@stable"] }, async () => {});
  `);
  assert.deepEqual(
    tests.map((t) => t.title),
    ["first", "second"],
  );
});

test("does NOT count @stable written in prose, comments or a commented-out tag line", () => {
  // Every shape below really occurs in the suite. None is a tag.
  const { tests, warnings } = parse(`
    /**
     * Promoted to @stable after the 1.10.x validation run.
     * @stable removed by daily triage #704 — see the issue for the verdict.
     */
    import { test } from "../../fixtures/fixtures";

    // tag: ["@stable", "@agents"]  <- restore once #704 is fixed
    test("untagged after triage", { tag: ["@regression"] }, async ({ page }) => {
      // The string below is data, not a tag.
      await page.getByText("@stable").click();
    });
  `);
  assert.deepEqual(tests, []);
  assert.deepEqual(warnings, []);
});

test("warns (and does not count) when @stable sits on a test.describe block", () => {
  // Playwright propagates a describe tag to every child test, so the daily's
  // `--grep @stable` WOULD run these — while Phase 0 and the checklist guard
  // never see them. Silence here is the #985 failure mode; a warning is not.
  const { tests, warnings } = parse(`
    test.describe("suite", { tag: ["@stable"] }, () => {
      test("child", async () => {});
    });
  `);
  assert.deepEqual(tests, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /test\.describe/);
  assert.match(warnings[0], /core-components\/example\.spec\.ts:2/);
});

test("warns (and does not count) when the tag array holds a non-literal element", () => {
  // An `@stable` reached through a constant or a spread would silently slip
  // past a literal-only read, so it is reported rather than guessed at.
  const { tests, warnings } = parse(`
    const TAGS = ["@stable"];
    test("indirect", { tag: [...TAGS] }, async () => {});
  `);
  assert.deepEqual(tests, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /not a string or an inline array of string literals/);
});

test("counts Playwright's documented `tag: string` form", () => {
  // This test used to assert the opposite — that a string tag warns and does
  // not count — on the assumption that only an array is a real tag. It is not:
  // Playwright's option is `string | string[]`, `--grep "@stable"` selects such
  // a test, and the daily therefore RUNS it. Refusing it here reproduced the
  // exact gap the `test.describe` warning below exists to prevent (running in
  // the daily while invisible to Phase 0), and in the #1812 detector it was a
  // false `missing` — a lane tag written this way is grep-inverted by the
  // runner and was unreadable here. Zero occurrences in the suite today, so
  // widening it changes no generated count.
  const { tests, warnings } = parse(`
    test("string tag", { tag: "@stable" }, async () => {});
  `);
  assert.equal(tests.length, 1);
  assert.equal(tests[0].title, "string tag");
  assert.deepEqual(warnings, []);
});

test("still warns when tag is neither a string nor an inline array of literals", () => {
  const { tests, warnings } = parse(`
    const TAGS = ["@stable"];
    test("indirect", { tag: TAGS }, async () => {});
  `);
  assert.deepEqual(tests, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /not a string or an inline array of string literals/);
});

test("ignores test.skip / test.fixme even when they carry @stable", () => {
  // A skipped test does not run in the daily, so counting it as validated
  // coverage would overstate the release signal.
  const { tests, warnings } = parse(`
    test.skip("quarantined", { tag: ["@stable"] }, async () => {});
    test.fixme("broken", { tag: ["@stable"] }, async () => {});
  `);
  assert.deepEqual(tests, []);
  assert.deepEqual(warnings, []);
});

test("preserves template placeholders in the title", () => {
  // The Phase 0 generator renders `${provider}` as `<provider>`; it can only do
  // that if the parser hands the placeholder through instead of collapsing it.
  const { tests } = parse(
    "test(`sets up ${provider} with a valid key`, { tag: [\"@stable\"] }, async () => {});",
  );
  assert.equal(tests.length, 1);
  assert.equal(tests[0].title, "sets up ${provider} with a valid key");
});

test("tolerates a test() call with no options object", () => {
  const { tests, warnings } = parse(`
    test("no options", async () => {});
  `);
  assert.deepEqual(tests, []);
  assert.deepEqual(warnings, []);
});

test("nested paths become the reported modulePath", () => {
  const nested = path.join(
    REGRESSION_ROOT,
    "core-functionality",
    "llm-agents",
    "agent.spec.ts",
  );
  const { tests } = parseStableTests(
    nested,
    'test("t", { tag: ["@stable"] }, async () => {});',
  );
  assert.equal(tests[0].modulePath, "core-functionality/llm-agents");
  assert.equal(
    tests[0].relativePath,
    "core-functionality/llm-agents/agent.spec.ts",
  );
});

// ─── Invariant over the real suite ───────────────────────────────────────────

test("the real suite walk finds @stable tests", () => {
  // Not a fixture: this walks `regression/` as CI does. The count itself is
  // volatile by design (triage adds and removes tags), so the assertion is only
  // that the walk found SOMETHING. A zero is the silent failure with no other
  // alarm: `check-checklist-coverage.ts` would pass trivially (no `@stable` left
  // to cross-check), the Phase 0 generator would emit an empty block, and every
  // generated number would read as "no coverage" rather than "broken walk".
  //
  // Deliberately NOT asserting `warnings` is empty: `check-checklist-coverage.ts`
  // already exits non-zero on any parse warning, inside the `QA-CHECKLIST guard`
  // job — whose name tells a spec author that a tag is misplaced. Repeating it
  // here would report the same problem from a job called "TypeScript unit tests"
  // and make this lane's verdict depend on the state of the whole suite.
  const { tests } = collectStableTests();
  assert.ok(tests.length > 0, "no @stable tests found under regression/");
});

// ─── Declared suite size, OSS only ───────────────────────────────────────────
//
// This counter is the denominator of the dashboard's coverage band, so the two
// ways it can lie are the mirror of the ones above: counting an @enterprise
// test as OSS inflates the denominator with tests no nightly can execute, and
// counting an OSS test as Enterprise hides real declared surface.

test("an untagged test() counts as OSS", () => {
  const c = parseDeclaredCounts(`
    test("does a thing", { tag: ["@components"] }, async ({ page }) => {});
    test("does another", async ({ page }) => {});
  `);
  assert.deepEqual(c, { total: 2, enterprise: 0, oss: 2 });
});

test("an @enterprise test() is counted out of OSS", () => {
  const c = parseDeclaredCounts(`
    test("rbac baseline", { tag: ["@enterprise", "@authz"] }, async ({ page }) => {});
    test("plain one", { tag: ["@api"] }, async ({ page }) => {});
  `);
  assert.deepEqual(c, { total: 2, enterprise: 1, oss: 1 });
});

test("@enterprise on a test.describe is inherited by the tests inside", () => {
  // Playwright applies a suite tag to every test in it, so the lane grep-invert
  // removes them all. Counting them as OSS would put unreachable tests back in
  // the denominator — the exact bug this counter exists to fix.
  const c = parseDeclaredCounts(`
    test.describe("admin console", { tag: ["@enterprise"] }, () => {
      test("lists users", async ({ page }) => {});
      test("exports the audit log", { tag: ["@api"] }, async ({ page }) => {});
    });
  `);
  assert.deepEqual(c, { total: 2, enterprise: 2, oss: 0 });
});

test("an @enterprise describe does not leak into a sibling test after it", () => {
  // Guards the inheritance against being implemented as a latch: once the flag
  // is set by a describe, it must fall back off when the walk leaves that
  // subtree. A latch passes the test above and silently zeroes OSS from the
  // first Enterprise suite in the file onward.
  const c = parseDeclaredCounts(`
    test.describe("admin console", { tag: ["@enterprise"] }, () => {
      test("lists users", async ({ page }) => {});
    });
    test("an OSS test declared afterwards", { tag: ["@api"] }, async ({ page }) => {});
  `);
  assert.deepEqual(c, { total: 2, enterprise: 1, oss: 1 });
});

test("a nested describe inside an @enterprise one stays Enterprise", () => {
  const c = parseDeclaredCounts(`
    test.describe("enterprise surface", { tag: ["@enterprise"] }, () => {
      test.describe("nested", { tag: ["@authz"] }, () => {
        test("deep test", async ({ page }) => {});
      });
    });
  `);
  assert.deepEqual(c, { total: 1, enterprise: 1, oss: 0 });
});

test("@enterprise in prose or a commented-out tag is not counted", () => {
  // The textual `grep` this replaced could not tell these apart.
  const c = parseDeclaredCounts(`
    /**
     * Was promoted out of @enterprise when the surface shipped to OSS.
     */
    test("an OSS test", { tag: ["@api"] }, async ({ page }) => {});
    // test("retired", { tag: ["@enterprise"] }, async ({ page }) => {});
    const note = "@enterprise";
  `);
  assert.deepEqual(c, { total: 1, enterprise: 0, oss: 1 });
});

test("test.describe and test.skip are not counted as declared tests", () => {
  const c = parseDeclaredCounts(`
    test.describe("a suite", { tag: ["@api"] }, () => {
      test.skip("skipped", async ({ page }) => {});
      test("the only real one", async ({ page }) => {});
    });
  `);
  assert.deepEqual(c, { total: 1, enterprise: 0, oss: 1 });
});

// ─── parseDeclaredTests — the orphan reconciler's input (#1746) ──────────────
//
// The complement of the `@stable` parser above: the reconciler needs the tests
// that DO NOT carry the tag, so "no tag array at all" has to come back as a row
// rather than as an absence, and `test.fixme` has to come back at all.

function declaredIn(source: string) {
  return parseDeclaredTests(SPEC, source);
}

test("a declared test with no tag option at all is returned, not skipped", () => {
  const out = declaredIn(`
    test("an untagged test", async ({ page }) => {});
  `);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].tags, []);
  assert.equal(out[0].stable, false);
  assert.equal(out[0].fixme, false);
});

test("the declaring form of test.fixme is a declared test, and is marked", () => {
  // Rule 3 of #1746: `@stable` removal and `test.fixme` are applied together at
  // flake quarantine but separately at hard-failure auto-removal, and "runs
  // nowhere at all" is the worse of the two states.
  const out = declaredIn(`
    test.fixme("a quarantined test", { tag: ["@regression"] }, async ({ page }) => {});
  `);
  assert.equal(out.length, 1);
  assert.equal(out[0].fixme, true);
  assert.equal(out[0].title, "a quarantined test");
});

test("the declaring form of test.skip is a declared test too, and is marked", () => {
  // Latent, not live: there are zero such declarations in the suite today. It
  // is a parser rule rather than a report because the failure mode is silence —
  // a test quarantined this way was not an orphan, not owned and not UNKNOWN,
  // it was simply absent from the reconciler's output, which is the
  // nonexistent-path shape (#1092) inside the check written to end it.
  const out = declaredIn(`
    test.skip("a test quarantined with skip", { tag: ["@regression"] }, async ({ page }) => {});
  `);
  assert.equal(out.length, 1);
  assert.equal(out[0].fixme, true, "it runs on no lane, same as test.fixme");
  assert.equal(out[0].title, "a test quarantined with skip");
});

test("the MODIFIER form of test.skip is not mistaken for a declaration", () => {
  // The form the suite actually uses — 8 call sites today, e.g.
  // `model-provider-base-url-ssrf.spec.ts`. Its first argument is a condition or
  // an arrow function, never a string literal, which is what separates the two.
  const out = declaredIn(`
    test("a test that skips itself", { tag: ["@regression"] }, async ({ page }) => {
      test.skip();
      test.skip(true, "a reason");
      test.skip(process.env.X !== "1", "another reason");
      test.skip(({ browserName }) => browserName === "firefox", "yet another");
    });
  `);
  assert.equal(out.length, 1);
  assert.equal(out[0].fixme, false, "the declaration is a plain test()");
});

test("an in-body test.fixme() call is not mistaken for a declaration", () => {
  const out = declaredIn(`
    test("a test that skips itself", { tag: ["@regression"] }, async ({ page }) => {
      test.fixme();
      test.fixme(true, "a reason");
    });
  `);
  assert.equal(out.length, 1);
  assert.equal(out[0].fixme, false, "the declaration is a plain test()");
});

test("@stable inherited from a describe block marks the child tests stable", () => {
  // Playwright applies a suite tag to every test inside and the daily's
  // `--grep "@stable"` honours it, so such a test IS in the daily. Reading it
  // as an absence would report a false orphan — the opposite decision from
  // `parseStableTests`, which warns because Phase 0 lists tests individually.
  const out = declaredIn(`
    test.describe("a suite", { tag: ["@stable"] }, () => {
      test("a child", { tag: ["@components"] }, async ({ page }) => {});
    });
  `);
  assert.equal(out.length, 1);
  assert.equal(out[0].stable, true);
  assert.deepEqual(out[0].tags, ["@components"]);
});

test("an unreadable tag option is flagged rather than read as untagged", () => {
  const out = declaredIn(`
    test("a test", { tag: TAGS }, async ({ page }) => {});
  `);
  assert.equal(out.length, 1);
  assert.equal(out[0].unparseableTags, true);
  assert.equal(out[0].stable, false);
});

test("the lane selectors are the three that are never combined with @stable", () => {
  assert.deepEqual([...LANE_TAGS], ["@destructive", "@enterprise", "@serving"]);
});

test("collectDeclaredTests covers every @stable test the Phase 0 parser finds", () => {
  // The two parsers answer different questions over the same tree; if the
  // broader one ever missed a declaration the narrower one sees, the
  // reconciler would silently stop scanning part of the suite.
  const declared = collectDeclaredTests();
  const key = (p: string, t: string) => `${p}::${t}`;
  const seen = new Set(declared.map((d) => key(d.relativePath, d.title)));
  for (const s of collectStableTests().tests) {
    assert.ok(
      seen.has(key(s.relativePath, s.title)),
      `${s.relativePath} — "${s.title}" is visible to both parsers`,
    );
  }
  assert.ok(declared.length >= collectStableTests().tests.length);
});

test("only test() and test.fixme() declare a test — test.step and friends do not", () => {
  // A parser that accepts any `test.X("literal", …)` swallows every
  // `test.step()` in the suite: measured, `collectDeclaredTests()` went from
  // 815 rows to 2319 under exactly that mutation, and NOTHING in the unit lane
  // noticed, because the only cross-parser assertion checks a superset.
  const out = declaredIn(`
    test("a real test", { tag: ["@regression"] }, async ({ page }) => {
      await test.step("a step, not a test", async () => {});
      await test.slow("also not a test", async () => {});
    });
    test.fixme("a quarantined test", { tag: ["@regression"] }, async () => {});
    test.describe("a suite", { tag: ["@regression"] }, () => {});
  `);
  assert.deepEqual(
    out.map((d) => d.title),
    ["a real test", "a quarantined test"],
  );
});

test("collectDeclaredTests counts exactly the declared tests, no more", () => {
  // The upper bound is the assertion that dies under over-collection; the
  // superset check above it survives one. `parseDeclaredCounts` counts plain
  // `test()` calls only, so the two differ by the `test.fixme` declarations.
  const declared = collectDeclaredTests();
  const fixmes = declared.filter((d) => d.fixme).length;
  assert.equal(declared.length, collectDeclaredCounts().total + fixmes);
});

test("a lane tag on a describe block reaches its child tests", () => {
  // Symmetry with `@stable`: Playwright applies a suite tag to everything
  // inside, so a suite hoisted to `@enterprise` would otherwise turn every test
  // in it into an orphan candidate. Currently inert — no describe in the tree
  // carries one — which is exactly when it is cheap to pin.
  const out = declaredIn(`
    test.describe("an enterprise suite", { tag: ["@enterprise"] }, () => {
      test("a child", { tag: ["@authz"] }, async ({ page }) => {});
    });
  `);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].tags, ["@authz", "@enterprise"]);
});

test("an inherited lane tag is not duplicated when the test declares it too", () => {
  const out = declaredIn(`
    test.describe("a suite", { tag: ["@destructive"] }, () => {
      test("a child", { tag: ["@destructive", "@api"] }, async ({ page }) => {});
    });
  `);
  assert.deepEqual(out[0].tags, ["@destructive", "@api"]);
});

// ─── DeclaredTest.modifier — additive field ──────────────────────────────────
//
// `fixme` alone answers "does this run in no lane", which is all the
// checklist guard's population needs; the never-validated backlog's unmute
// step (design Task 7) has to tell the operator WHICH call to change back, so
// it needs the specific token. Read off the exact AST node `fixme` already
// inspects (see the `modifier` local in `parseDeclaredTests`), never by
// re-reading the source line with a regex — the instrument that produced
// wrong claims elsewhere in this repo's own tooling.

test("modifier is the empty string on a plain test()", () => {
  const out = declaredIn(`
    test("a plain test", { tag: ["@regression"] }, async ({ page }) => {});
  `);
  assert.equal(out.length, 1);
  assert.equal(out[0].modifier, "");
  assert.equal(out[0].fixme, false);
});

test('modifier is "fixme" on the declaring form of test.fixme', () => {
  const out = declaredIn(`
    test.fixme("a quarantined test", { tag: ["@regression"] }, async ({ page }) => {});
  `);
  assert.equal(out.length, 1);
  assert.equal(out[0].modifier, "fixme");
  assert.equal(out[0].fixme, true);
});

test('modifier is "skip" on the declaring form of test.skip', () => {
  const out = declaredIn(`
    test.skip("a test quarantined with skip", { tag: ["@regression"] }, async ({ page }) => {});
  `);
  assert.equal(out.length, 1);
  assert.equal(out[0].modifier, "skip");
  assert.equal(out[0].fixme, true);
});

// ─── declaredStableSpecFiles — what the shard matrix expects to be listed (#1812) ──

/**
 * Build a throwaway `tests/`-shaped tree and read it back.
 *
 * The filesystem is the point here: the function's whole job is to reproduce
 * the file set Playwright collects, so a test that stubs the walk would pin the
 * predicate and miss the half that has to agree with `testMatch`.
 */
function withTree(
  files: Record<string, string>,
  run: (root: string) => void,
): void {
  const root = makeTempDir("declared-specs-");
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split("/"));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
  run(root);
  // `makeTempDir` removes itself on process exit (#1732); dropping it here too
  // keeps a tree out of the way of the next case, which walks a fresh root.
  fs.rmSync(root, { recursive: true, force: true });
}

const stableTest = (title: string, ...tags: string[]) =>
  `test("${title}", { tag: [${[STABLE_TAG, ...tags].map((t) => `"${t}"`).join(", ")}] }, async () => {});`;

test("declaredStableSpecFiles reports a file with one @stable test, relative to the root", () => {
  withTree(
    {
      "tests-automations/regression/core-components/a.spec.ts": stableTest("a"),
      "fixtures/gate.spec.ts": stableTest("b"),
      "tests-automations/regression/core-components/plain.spec.ts":
        'test("c", { tag: ["@regression"] }, async () => {});',
    },
    (root) => {
      const d = declaredStableSpecFiles(root);
      assert.deepEqual(d.files, [
        "fixtures/gate.spec.ts",
        "tests-automations/regression/core-components/a.spec.ts",
      ]);
      assert.equal(d.root, root);
      assert.deepEqual(d.laneOnly, []);
      assert.deepEqual(d.unparseable, []);
    },
  );
});

// The measured reason the scope is `tests/` and not `tests/tests-automations/`:
// five listed files live outside the regression tree, and the narrower scope
// reports them as phantom losses (242 against the listing's 247).
test("declaredStableSpecFiles covers specs OUTSIDE the regression tree", () => {
  withTree({ "collect-models.spec.ts": stableTest("sweep") }, (root) => {
    assert.deepEqual(declaredStableSpecFiles(root).files, ["collect-models.spec.ts"]);
  });
});

test("declaredStableSpecFiles honours an @stable inherited from test.describe", () => {
  withTree(
    {
      "d.spec.ts": `
        test.describe("suite", { tag: ["${STABLE_TAG}"] }, () => {
          test("inherits", async () => {});
        });
      `,
    },
    (root) => {
      // Playwright's --grep honours the inherited tag, so the daily really does
      // run this file. Reading it as undeclared would report the file as
      // listed-only on every run.
      assert.deepEqual(declaredStableSpecFiles(root).files, ["d.spec.ts"]);
    },
  );
});

test("declaredStableSpecFiles excludes a file whose every @stable test is lane-tagged, and names it", () => {
  for (const lane of LANE_TAGS) {
    withTree({ "lane.spec.ts": stableTest("x", lane) }, (root) => {
      const d = declaredStableSpecFiles(root);
      // `config.grepInvert` removes these from every normal listing, so counting
      // them would report a permanent phantom loss. CLAUDE.md forbids the
      // combination (#1010), which is why it is reported rather than dropped.
      assert.deepEqual(d.files, []);
      assert.deepEqual(d.laneOnly, ["lane.spec.ts"]);
    });
  }
});

test("declaredStableSpecFiles keeps a file that has a lane-tagged @stable test AND a normal one", () => {
  withTree(
    {
      "mixed.spec.ts": `
        ${stableTest("destructive one", "@destructive")}
        ${stableTest("normal one")}
      `,
    },
    (root) => {
      const d = declaredStableSpecFiles(root);
      assert.deepEqual(d.files, ["mixed.spec.ts"]);
      assert.deepEqual(d.laneOnly, []);
    },
  );
});

test("declaredStableSpecFiles counts a test.fixme / declaring test.skip as declared", () => {
  // Playwright's `--list` reports a fixme'd test, so the file IS in the listing.
  // Treating it as undeclared would make the file permanently listed-only.
  withTree(
    {
      "f.spec.ts": `test.fixme("quarantined", { tag: ["${STABLE_TAG}"] }, async () => {});`,
    },
    (root) => {
      assert.deepEqual(declaredStableSpecFiles(root).files, ["f.spec.ts"]);
    },
  );
});

test("declaredStableSpecFiles collects the same extensions playwright.config.ts testMatch does", () => {
  withTree(
    {
      "a.spec.ts": stableTest("ts"),
      "b.spec.mts": stableTest("mts"),
      "c.spec.cjs": stableTest("cjs"),
      "d.spec.js": stableTest("js"),
      // Not a spec: the unit lane's own files, which `testMatch` deliberately drops.
      "e.test.ts": stableTest("unit"),
      "f.ts": stableTest("plain"),
    },
    (root) => {
      assert.deepEqual(declaredStableSpecFiles(root).files, [
        "a.spec.ts",
        "b.spec.mts",
        "c.spec.cjs",
        "d.spec.js",
      ]);
    },
  );
});

test("SPEC_FILE_PATTERN is the same predicate playwright.config.ts declares", () => {
  // Not a spelling check: a divergence here makes a legitimately collected file
  // read as one the listing invented, which is the noise that gets a detector
  // switched off.
  const config = fs.readFileSync(path.join(REPO_ROOT, "playwright.config.ts"), "utf-8");
  const m = config.match(/testMatch:\s*(\/[^\n,]+\/)/);
  assert.ok(m, "playwright.config.ts no longer declares testMatch as a RegExp literal");
  assert.equal(m![1], SPEC_FILE_PATTERN.toString());
});

test("declaredStableSpecFiles reports a file whose tag array it cannot read", () => {
  withTree(
    {
      "u.spec.ts": `
        const TAGS = ["${STABLE_TAG}"];
        test("indirect", { tag: TAGS }, async () => {});
      `,
    },
    (root) => {
      const d = declaredStableSpecFiles(root);
      // UNKNOWN, not absent: the file may well be listed, and saying so is what
      // keeps a listed-only report attributable instead of mysterious (#1012).
      assert.deepEqual(d.files, []);
      assert.deepEqual(d.unparseable, ["u.spec.ts"]);
    },
  );
});

test("declaredStableSpecFiles ignores @stable written in prose", () => {
  withTree(
    {
      "p.spec.ts": `
        // @stable removed by daily triage #704 — restore once #705 lands.
        /** Promoted to @stable on 2026-01-01. */
        // test("old", { tag: ["@stable"] }, async () => {});
        test("live", { tag: ["@regression"] }, async () => {});
      `,
    },
    (root) => {
      assert.deepEqual(declaredStableSpecFiles(root).files, []);
    },
  );
});

test("declaredStableSpecFiles agrees with collectStableTests on the real regression tree", () => {
  // Two parsers over one tree: the Phase 0 collector lists @stable TESTS under
  // `regression/`, this one lists FILES under `tests/`. Restricted to the
  // regression tree the file sets must be identical — a divergence means one of
  // them has drifted, and the daily's matrix reads this one.
  const declared = declaredStableSpecFiles();
  const fromFiles = new Set(
    declared.files
      .filter((f) => f.startsWith("tests-automations/regression/"))
      .map((f) => f.replace("tests-automations/regression/", "")),
  );
  // The Phase 0 collector does NOT filter lane tags, so a file whose every @stable
  // test is lane-tagged is a legitimate difference and must not break this lane —
  // the first `@stable @enterprise` test anyone writes would otherwise fail a unit
  // test rather than the detector. There are none today (CLAUDE.md forbids the
  // combination, #1010); this keeps the assertion about the thing it is about.
  const laneOnly = new Set(
    declared.laneOnly
      .filter((f) => f.startsWith("tests-automations/regression/"))
      .map((f) => f.replace("tests-automations/regression/", "")),
  );
  const fromTests = new Set(
    collectStableTests()
      .tests.map((t) => t.relativePath)
      .filter((f) => !laneOnly.has(f)),
  );
  // `fromFiles` may legitimately be the larger of the two — it counts a
  // describe-inherited or fixme'd @stable that the Phase 0 parser reports as a
  // warning rather than a test — so the direction that must hold is this one.
  for (const f of fromTests) assert.ok(fromFiles.has(f), `${f} is @stable but not declared`);
});

test("declaredStableSpecFiles excludes a lane tag by EVERY route Playwright greps", () => {
  // `grepInvert` runs over `TestCase._grepTitleWithTags()` — every ancestor
  // suite's title AND tags, then the test's own title and tags, space-joined —
  // so a lane tag reaches it by four routes. Each of these was measured against
  // a real `--list`: the file was excluded from the listing while an
  // exact-match-over-tags predicate counted it, i.e. a false `missing`, i.e. a
  // red daily and an umbrella naming a file that nothing lost.
  const routes: Record<string, string> = {
    "own title": `test("@destructive wipes the account", { tag: ["${STABLE_TAG}"] }, async () => {});`,
    "describe title": `
      test.describe("@destructive account wipers", () => {
        test("wipes nothing", { tag: ["${STABLE_TAG}", "@api"] }, async () => {});
      });
    `,
    "describe tag array": `
      test.describe("suite", { tag: ["@enterprise"] }, () => {
        test("inherits", { tag: ["${STABLE_TAG}"] }, async () => {});
      });
    `,
    // grepInvert is a SUBSTRING regex; the first version compared tag strings for
    // equality, so a longer token slipped past it.
    "substring of a longer tag": `test("boundary", { tag: ["${STABLE_TAG}", "@serving-identity"] }, async () => {});`,
    "substring of a title word": `test("mentions @servingless models", { tag: ["${STABLE_TAG}"] }, async () => {});`,
  };
  for (const [route, source] of Object.entries(routes)) {
    withTree({ "t.spec.ts": source }, (root) => {
      const d = declaredStableSpecFiles(root);
      assert.deepEqual(d.files, [], route);
      assert.deepEqual(d.laneOnly, ["t.spec.ts"], route);
    });
  }
});

test("declaredStableSpecFiles excludes a spec whose PATH carries a lane tag", () => {
  // The file suite's title is the path relative to `testDir`, and
  // `_collectGrepTitlePath` pushes it like any other. Exotic, but the predicate
  // claims to predict the listing, so it reproduces the composition rather than
  // approximating it.
  withTree({ "@serving/t.spec.ts": stableTest("ordinary") }, (root) => {
    const d = declaredStableSpecFiles(root);
    assert.deepEqual(d.files, []);
    assert.deepEqual(d.laneOnly, ["@serving/t.spec.ts"]);
  });
});

test("the lane exclusion is playwright.config.ts's own, not a second copy", () => {
  // `resolveLane({})` is what the config passes as `grepInvert`, so a fourth lane
  // tag cannot need a second edit here to keep the detector honest (#1045's shape).
  const invert = resolveLane({}).grepInvert;
  assert.ok(invert, "a normal run must still exclude the lane tags");
  for (const lane of LANE_TAGS) assert.ok(invert!.test(`x ${lane}`), lane);
});

test("parseDeclaredTests composes grepTitle the way Playwright does", () => {
  // Ancestor suite title, then its tags, then the test's title, then its tags.
  const [t] = parseDeclaredTests(
    path.join(REGRESSION_ROOT, "x.spec.ts"),
    `
      test.describe("outer", { tag: ["@api"] }, () => {
        test.describe("inner", () => {
          test("leaf", { tag: ["${STABLE_TAG}", "@agents"] }, async () => {});
        });
      });
    `,
  );
  assert.equal(t.grepTitle, `outer @api inner leaf ${STABLE_TAG} @agents`);
});

test("declaredStableSpecFiles keeps a file whose OTHER @stable test has no lane tag in its title", () => {
  withTree(
    {
      "t.spec.ts": `
        test("@serving isolates identities", { tag: ["${STABLE_TAG}"] }, async () => {});
        ${stableTest("ordinary")}
      `,
    },
    (root) => {
      assert.deepEqual(declaredStableSpecFiles(root).files, ["t.spec.ts"]);
    },
  );
});

test("declaredStableSpecFiles returns an empty set rather than inventing one, and the CLI refuses it", () => {
  // The floor `snapshotCatalog` has as --min-categories, and for the same reason:
  // the completeness check is ONE-SIDED, so an empty declaration certifies every
  // possible listing as complete. Refused by the producer as well as by the
  // comparison, because a caller that never sees the exit code still gets an
  // UNVERIFIED verdict out of the diff.
  withTree({ "notaspec.ts": stableTest("x") }, (root) => {
    assert.deepEqual(declaredStableSpecFiles(root).files, []);
  });
  // And the producer end-to-end: the daily reads this process's STDOUT, so the
  // shape and the exit code are the contract. It walks the root derived from its
  // own location, so it reports the real tree whatever the cwd.
  const r = spawnSync(
    process.execPath,
    ["-r", "ts-node/register", path.join(REPO_ROOT, "scripts", "declared-stable-specs.ts")],
    { cwd: REPO_ROOT, encoding: "utf-8" },
  );
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.ok(out.files.length > 0, "the real tree must declare @stable spec files");
  assert.equal(out.version, 1);
  assert.equal(out.root, TESTS_ROOT);
  assert.ok(Array.isArray(out.laneOnly) && Array.isArray(out.unparseable));
  // Diagnostics must never reach stdout — the caller parses it.
  assert.match(r.stderr, /declared: \d+ spec file\(s\)/);
});

// ─── #1812, round three: the two routes the predicate still could not see ────

test("readTagsArray accepts Playwright's documented `tag: string` form", () => {
  // `tag` is `string | string[]`. Reading only the array meant
  // `{ tag: "@destructive" }` on a describe was invisible here while the runner
  // excluded the file — a false `missing` and a red daily.
  withTree(
    {
      "t.spec.ts": `
        test.describe("wipers", { tag: "@destructive" }, () => {
          test("wipes the account", { tag: ["${STABLE_TAG}"] }, async () => {});
        });
      `,
    },
    (root) => {
      const d = declaredStableSpecFiles(root);
      assert.deepEqual(d.files, []);
      assert.deepEqual(d.laneOnly, ["t.spec.ts"]);
      assert.deepEqual(d.unparseable, []);
    },
  );
  // And the same form carrying @stable itself is a declaration, not a mystery.
  withTree({ "s.spec.ts": `test("solo", { tag: "${STABLE_TAG}" }, async () => {});` }, (root) => {
    assert.deepEqual(declaredStableSpecFiles(root).files, ["s.spec.ts"]);
  });
});

test("a describe `tag` the parser cannot read makes its tests UNDECIDABLE, not decided", () => {
  // It hides whatever it holds from every child, a lane tag included. Counting
  // the file as fully understood is the false-`missing` direction; calling it
  // lane-only would hide a real loss. Neither bucket — and it says so.
  withTree(
    {
      "u.spec.ts": `
        const LANE = ["@destructive"];
        test.describe("wipers", { tag: LANE }, () => {
          test("wipes the account", { tag: ["${STABLE_TAG}"] }, async () => {});
        });
      `,
    },
    (root) => {
      const d = declaredStableSpecFiles(root);
      assert.deepEqual(d.files, []);
      assert.deepEqual(d.laneOnly, []);
      assert.deepEqual(d.unparseable, ["u.spec.ts"]);
    },
  );
});

test("a readable @stable test still counts when a SIBLING suite is unreadable", () => {
  withTree(
    {
      "m.spec.ts": `
        const LANE = ["@destructive"];
        test.describe("opaque", { tag: LANE }, () => {
          test("hidden", { tag: ["${STABLE_TAG}"] }, async () => {});
        });
        ${stableTest("plainly selectable")}
      `,
    },
    (root) => {
      const d = declaredStableSpecFiles(root);
      assert.deepEqual(d.files, ["m.spec.ts"]);
      assert.deepEqual(d.unparseable, ["m.spec.ts"]);
    },
  );
});

test("an interpolated suite title is REPORTED, never excused", () => {
  // Playwright greps the runtime string; this parser sees `${lane}`. Dropping
  // such files would blind the detector on the provider-parametrized specs —
  // 19 files here, #1764's own family — so they stay in `files` and the doubt
  // is carried instead.
  withTree(
    {
      "i.spec.ts": `
        const label = "openai";
        test.describe(\`[\${label}] provider\`, () => {
          test("resolves a model", { tag: ["${STABLE_TAG}"] }, async () => {});
        });
      `,
    },
    (root) => {
      const d = declaredStableSpecFiles(root);
      assert.deepEqual(d.files, ["i.spec.ts"]);
      assert.deepEqual(d.unresolvedTitles, ["i.spec.ts"]);
    },
  );
});

test("a suite title the parser cannot read at all is marked, not omitted", () => {
  // Omission is what turns an unknown into a confident "this should have been
  // listed": the segment could hold a lane tag at run time.
  withTree(
    {
      "n.spec.ts": `
        const TITLE = "@enterprise suite";
        test.describe(TITLE, () => {
          test("inherits nothing readable", { tag: ["${STABLE_TAG}"] }, async () => {});
        });
      `,
    },
    (root) => {
      const d = declaredStableSpecFiles(root);
      assert.deepEqual(d.unresolvedTitles, ["n.spec.ts"]);
      assert.ok(hasUnresolvedTitleSegment(UNRESOLVED_TITLE));
    },
  );
});

test("the unresolved marker can never match a lane pattern on its own", () => {
  const invert = resolveLane({}).grepInvert;
  assert.equal(invert!.test(UNRESOLVED_TITLE), false);
});

test("a plain literal title is never reported as unresolved", () => {
  withTree({ "p.spec.ts": stableTest("ordinary title") }, (root) => {
    assert.deepEqual(declaredStableSpecFiles(root).unresolvedTitles, []);
  });
});

// ─── #1812, round four: a tag whose runtime value is not knowable ───────────

test("an interpolated tag is UNREADABLE, not a tag whose text happens to be its source", () => {
  // `literalText` renders a template with substitutions as its SOURCE, which is
  // right for a TITLE (Phase 0 publishes `${provider}` on purpose) and wrong for
  // a TAG: it hands back a string the parser knows is not the runtime value,
  // marked as successfully read. Widening the string form to use it defused
  // three fail-closed guards at once — `check-checklist-coverage`,
  // `stable-tests --check` and `assertNoWarnings` all went from refusing
  // `` tag: `@${T}` `` to silence — which is the "runs in the daily, invisible
  // to the generator" gap those guards exist for.
  for (const form of ["`@${T}`", "[`@${T}`]"]) {
    const { tests, warnings } = parse(`
      const T = "stable";
      test("interpolated", { tag: ${form} }, async () => {});
    `);
    assert.deepEqual(tests, [], form);
    assert.equal(warnings.length, 1, form);
    assert.match(warnings[0], /not a string or an inline array of string literals/);
  }
});

test("a template TITLE still keeps its placeholder — only tags are stricter", () => {
  // The Phase 0 generator renders `${provider}` as `<provider>`, so tightening
  // the tag reader must not tighten the title reader with it.
  const { tests } = parse(
    "test(`sets up ${provider}`, { tag: [\"@stable\"] }, async () => {});",
  );
  assert.equal(tests.length, 1);
  assert.equal(tests[0].title, "sets up ${provider}");
});

test("an interpolated tag leaves the file UNDECIDABLE for the detector too", () => {
  withTree(
    {
      "i.spec.ts": "const T = \"destructive\";\ntest(\"x\", { tag: [`@${T}`] }, async () => {});",
    },
    (root) => {
      const d = declaredStableSpecFiles(root);
      assert.deepEqual(d.files, []);
      assert.deepEqual(d.unparseable, ["i.spec.ts"]);
    },
  );
});

test("unresolvedTitles covers the TEST's own title, not only a suite's", () => {
  // One real file is in this bucket with no `test.describe` in it at all
  // (`file-types-upload.spec.ts`), so a report worded over a describe would send
  // the reader looking for a construct the file does not contain.
  withTree(
    {
      "t.spec.ts": "const ext = \"pdf\";\ntest(`upload a ${ext} file`, { tag: [\"@stable\"] }, async () => {});",
    },
    (root) => {
      const d = declaredStableSpecFiles(root);
      assert.deepEqual(d.files, ["t.spec.ts"]);
      assert.deepEqual(d.unresolvedTitles, ["t.spec.ts"]);
    },
  );
});

test("an inherited unreadable tag is reported without blaming the child's own line", () => {
  // The flag travels down since #1812, so the row's line is the TEST's while the
  // unreadable option may be on a describe several lines above it.
  const tests = parseDeclaredTests(
    path.join(REGRESSION_ROOT, "x.spec.ts"),
    `
      const LANE = ["@destructive"];
      test.describe("suite", { tag: LANE }, () => {
        test("child", { tag: ["@regression"] }, async () => {});
      });
    `,
  );
  assert.equal(tests.length, 1);
  assert.equal(tests[0].unparseableTags, true);
  assert.equal(tests[0].line, 4, "the row still cites the test, which is why the wording must not");
});
