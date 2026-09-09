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
import * as path from "path";
import {
  LANE_TAGS,
  REGRESSION_ROOT,
  collectDeclaredCounts,
  collectDeclaredTests,
  collectStableTests,
  parseDeclaredCounts,
  parseDeclaredTests,
  parseStableTests,
  parseTaggedTests,
} from "./stable-tests";

// A path under REGRESSION_ROOT — it never has to exist, `parseStableTests`
// only uses it to derive modulePath / specFile / relativePath.
const SPEC = path.join(REGRESSION_ROOT, "core-components", "example.spec.ts");

// Same idiom, for the `parseTaggedTests` cases below — a distinct path so the
// expected `modulePath` / `specFile` / `relativePath` values are visibly tied
// to this constant rather than reused from SPEC's `core-components/` value.
const TAGGED_SPEC = path.join(REGRESSION_ROOT, "area", "x.spec.ts");

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
  assert.match(warnings[0], /not an inline array of string literals/);
});

test("warns (and does not count) when tag is not an array at all", () => {
  const { tests, warnings } = parse(`
    test("string tag", { tag: "@stable" }, async () => {});
  `);
  assert.deepEqual(tests, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /not an inline array of string literals/);
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

// ─── parseTaggedTests — every tagged declaration, not only @stable ──────────
//
// The backlog predicate in a later task reads this directly instead of a
// second AST walk (#985 would apply to this module just as much as to a
// separate one). It must see every DECLARATION regardless of tag or modifier,
// and it must not be fooled by an in-body `test.skip(cond, msg)` guard, which
// has the same two-argument shape as a real declaration.

test("parseTaggedTests reads a plain tagged declaration", () => {
  const src = `test("a title", { tag: ["@release", "@api"] }, async () => {});`;
  const { tests, warnings } = parseTaggedTests(TAGGED_SPEC, src);
  assert.equal(warnings.length, 0);
  assert.deepEqual(tests, [
    {
      title: "a title",
      tags: ["@release", "@api"],
      modifier: "",
      modulePath: "area",
      specFile: "x.spec.ts",
      relativePath: "area/x.spec.ts",
      line: 1,
    },
  ]);
});

test("parseTaggedTests records the modifier of a quarantined declaration", () => {
  const src = `test.fixme("blocked", { tag: ["@release"] }, async () => {});`;
  const { tests } = parseTaggedTests(TAGGED_SPEC, src);
  assert.equal(tests.length, 1);
  assert.equal(tests[0].modifier, "fixme");
});

// THE TRAP. `test.skip(condition, message)` inside a test body also has two
// arguments, and counting it as a declaration inflates the population by the
// number of provider guards -- 96 of them in llm-agents alone. The second
// argument must be an object literal carrying an inline `tag` array.
test("parseTaggedTests ignores an in-body test.skip guard", () => {
  const src = [
    `test("real", { tag: ["@release"] }, async ({ page }) => {`,
    `  test.skip(!hasProviderEnvKeys("openai"), "no key");`,
    `  test.fail();`,
    `});`,
  ].join("\n");
  const { tests } = parseTaggedTests(TAGGED_SPEC, src);
  assert.equal(tests.length, 1);
  assert.equal(tests[0].title, "real");
});

test("parseTaggedTests warns on a tag array it cannot read", () => {
  const src = `test("t", { tag: SHARED_TAGS }, async () => {});`;
  const { tests, warnings } = parseTaggedTests(TAGGED_SPEC, src);
  assert.equal(tests.length, 0);
  assert.match(warnings[0], /not an inline array/);
});

test("parseTaggedTests preserves a template-literal title", () => {
  const src = "test(`agent [${label}]`, { tag: [\"@release\"] }, async () => {});";
  const { tests } = parseTaggedTests(TAGGED_SPEC, src);
  assert.equal(tests[0].title, "agent [${label}]");
});
