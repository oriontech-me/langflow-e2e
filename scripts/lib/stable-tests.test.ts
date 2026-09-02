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
  REGRESSION_ROOT,
  collectStableTests,
  parseDeclaredCounts,
  parseStableTests,
} from "./stable-tests";

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
