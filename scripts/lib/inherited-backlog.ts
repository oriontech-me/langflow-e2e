/**
 * The never-validated OSS spec backlog, derived rather than hand-listed.
 * Design: `docs/triage/inherited-spec-triage-design.md` §1.
 *
 * `classifyBacklog` is pure and cannot throw: the baseline writer, the `--grep`
 * builder and the ownership guard all read the same population, and a predicate
 * that could fail differently in three places is three populations.
 */
import * as fs from "fs";
import * as path from "path";
import {
  REGRESSION_ROOT, REPO_ROOT, STABLE_TAG, type TaggedTest, collectTaggedTests,
} from "./stable-tests";

/**
 * Lane selectors. A test carrying one of these has NO scheduled lane, so
 * `@stable` would make it run nowhere at all, silently (#1010) -- absence of the
 * tag is the correct state and never debt. Excluded by construction, and pinned
 * by a test, so a later edit cannot widen this population onto Enterprise.
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
 * A declaration counts as `@stable` only when it is a PLAIN `test(...)` --
 * `modifier === ""`, i.e. no `.fixme` / `.skip` / `.only` / `.fail` / `.slow`
 * -- whose tags include the literal tag. This is the SAME rule
 * `parseStableTests` uses (`./stable-tests.ts`), which is what the
 * QA-CHECKLIST generator and the checklist guard both read.
 *
 * A `test.fixme("x", { tag: ["@stable"] })` is therefore NOT `@stable` to this
 * repo: it runs in no lane whatever its tags claim. Do not simplify this to
 * `tags.includes(STABLE_TAG)` -- that would give the suite's single most
 * load-bearing tag a second, looser definition inside the one module whose
 * entire justification is that there is only one (Task 2 review, ruling P7).
 * A quarantined declaration belongs in THIS backlog, and the design's PARK
 * outcome is how it exits.
 */
function isStable(test: TaggedTest): boolean {
  return test.modifier === "" && test.tags.includes(STABLE_TAG);
}

export function classifyBacklog(
  all: TaggedTest[],
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

  const byFile = new Map<string, TaggedTest[]>();
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
 * without needing a real parse warning in the corpus (there are none today).
 */
export function assertNoWarnings(warnings: readonly string[]): void {
  if (warnings.length === 0) return;
  for (const w of warnings) console.error(`  • ${w}`);
  throw new Error(
    `collectBacklog(): collectTaggedTests() reported ${warnings.length} parse ` +
      "warning(s) (printed above). Computing the backlog anyway could silently " +
      "miscount it, so this IO shell refuses instead of dropping them.",
  );
}

export function collectBacklog(): Backlog {
  const { tests, warnings } = collectTaggedTests();
  assertNoWarnings(warnings);
  return classifyBacklog(tests, specFactsFromDisk);
}
