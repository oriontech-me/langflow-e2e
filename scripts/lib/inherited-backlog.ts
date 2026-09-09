/**
 * The never-validated OSS spec backlog, derived rather than hand-listed.
 * Design: `docs/triage/inherited-spec-triage-design.md` §1.
 *
 * `classifyBacklog` is pure and cannot throw: the baseline writer, the `--grep`
 * builder and the ownership guard all read the same population, and a predicate
 * that could fail differently in three places is three populations.
 *
 * Reads `collectDeclaredTests()` (`./stable-tests.ts`) -- the parser #1746's
 * orphan reconciler landed with, upstream of this module -- rather than a
 * second AST walker of its own; keeping both would be exactly the #985 drift
 * this file exists to avoid. The two never disagreed on POPULATION, only on
 * shape: the same four-clause predicate evaluated against this parser's
 * output over the real suite returns the identical 55 specs / 92 tests as the
 * walker it replaced. Two measured exposures of the switch, both zero
 * occurrences today: `collectDeclaredTests()` does not admit `.only` /
 * `.fail` / `.slow` declarations at all (confirmed empty:
 * `grep -rnoE '^\s*test\.(only|fail|slow)\(\s*"' tests/tests-automations/regression`),
 * and it inherits only its OWN three lane tags (`@destructive` / `@enterprise`
 * / `@serving`) from an enclosing `test.describe` -- a describe tagged
 * `@authz` / `@sso` / `@governance` alone would not reach a test's `tags`
 * here. The corpus has zero describes carrying any lane tag at all today, so
 * nothing currently relies on that inheritance either way.
 */
import * as fs from "fs";
import * as path from "path";
import {
  REGRESSION_ROOT, REPO_ROOT, STABLE_TAG, type DeclaredTest, collectDeclaredTests,
} from "./stable-tests";

/**
 * Lane selectors. A test carrying one of these has NO scheduled lane, so
 * `@stable` would make it run nowhere at all, silently (#1010) -- absence of the
 * tag is the correct state and never debt. Excluded by construction, and pinned
 * by a test, so a later edit cannot widen this population onto Enterprise.
 *
 * Deliberately NOT `stable-tests.ts`'s `LANE_TAGS` (3 tags -- `@destructive` /
 * `@enterprise` / `@serving`), and never merged into it, even though the two
 * lists overlap. They answer different questions over the same vocabulary:
 * `LANE_TAGS` feeds the #1746 reconciler's "was `@stable` REMOVED without an
 * owner", which walks git history -- a test that never carried the tag is not
 * a removal, so that list only needs to name what an OWNED removal could look
 * like. This module asks "never had it at all", which needs every lane a test
 * could legitimately have no `@stable` for, `@authz` / `@sso` / `@governance`
 * included. Widening `LANE_TAGS` to 6 would change the reconciler's behaviour
 * for a question that belongs to this module, not to it -- so the two lists
 * stay separate, in their own modules, on purpose.
 */
export const LANE_SELECTORS = [
  "@destructive", "@enterprise", "@authz", "@sso", "@serving", "@governance",
] as const;

export interface SpecFacts { hasMirroredDoc: boolean; hasIdScopedCleanup: boolean }
export interface BacklogTest { title: string; modifier: string; tags: string[]; line: number }
export interface BacklogSpec {
  relativePath: string;
  tier: "T1" | "T2";
  hasMirroredDoc: boolean;
  hasIdScopedCleanup: boolean;
  tests: BacklogTest[];
}
export interface Backlog {
  specs: BacklogSpec[];
  testCount: number;
  /**
   * Titles that more than one DECLARATION in the suite carries — both classes,
   * because `build-triage-grep.mjs` refuses on this field and its refusal is
   * about anchoring being unable to tell two identically-titled tests apart:
   *
   *  1. **in-scope ↔ out-of-scope** — the `--grep` fragment for a backlog title
   *     would also select a test outside the 92-test population;
   *  2. **in-scope ↔ in-scope** — two backlog tests share a title. This one was
   *     invisible until the final fix wave, and it is silent in three places at
   *     once: `baselineTitles` dedupes it away (so the fragment selects both
   *     tests under one alternative), `rowsFor` renders two IDENTICAL rows, and
   *     `verdictFor` folds both tests' observations into a single verdict —
   *     a green one masking a red one, with nothing saying so.
   *
   * Zero of either class today, so recording the second changes no data; it is
   * pinned by a unit test rather than by the corpus, exactly because a corpus
   * with zero instances cannot pin a guard against them.
   */
  titleCollisions: string[];
}

/**
 * A declaration counts as `@stable` only when `@stable` REACHES it (its own
 * tag array, or inherited from an enclosing `test.describe` --
 * `DeclaredTest.stable`) AND it is not quarantined before its body runs
 * (`!DeclaredTest.fixme`, which collapses `test.fixme(...)` and the declaring
 * `test.skip(...)`).
 *
 * `test.stable` alone is not enough: a `test.fixme("x", { tag: ["@stable"] })`
 * has `stable: true` but runs in no lane whatever its tags claim. This is the
 * SAME rule `parseStableTests` uses (`./stable-tests.ts`, via its
 * `modifier === "" && tags.includes(STABLE_TAG)` filter over the same AST) --
 * `test.stable && !test.fixme` is that predicate's exact equivalent over
 * `DeclaredTest`'s shape, and it is what the QA-CHECKLIST generator and the
 * checklist guard both, transitively, read. Do not simplify this to
 * `test.stable` -- that would give the suite's single most load-bearing tag a
 * second, looser definition inside the one module whose entire justification
 * is that there is only one (Task 2 review, ruling P7). A quarantined
 * declaration belongs in THIS backlog, and the design's PARK outcome is how
 * it exits.
 */
function isStable(test: DeclaredTest): boolean {
  return test.stable && !test.fixme;
}

export function classifyBacklog(
  all: DeclaredTest[],
  facts: (relativePath: string) => SpecFacts,
): Backlog {
  // Clause 4: no test in the same file is @stable.
  const stableFiles = new Set(
    all.filter(isStable).map((t) => t.relativePath),
  );
  const lanes = new Set<string>(LANE_SELECTORS);
  const inScope = all.filter(
    (t) =>
      // Clause 2: this declaration itself does not carry @stable.
      !isStable(t) &&
      // Clause 3: no lane selector.
      !t.tags.some((g) => lanes.has(g)) &&
      // Clause 4, applied.
      !stableFiles.has(t.relativePath),
  );

  // Both collision classes (see `Backlog.titleCollisions`). Counting per title
  // over the WHOLE suite answers both at once: a title carried by two or more
  // declarations, at least one of them in scope, is a collision whichever side
  // the other declaration sits on.
  const inScopeTitles = new Set(inScope.map((t) => t.title));
  const countsByTitle = new Map<string, number>();
  for (const t of all) {
    if (!inScopeTitles.has(t.title)) continue;
    countsByTitle.set(t.title, (countsByTitle.get(t.title) ?? 0) + 1);
  }
  const titleCollisions = [...countsByTitle]
    .filter(([, n]) => n > 1)
    .map(([title]) => title)
    .sort();

  const byFile = new Map<string, DeclaredTest[]>();
  for (const t of inScope) {
    const list = byFile.get(t.relativePath) ?? [];
    list.push(t);
    byFile.set(t.relativePath, list);
  }

  const specs: BacklogSpec[] = [...byFile.keys()].sort().map((relativePath) => {
    const f = facts(relativePath);
    return {
      relativePath,
      tier: !f.hasMirroredDoc && !f.hasIdScopedCleanup ? "T2" : "T1",
      hasMirroredDoc: f.hasMirroredDoc,
      hasIdScopedCleanup: f.hasIdScopedCleanup,
      tests: byFile
        .get(relativePath)!
        .slice()
        .sort((a, b) => a.line - b.line)
        .map(({ title, modifier, tags, line }) => ({ title, modifier, tags, line })),
    };
  });

  return { specs, testCount: inScope.length, titleCollisions };
}

/** Mirrored-doc lookup and cleanup style, read from disk. */
export function specFactsFromDisk(relativePath: string): SpecFacts {
  const docPath = path.join(REPO_ROOT, "docs", relativePath.replace(/\.spec\.ts$/, ".md"));
  const src = fs.readFileSync(path.join(REGRESSION_ROOT, relativePath), "utf8");
  return {
    hasMirroredDoc: fs.existsSync(docPath),
    // Presence of an id-scoped delete. Deliberately a substring test rather than
    // a parse: the question is "was scoped teardown written at all", and a false
    // positive only moves a spec from T2 to T1, where the reviewer reads it anyway.
    hasIdScopedCleanup: /deleteFlow|delete-flow/.test(src),
  };
}

/**
 * Fails loudly rather than letting `collectBacklog()` compute a silently
 * incomplete population. `classifyBacklog` above must stay pure and never
 * throw -- three downstream consumers (the baseline writer, the `--grep`
 * builder, the ownership guard) all read it, and a predicate that could fail
 * differently in each one is three populations -- so the warning check lives
 * on the IO shell instead. Exported so this behaviour is unit-testable
 * without needing a real unparseable declaration in the corpus (there are
 * none today).
 *
 * `collectDeclaredTests()` carries no suite-level warnings array of its own --
 * unlike this module's retired `collectTaggedTests()`, an unreadable `tag`
 * option is recorded PER DECLARATION (`DeclaredTest.unparseableTags`), which
 * is exactly how `stable-orphans.ts`'s #1746 reconciler treats it: a
 * per-test `state: "unknown"`, never a crash -- the right call for a
 * reconciler that must still report on the tests it CAN read. This function
 * wants the opposite: a `tag` array this parser cannot read might be hiding
 * an `@stable` tag on that declaration or on another one in the SAME file,
 * either of which would silently flip clause 2 or clause 4's answer -- so it
 * checks every declaration across the whole suite, not only the in-scope
 * ones, the same width `collectTaggedTests()`'s warnings array had.
 */
export function assertNoWarnings(tests: readonly DeclaredTest[]): void {
  const unparseable = tests.filter((t) => t.unparseableTags);
  if (unparseable.length === 0) return;
  for (const t of unparseable) {
    console.error(
      `  • ${t.relativePath}:${t.line} — \`tag\` option is not an inline array of string literals`,
    );
  }
  throw new Error(
    `collectBacklog(): collectDeclaredTests() reported ${unparseable.length} declaration(s) with an ` +
      "unparseable `tag` option (printed above). Computing the backlog anyway could silently " +
      "miscount it, so this IO shell refuses instead of dropping them.",
  );
}

export function collectBacklog(): Backlog {
  const tests = collectDeclaredTests();
  assertNoWarnings(tests);
  return classifyBacklog(tests, specFactsFromDisk);
}
