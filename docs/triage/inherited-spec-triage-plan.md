# Inherited Spec Triage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the tooling that measures the 55 never-validated OSS specs, publishes a per-test triage verdict, and prevents the backlog from regrowing silently.

**Architecture:** One AST parser already exists for `@stable` (`scripts/lib/stable-tests.ts`); it is widened to return *every* tagged declaration, and a pure predicate module derives the backlog and its two tiers from that. Everything else is a thin shell over pure functions: a baseline writer, a `--grep` fragment builder, a report-to-table renderer, and an ownership guard. The measurement itself is **nine** `manual.yml` dispatches — three passes over three shards — whose JSON reports the renderer consumes.

> ### ⚠️ Status, 2026-09-09: Tasks 1–7 are IMPLEMENTED; the code is the authority
>
> The design (`docs/triage/inherited-spec-triage-design.md`) is binding, and the
> shipped code under `scripts/` is what actually ran. **Tasks 1, 2, 3, 4 and 6
> carry a per-task superseded note** over their code blocks: each of those five
> shipped a deviation from the literal block below, every deviation was forced
> by a measurement or a review, and the reasoning lives in the design plus the
> functions' own docblocks. The blocks are marked stale rather than rewritten,
> deliberately — a half-updated code block is worse than one honestly labelled.
>
> **Tasks 8–9 (the ownership guard and its wiring) have NOT been implemented**
> and their steps are current. Two things to carry into them: the runbook now
> verifies a selection as a **set** (`npm run triage:verify`), never by counting
> to 92; and every test gets **three** observations, so there is no red-only
> re-dispatch step.

**Tech Stack:** TypeScript (`ts-node`, TypeScript compiler API) for anything touching spec ASTs; dependency-free `.mjs` for anything a workflow calls directly; `node --test` for both lanes; GitHub Actions; `gh` CLI.

**Spec:** `docs/triage/inherited-spec-triage-design.md`

## Global Constraints

- **English only**, everywhere — test names, `test.step` labels, comments, docs, workflow comments, issue bodies. Non-negotiable repo rule.
- **A unit test goes next to the code it covers**: `scripts/lib/x.ts` → `scripts/lib/x.test.ts`; `scripts/y.mjs` → `scripts/y.test.mjs`. `npm run test:units` globs `scripts/**/*.test.ts` and `tests/**/*.test.ts`; `npm run test:scripts` globs `scripts/**/*.test.mjs`. Both gate every PR.
- **Never validate a helper in a scratch file outside the repo.**
- **No verdict is ever silence.** An input a script cannot read, a lookup that fails, a population it cannot classify: report `UNKNOWN` with the reason named, and fail rather than degrade to a pass.
- **Zero executed tests is an abort, not a clean run.** Any consumer of a Playwright report must read `stats` and treat a total of 0 as an error.
- **This worktree has no `node_modules`.** Symlink it once before running anything: `ln -sfn /Users/rafael/Documents/langflow-e2e/node_modules node_modules` (gitignored, so it never shows in `git status`).
- **Scope is OSS.** Lane selectors (`@destructive`, `@enterprise`, `@authz`, `@sso`, `@serving`, `@governance`) are excluded by construction and that exclusion is pinned by a test.
- Out of scope for this plan, by construction: the Phase 2 cause-clustered batches. Their content is the measurement's output, so they get their own plan once the table lands.


## How this becomes issues

This plan is the content of **two** issues, not nine. The cut follows Wave 7,
which is this repo's measured precedent for work of exactly this shape: #1692
shipped an entire instrument as one issue — a committed baseline, a drift verdict
in `globalSetup`, a fixture, an npm script, **and** the `files` family closed as
its pilot — and its five siblings were then filed off that instrument's own gap
ranking. Recent waves carry 6 (Wave 7) to 10 (Wave 6) issues, and they got there
by making issues bigger, not more numerous.

| Issue | Labels | Tasks | Branch |
|---|---|---|---|
| **A** — the triage instrument, with the measurement as its pilot | `qa-infra`, `roadmap` | 1–7 | one branch, one PR |
| **B** — the `@stable` ownership guard | `qa-infra`, `roadmap` | 8–9 | one branch, one PR |

Tasks 1–3 are deliberately **not** their own issues: a predicate with no consumer
gives a reviewer nothing to approve or reject, and the pipeline gates one issue
per branch, so nine issues would mean nine PRs for one instrument.

Three consequences for whoever executes this:

- **The measurement (Task 7) ships inside issue A's PR**, the way #1692's pilot
  did. It is what proves the instrument end to end, and splitting it out would
  make a second PR whose only content is a generated file.
- **Every branch in Task 7 forks issue A's branch**, not `main`: the dispatched
  ref has to carry Task 5's `results.json`, which `main` does not have yet.
- **The pipeline's IMPLEMENT step needs every deliverable listed**, not just the
  specs — an unlisted file makes the PR gate demand `extraFiles` plus a reason.
  Each task's **Files** block is that list; issue A's is the union of Tasks 1–7's,
  including the two generated artifacts (`tests/assets/triage/inherited-backlog-baseline.json`
  and `docs/triage/inherited-spec-triage.md`) and the `package.json` script entries.

The cause-clustered batches are issues C..N, filed off the committed verdict
table once issue A lands — largest cluster first, one table row per test, the
measured finding in the title, mirroring #1699/#1700/#1707. They are not planned
here because their content is issue A's output.

---

### Task 1: One parser for every tagged declaration

`scripts/lib/stable-tests.ts` already walks the specs and reads inline `tag:` arrays, but it only ever returns the `@stable` ones. Two parsers that are supposed to agree about what a tag is would be exactly the drift issue #985 was raised about, so the backlog predicate is built on this one — widened, not copied.

> ⚠️ **SUPERSEDED — Task 1 is implemented, and its `CollectTaggedResult` below
> is missing the field the fix needed.** Widening the walk to five declaration
> modifiers also widened the **warning** channel, and both consumers of
> `parseStableTests` are fail-closed on a warning
> (`scripts/check-checklist-coverage.ts` exits 1 on any), so the first
> `test.skip(..., { tag: SHARED_TAGS })` anyone wrote would have failed every
> PR — with a remediation that a modified declaration cannot satisfy. A warning
> now carries the modifier it is about (`ParseWarning` / `warningDetails`), and
> `parseStableTests` forwards only the ones that bear on the `@stable`
> population. `warnings: string[]` is unchanged for every existing caller.

**Files:**
- Modify: `scripts/lib/stable-tests.ts`
- Test: `scripts/lib/stable-tests.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  ```ts
  export interface TaggedTest {
    title: string;
    tags: string[];
    /** "" for a plain `test(...)`; otherwise "fixme" | "skip" | "fail" | "only" | "slow". */
    modifier: string;
    modulePath: string;
    specFile: string;
    relativePath: string;
    line: number;
  }
  export interface CollectTaggedResult { tests: TaggedTest[]; warnings: string[] }
  export function parseTaggedTests(relativePath: string, source: string): CollectTaggedResult;
  export function collectTaggedTests(): CollectTaggedResult;
  ```
  `collectStableTests()` keeps its current signature and `StableTest` shape exactly — it becomes a filter over `collectTaggedTests()`.

- [ ] **Step 1: Write the failing tests**

Append to `scripts/lib/stable-tests.test.ts`:

```ts
import { parseTaggedTests } from "./stable-tests";

test("parseTaggedTests reads a plain tagged declaration", () => {
  const src = `test("a title", { tag: ["@release", "@api"] }, async () => {});`;
  const { tests, warnings } = parseTaggedTests("area/x.spec.ts", src);
  assert.equal(warnings.length, 0);
  assert.deepEqual(tests, [{
    title: "a title",
    tags: ["@release", "@api"],
    modifier: "",
    modulePath: "area",
    specFile: "x.spec.ts",
    relativePath: "area/x.spec.ts",
    line: 1,
  }]);
});

test("parseTaggedTests records the modifier of a quarantined declaration", () => {
  const src = `test.fixme("blocked", { tag: ["@release"] }, async () => {});`;
  const { tests } = parseTaggedTests("area/x.spec.ts", src);
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
  const { tests } = parseTaggedTests("area/x.spec.ts", src);
  assert.equal(tests.length, 1);
  assert.equal(tests[0].title, "real");
});

test("parseTaggedTests warns on a tag array it cannot read", () => {
  const src = `test("t", { tag: SHARED_TAGS }, async () => {});`;
  const { tests, warnings } = parseTaggedTests("area/x.spec.ts", src);
  assert.equal(tests.length, 0);
  assert.match(warnings[0], /not an inline array/);
});

test("parseTaggedTests preserves a template-literal title", () => {
  const src = "test(`agent [${label}]`, { tag: [\"@release\"] }, async () => {});";
  const { tests } = parseTaggedTests("area/x.spec.ts", src);
  assert.equal(tests[0].title, "agent [${label}]");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
node --require ts-node/register --test scripts/lib/stable-tests.test.ts
```
Expected: FAIL — `parseTaggedTests is not a function`. The pre-existing tests in the file must still pass; they are the regression pin for `collectStableTests`.

- [ ] **Step 3: Widen the parser**

In `scripts/lib/stable-tests.ts`, add the modifier matcher and the general parse, then re-express the stable collector on top of it:

```ts
/** Match `test(...)` and its declaration modifiers — never `test.describe`, never `test.step`. */
const DECLARATION_RE = /^test(?:\.(fixme|skip|only|fail|slow))?$/;

export interface TaggedTest {
  title: string;
  tags: string[];
  modifier: string;
  modulePath: string;
  specFile: string;
  relativePath: string;
  line: number;
}
export interface CollectTaggedResult { tests: TaggedTest[]; warnings: string[] }

export function parseTaggedTests(relativePath: string, sourceText: string): CollectTaggedResult {
  const source = ts.createSourceFile(relativePath, sourceText, ts.ScriptTarget.Latest, true);
  const tests: TaggedTest[] = [];
  const warnings: string[] = [];
  const modulePath = path.dirname(relativePath);
  const specFile = path.basename(relativePath);

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && isDescribeCall(node) && node.arguments.length >= 2) {
      const { tags } = readTagsArray(node.arguments[1]);
      if (tags?.includes(STABLE_TAG)) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        warnings.push(
          `${relativePath}:${line + 1} — \`@stable\` is declared on a \`test.describe\` block. ` +
            "Playwright applies it to every test inside, but this parser only reads per-`test()` " +
            "tags, so those tests would run in the daily while staying out of Phase 0 and the " +
            "checklist guard. Move `@stable` onto each `test(...)` call.",
        );
      }
    }
    if (ts.isCallExpression(node)) {
      const m = DECLARATION_RE.exec(node.expression.getText());
      if (m && node.arguments.length >= 2) {
        const title = literalText(node.arguments[0]);
        const { tags, unparseable } = readTagsArray(node.arguments[1]);
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        if (unparseable) {
          warnings.push(
            `${relativePath}:${line + 1} — \`tag\` option is not an inline array of string literals; ` +
              "the script cannot determine if this test is `@stable`. Inline the array " +
              '(e.g. `tag: ["@stable", ...]`) so it shows up in Phase 0.',
          );
        }
        // A `tag` array is what makes this a DECLARATION rather than an in-body
        // `test.skip(cond, msg)` guard, which also carries two arguments.
        if (title !== null && tags) {
          tests.push({
            title, tags, modifier: m[1] ?? "",
            modulePath, specFile, relativePath, line: line + 1,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return { tests, warnings };
}

export function collectTaggedTests(): CollectTaggedResult {
  const tests: TaggedTest[] = [];
  const warnings: string[] = [];
  for (const abs of walkSpecs(REGRESSION_ROOT).sort()) {
    const relativePath = path.relative(REGRESSION_ROOT, abs).split(path.sep).join("/");
    const r = parseTaggedTests(relativePath, fs.readFileSync(abs, "utf8"));
    tests.push(...r.tests);
    warnings.push(...r.warnings);
  }
  return { tests, warnings };
}
```

Then replace the body of `collectStableTests()` with a filter, keeping its return type:

```ts
export function collectStableTests(): CollectResult {
  const { tests, warnings } = collectTaggedTests();
  return {
    tests: tests
      .filter((t) => t.tags.includes(STABLE_TAG))
      .map(({ title, modulePath, specFile, relativePath, line }) => ({
        title, modulePath, specFile, relativePath, line,
      })),
    warnings,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass, and that nothing else moved**

```bash
node --require ts-node/register --test scripts/lib/stable-tests.test.ts && \
npx ts-node scripts/stable-tests.ts && git diff --stat QA-CHECKLIST.md
```
Expected: all tests PASS, and `git diff --stat QA-CHECKLIST.md` prints **nothing** — the generator is idempotent, so a changed `@stable` count would mean the refactor changed behaviour. If the diff is non-empty, the filter is wrong; do not commit.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/stable-tests.ts scripts/lib/stable-tests.test.ts
git commit -m "refactor(stable-tests): return every tagged declaration, not only @stable

The backlog predicate needs the untagged-by-@stable population, and a second
parser that had to agree with this one about what a tag is would be the #985
drift by construction. \`collectStableTests\` becomes a filter over the new
\`collectTaggedTests\`, so the QA-CHECKLIST generator's output is unchanged --
pinned by regenerating it and asserting an empty diff.

The in-body \`test.skip(cond, msg)\` guard is the trap this parser has to avoid:
it also carries two arguments, and counting it as a declaration inflates
llm-agents alone by 96.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: The backlog predicate and its two tiers

> ⚠️ **SUPERSEDED — Task 2 is implemented; `titleCollisions` records more than
> the block below computes.** Step 3's version records only in-scope ↔
> out-of-scope collisions; the shipped `classifyBacklog` also records **two
> in-scope tests sharing a title**, which is silent in three places at once (the
> title list dedupes it, the table renders two identical rows, and their
> observations fold into one verdict where a green can mask a red). Zero
> collisions of either class today. See `Backlog.titleCollisions` in
> `scripts/lib/inherited-backlog.ts`, and the design's §2.

**Files:**
- Create: `scripts/lib/inherited-backlog.ts`
- Test: `scripts/lib/inherited-backlog.test.ts`

**Interfaces:**
- Consumes: `TaggedTest`, `collectTaggedTests` from Task 1.
- Produces:
  ```ts
  export const LANE_SELECTORS: readonly string[];
  export interface SpecFacts { hasMirroredDoc: boolean; hasIdScopedCleanup: boolean }
  export interface BacklogTest { title: string; modifier: string; tags: string[]; line: number }
  export interface BacklogSpec {
    relativePath: string; tier: "T1" | "T2";
    hasMirroredDoc: boolean; hasIdScopedCleanup: boolean;
    tests: BacklogTest[];
  }
  export interface Backlog { specs: BacklogSpec[]; testCount: number; titleCollisions: string[] }
  export function classifyBacklog(all: TaggedTest[], facts: (rel: string) => SpecFacts): Backlog;
  export function collectBacklog(): Backlog;   // IO shell: ASTs + fs facts
  ```

- [ ] **Step 1: Write the failing tests**

Create `scripts/lib/inherited-backlog.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyBacklog, LANE_SELECTORS } from "./inherited-backlog";
import type { TaggedTest } from "./stable-tests";

function t(relativePath: string, title: string, tags: string[], line = 1): TaggedTest {
  const parts = relativePath.split("/");
  return {
    title, tags, modifier: "", line, relativePath,
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
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
node --require ts-node/register --test scripts/lib/inherited-backlog.test.ts
```
Expected: FAIL — cannot find module `./inherited-backlog`.

- [ ] **Step 3: Write the module**

Create `scripts/lib/inherited-backlog.ts`:

```ts
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
export interface Backlog { specs: BacklogSpec[]; testCount: number; titleCollisions: string[] }

export function classifyBacklog(
  all: TaggedTest[],
  facts: (relativePath: string) => SpecFacts,
): Backlog {
  const stableFiles = new Set(
    all.filter((t) => t.tags.includes(STABLE_TAG)).map((t) => t.relativePath),
  );
  const lanes = new Set<string>(LANE_SELECTORS);
  const inScope = all.filter(
    (t) =>
      !t.tags.includes(STABLE_TAG) &&
      !t.tags.some((g) => lanes.has(g)) &&
      !stableFiles.has(t.relativePath),
  );

  const inScopeSet = new Set(inScope);
  const inScopeTitles = new Set(inScope.map((t) => t.title));
  const titleCollisions = [
    ...new Set(
      all.filter((t) => !inScopeSet.has(t) && inScopeTitles.has(t.title)).map((t) => t.title),
    ),
  ].sort();

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

export function collectBacklog(): Backlog {
  return classifyBacklog(collectTaggedTests().tests, specFactsFromDisk);
}
```

- [ ] **Step 4: Run the tests to verify they pass, then sanity-check against the real suite**

```bash
node --require ts-node/register --test scripts/lib/inherited-backlog.test.ts && \
npx ts-node -e 'const {collectBacklog}=require("./scripts/lib/inherited-backlog");const b=collectBacklog();console.log("specs",b.specs.length,"tests",b.testCount,"T1",b.specs.filter(s=>s.tier==="T1").length,"T2",b.specs.filter(s=>s.tier==="T2").length,"collisions",b.titleCollisions.length)'
```
Expected: tests PASS, and the sanity check prints `specs 55 tests 92 T1 26 T2 29 collisions 0`. A different count is not automatically wrong — the suite moves — but a difference on the day this lands means the predicate disagrees with the design's measurement and must be explained before Task 3.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/inherited-backlog.ts scripts/lib/inherited-backlog.test.ts
git commit -m "feat(triage): derive the never-validated OSS spec backlog from the ASTs

Four clauses, per the design's §1: not @stable, no lane selector, and no
@stable test anywhere in the same file -- the last one is what separates this
population from #1746's, where the tag was removed per test and has a
restoration to reconcile.

Lane selectors are excluded by construction and the exclusion is pinned per
selector, because Enterprise is the largest zero-@stable population in the repo
(88 tests) and its absence of the tag is correct rather than debt (#1010).

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Freeze the inventory

The wave needs a fixed target and the guard needs something to diff against. The floor exists for the same reason the catalog baseline has one: a wrong baseline is permanent and silent, while a small-but-real population is drift a human should still see.

> ⚠️ **SUPERSEDED — Task 3 is implemented; read the shipped code, not this
> block.** Two fixes landed after this plan was written, and Step 3's code below
> shows neither. (a) The `--min-specs` floor is parsed by the shared
> `parseNumericArg` (`scripts/lib/numeric-arg.ts`), not by `Number(...)`: on an
> empty, non-numeric or negative value the old form yielded `NaN` — a value
> `current.specs.length < minSpecs` can never be true for — so the floor
> silently no-opped instead of refusing. (b) `renderBaseline` sorts by **code
> units**, not `localeCompare`: this is a committed artifact whose `--check`
> compares exact bytes, and ICU folds case. The design records the reasoning;
> the code and its tests are the authority.

**Files:**
- Create: `scripts/update-inherited-backlog-baseline.ts`
- Create: `tests/assets/triage/inherited-backlog-baseline.json` (written by the script)
- Test: `scripts/update-inherited-backlog-baseline.test.ts`
- Modify: `package.json` (add `triage:baseline`)

**Interfaces:**
- Consumes: `collectBacklog`, `Backlog` from Task 2.
- Produces:
  ```ts
  export interface BaselineFile { version: 1; specs: BacklogSpec[]; testCount: number; titleCollisions: string[] }
  export function renderBaseline(b: Backlog): string;                       // stable, sorted JSON + trailing newline
  export function diffBaseline(committed: BaselineFile | null, current: Backlog):
    { added: string[]; removed: string[]; changed: string[] };
  ```

- [ ] **Step 1: Write the failing tests**

Create `scripts/update-inherited-backlog-baseline.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderBaseline, diffBaseline } from "./update-inherited-backlog-baseline";
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
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
node --require ts-node/register --test scripts/update-inherited-backlog-baseline.test.ts
```
Expected: FAIL — cannot find module `./update-inherited-backlog-baseline`.

- [ ] **Step 3: Write the script**

Create `scripts/update-inherited-backlog-baseline.ts`:

```ts
/**
 * Writes (or verifies) the frozen inventory of the never-validated OSS spec
 * backlog: `tests/assets/triage/inherited-backlog-baseline.json`.
 *
 *   npm run triage:baseline              # write
 *   npm run triage:baseline -- --check   # exit 1 on any drift, printing it
 *
 * The floor (`--min-specs`, default 10) refuses to write an implausibly small
 * baseline. A wrong baseline is permanent and silent -- the guard in
 * `check-stable-ownership.ts` reads it as the set of specs that are ALLOWED to
 * be unowned, so an empty one silently exempts the whole suite.
 */
import * as fs from "fs";
import * as path from "path";
import { REPO_ROOT } from "./lib/stable-tests";
import { collectBacklog, type Backlog, type BacklogSpec } from "./lib/inherited-backlog";

export const BASELINE_PATH = path.join(
  REPO_ROOT, "tests", "assets", "triage", "inherited-backlog-baseline.json",
);

export interface BaselineFile {
  version: 1;
  specs: BacklogSpec[];
  testCount: number;
  titleCollisions: string[];
}

export function renderBaseline(b: Backlog): string {
  const file: BaselineFile = {
    version: 1,
    specs: b.specs.slice().sort((x, y) => x.relativePath.localeCompare(y.relativePath)),
    testCount: b.testCount,
    titleCollisions: b.titleCollisions.slice().sort(),
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}

export function diffBaseline(committed: BaselineFile | null, current: Backlog) {
  const before = new Map((committed?.specs ?? []).map((s) => [s.relativePath, s]));
  const after = new Map(current.specs.map((s) => [s.relativePath, s]));
  const added = [...after.keys()].filter((k) => !before.has(k)).sort();
  const removed = [...before.keys()].filter((k) => !after.has(k)).sort();
  const changed = [...after.keys()]
    .filter((k) => {
      const a = before.get(k);
      const b = after.get(k)!;
      return a !== undefined && JSON.stringify(a) !== JSON.stringify(b);
    })
    .sort();
  return { added, removed, changed };
}

function readCommitted(): BaselineFile | null {
  try {
    return JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8")) as BaselineFile;
  } catch {
    return null;
  }
}

function main(argv: string[]): number {
  const check = argv.includes("--check");
  const minArg = argv.find((a) => a.startsWith("--min-specs="));
  const minSpecs = minArg ? Number(minArg.split("=")[1]) : 10;
  const current = collectBacklog();

  if (current.specs.length < minSpecs) {
    console.error(
      `[triage-baseline] refusing: derived ${current.specs.length} spec(s), below the floor of ` +
        `${minSpecs}. The guard reads this file as the set allowed to be unowned, so an ` +
        "implausibly small baseline silently exempts the suite. Pass --min-specs=<n> " +
        "deliberately if the backlog really has shrunk this far.",
    );
    return 1;
  }

  const rendered = renderBaseline(current);
  const committed = readCommitted();

  if (check) {
    const d = diffBaseline(committed, current);
    const drifted = d.added.length + d.removed.length + d.changed.length;
    if (drifted === 0) {
      console.log(
        `[triage-baseline] in sync: ${current.specs.length} spec(s), ${current.testCount} test(s).`,
      );
      return 0;
    }
    console.error("[triage-baseline] baseline is stale:");
    for (const s of d.added) console.error(`  + ${s} (entered the backlog)`);
    for (const s of d.removed) console.error(`  - ${s} (left the backlog)`);
    for (const s of d.changed) console.error(`  ~ ${s} (tier, tests or facts changed)`);
    console.error("Run `npm run triage:baseline` and commit the result.");
    return 1;
  }

  fs.mkdirSync(path.dirname(BASELINE_PATH), { recursive: true });
  fs.writeFileSync(BASELINE_PATH, rendered);
  console.log(
    `[triage-baseline] wrote ${current.specs.length} spec(s) / ${current.testCount} test(s) ` +
      `to ${path.relative(REPO_ROOT, BASELINE_PATH)}` +
      (current.titleCollisions.length
        ? ` — WARNING: ${current.titleCollisions.length} title collision(s) recorded; ` +
          "the --grep selector will refuse to build until they are resolved."
        : ""),
  );
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
```

Add to `package.json` `scripts`, after `catalog:baseline`:

```json
"triage:baseline": "ts-node scripts/update-inherited-backlog-baseline.ts",
```

- [ ] **Step 4: Run the tests, write the baseline, and verify `--check` is quiet**

```bash
node --require ts-node/register --test scripts/update-inherited-backlog-baseline.test.ts && \
npm run triage:baseline && npm run triage:baseline -- --check
```
Expected: tests PASS; the write prints `wrote 55 spec(s) / 92 test(s)`; `--check` prints `in sync` and exits 0.

- [ ] **Step 5: Commit**

```bash
git add scripts/update-inherited-backlog-baseline.ts scripts/update-inherited-backlog-baseline.test.ts \
        tests/assets/triage/inherited-backlog-baseline.json package.json
git commit -m "feat(triage): freeze the backlog inventory as a committed baseline

The wave needs a fixed target and the ownership guard needs a set of specs that
are allowed to be unowned. Both read this file, so it carries a floor: an
implausibly small baseline would silently exempt the whole suite, the same class
of permanent-and-silent error the component catalog baseline guards against.

No generated-at field, on purpose -- a timestamp makes every regeneration a
diff, which is how a committed baseline stops being reviewed.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Build the `--grep` fragments the measurement dispatches with

Playwright honours exactly one `--grep`, and `manual.yml` passes a lone `test_grep` fragment through `scripts/build-grep-filter.mjs` **verbatim**. So the fragment must be self-contained: its own non-capturing group, its own escaping. An unparenthesised alternation is what cost #1275 real coverage during a release validation.

> ⚠️ **SUPERSEDED — Task 4 is implemented, and its Step 3 code below is the
> version that FAILED its own Step 4.** Read `scripts/build-triage-grep.mjs` and
> the design's §2 instead. Three things changed, all of them load-bearing:
> (a) `escapeTitle` **anchors** as well as escapes — the naive version below
> selected **106** tests where 92 are wanted, because Playwright's `--grep`
> matches `TestCase._grepTitleWithTags()` (path + every describe title + the
> test's own title + its tags, space-joined), not the isolated title; whitespace
> anchoring alone still selected 97, and the tag-tail anchor closes the rest.
> The full argument is in that function's docblock. (b) The collision refusal is
> the exported, unit-tested `checkTitleCollisions`, not the `if` inlined in
> `main()` below — `main()` is CLI-only and `node --test` never reaches it.
> (c) A `--verify` mode exists (`npm run triage:verify`) that compares the
> selection as a SET. Marked stale rather than rewritten: a half-updated code
> block is worse than one honestly labelled.

**Files:**
- Create: `scripts/build-triage-grep.mjs`
- Test: `scripts/build-triage-grep.test.mjs`

**Interfaces:**
- Consumes: the baseline JSON from Task 3 (`specs[].tests[].title`, `titleCollisions`).
- Produces (ESM exports, plus a CLI):
  ```js
  export function escapeTitle(title)            // -> regex-safe string
  export function baselineTitles(baseline)      // -> string[] sorted, deduped
  export function shardTitles(titles, shards, shard)  // -> string[]  (1-based shard)
  export function buildFragment(titles)         // -> "(?:a|b|c)"
  ```
  CLI: `node scripts/build-triage-grep.mjs --baseline <path> --shards 3 --shard 2` prints one fragment on stdout and nothing else.

- [ ] **Step 1: Write the failing tests**

Create `scripts/build-triage-grep.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { escapeTitle, baselineTitles, shardTitles, buildFragment } from "./build-triage-grep.mjs";

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
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
node --test scripts/build-triage-grep.test.mjs
```
Expected: FAIL — cannot find module `./build-triage-grep.mjs`.

- [ ] **Step 3: Write the script**

Create `scripts/build-triage-grep.mjs`:

```js
#!/usr/bin/env node
/**
 * Emits ONE `--grep` fragment selecting a third of the never-validated backlog,
 * for a `manual.yml` dispatch (`test_grep`). Design: §2.
 *
 *   node scripts/build-triage-grep.mjs --shards 3 --shard 1
 *
 * `build-grep-filter.mjs` passes a single fragment VERBATIM, so everything the
 * selection needs has to be inside this string: the non-capturing group and the
 * escaping. An unparenthesised alternation is not ANDed as a unit -- #1275,
 * where a dispatch silently ran 48 of 81 tests with nothing saying so.
 */
import fs from "fs";

const META = /[.*+?^${}()|[\]\\]/g;

export function escapeTitle(title) {
  return String(title).replace(META, "\\$&");
}

export function baselineTitles(baseline) {
  const titles = (baseline?.specs ?? []).flatMap((s) => (s.tests ?? []).map((t) => t.title));
  return [...new Set(titles)].sort();
}

export function shardTitles(titles, shards, shard) {
  const n = Number(shards);
  const i = Number(shard);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--shards must be a positive integer, got ${shards}`);
  if (!Number.isInteger(i) || i < 1 || i > n) throw new Error(`--shard must be in 1..${n}, got ${shard}`);
  // Contiguous slices over a sorted list: the partition is reproducible from the
  // baseline alone, so a re-dispatch of "shard 2" selects the same tests.
  const size = Math.ceil(titles.length / n);
  return titles.slice((i - 1) * size, i * size);
}

export function buildFragment(titles) {
  if (!titles.length) {
    throw new Error(
      "refusing to emit an empty fragment: it compiles to a regex matching every test, " +
        "which would turn a narrowed dispatch into a full-suite run",
    );
  }
  return `(?:${titles.join("|")})`;
}

function arg(argv, name, fallback) {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split("=").slice(1).join("=");
  const idx = argv.indexOf(`--${name}`);
  return idx >= 0 && argv[idx + 1] ? argv[idx + 1] : fallback;
}

function main(argv) {
  const baselinePath = arg(argv, "baseline", "tests/assets/triage/inherited-backlog-baseline.json");
  const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
  if ((baseline.titleCollisions ?? []).length) {
    console.error(
      `[triage-grep] refusing: ${baseline.titleCollisions.length} title collision(s) recorded in ` +
        `${baselinePath}. A colliding title would pull an out-of-scope test into the measurement:\n  ` +
        baseline.titleCollisions.join("\n  "),
    );
    return 1;
  }
  const titles = shardTitles(baselineTitles(baseline), arg(argv, "shards", "3"), arg(argv, "shard", "1"));
  process.stdout.write(`${buildFragment(titles.map(escapeTitle))}\n`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    console.error(`[triage-grep] ${err.message}`);
    process.exit(1);
  }
}
```

- [ ] **Step 4: Run the tests, then verify the selection against Playwright itself**

```bash
node --test scripts/build-triage-grep.test.mjs && npm run triage:verify
```
Expected: tests PASS, then exit 0 and
`[triage-grep] verified set-exact: 92 wanted / 92 selected / 0 missing / 0 extra; shards 31/31/30`.

**A count is the wrong check, and this step used to prescribe it.** An earlier
revision asked only that "the three counts sum to 92 with no shard at 0" —
refuted by ruling P14 in its own words: *92 can be reached by dropping some and
adding others*. `--verify` compares `--list`'s selected `spec::title` **pairs**
against the baseline's, so the right title in the wrong file is one *missing*
plus one *extra*, and a shard that selected nothing is named by number even when
the total is right. `--list` runs nothing, so this verification is free and
needs no Langflow instance and no provider key.

If it is NOT set-exact, the anchoring is the first place to look — see
`escapeTitle`'s docblock: unanchored, these 92 titles selected **106** tests,
and whitespace anchoring alone still selected 97.

- [ ] **Step 5: Commit**

```bash
git add scripts/build-triage-grep.mjs scripts/build-triage-grep.test.mjs
git commit -m "feat(triage): build the measurement's --grep fragments from the baseline

Three contiguous shards over the sorted title list, so a re-dispatch of shard 2
selects the same tests. The fragment is self-contained -- its own (?:...) group
and its own escaping -- because build-grep-filter.mjs passes a lone fragment
verbatim, and an unparenthesised alternation is not ANDed as a unit (#1275).

Refuses three states rather than emitting something narrower than asked for: a
recorded title collision, an out-of-range shard, and an empty shard, whose empty
regex would match every test.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Make the shared E2E action emit a machine-readable report

`run-e2e` reports `html,github` and uploads only `playwright-report/`. The measurement needs a per-test status and a zero-test abort signal, and the daily already produces exactly that via `merge-reports --reporter=…,json` with `PLAYWRIGHT_JSON_OUTPUT_NAME`. Parsing the HTML report's embedded payload instead would tie the measurement to a format Playwright is free to change.

**Files:**
- Modify: `.github/actions/run-e2e/action.yml` (the `Run tests` step's `env` and `ARGS`; a new upload step after line 109)
- Test: `scripts/run-e2e-json-report.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: an artifact named `playwright-json-manual-<run_id>` containing `results.json`, for every lane that uses this action.

- [ ] **Step 1: Write the failing test**

Create `scripts/run-e2e-json-report.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const ACTION = fs.readFileSync(".github/actions/run-e2e/action.yml", "utf8");

test("the main run emits a JSON report to a file", () => {
  assert.match(ACTION, /--reporter=html,github,json/);
  // To a FILE. Without the output name Playwright writes the JSON to stdout,
  // which buries the run log and breaks any grep over it.
  assert.match(ACTION, /PLAYWRIGHT_JSON_OUTPUT_NAME:\s*results\.json/);
});

test("the destructive lane still reports github-only", () => {
  // It must not overwrite the HTML report the main run produced, and it must not
  // overwrite results.json either.
  assert.match(ACTION, /npx playwright test --pass-with-no-tests --reporter=github \\/);
});

test("results.json is uploaded", () => {
  assert.match(ACTION, /name: playwright-json-manual-\$\{\{ github\.run_id \}\}/);
  assert.match(ACTION, /path: results\.json/);
});
```

State the honest limit in a comment at the top of the file:

```js
// STRUCTURAL, and structural guards pin a SPELLING rather than a behaviour
// (#1226: every regex added over a workflow's text was then shown to pass its
// own mutation). It is here because a silent revert would strand every consumer
// of results.json -- the measurement included; the
// behaviour is covered where it can be -- build-triage-table.test.mjs asserts on
// real report fixtures.
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
node --test scripts/run-e2e-json-report.test.mjs
```
Expected: FAIL on the first assertion — the action reports `html,github`.

- [ ] **Step 3: Edit the action**

In `.github/actions/run-e2e/action.yml`, inside the `Run tests` step's `env:` block (after `GOOGLE_API_KEY`), add:

```yaml
        # Write the JSON reporter to a FILE. Left unset, Playwright prints the
        # whole report to stdout, which buries the run log and makes a grep over
        # it useless. Same idiom daily-stable.yml uses on `merge-reports`.
        PLAYWRIGHT_JSON_OUTPUT_NAME: results.json
```

Change the args line from `ARGS=(--pass-with-no-tests --reporter=html,github)` to:

```bash
        ARGS=(--pass-with-no-tests --reporter=html,github,json)
```

After the existing `Upload Playwright report` step, add:

```yaml
    - name: Upload Playwright JSON report
      if: always()
      uses: actions/upload-artifact@v4
      with:
        name: playwright-json-manual-${{ github.run_id }}
        path: results.json
        # A run that died before Playwright started leaves no file. That is a real
        # state (and one the consumer treats as an abort), not a reason to fail the
        # upload step and mask the actual failure above it.
        if-no-files-found: warn
        retention-days: 14
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
node --test scripts/run-e2e-json-report.test.mjs && npm run test:scripts
```
Expected: both PASS. `test:scripts` must stay green — other structural tests assert on this action's shape.

**Blast radius, measured — and measured twice, because the first measurement was still wrong.** `run-e2e` is used by exactly **one** workflow: `manual.yml`, at lines 496 and 666. `pr-validation.yml` runs `npx playwright test $SPECS --reporter=github` inline and is not a consumer. Neither is `nightly.yml` — `grep -rln 'actions/run-e2e'` lists it, but its only hit is a **comment** (`nightly.yml:129`); it has no `uses:` line for this action and invokes Playwright inline itself. So reviving nightly's cron would not give it JSON reporting or anything else here for free; that would be a separate migration. Do not describe this action as shared by two, three or four lanes — and note that the grep which suggested two is the same instrument that produced two earlier wrong claims in this document. Ask it for `uses:` lines, not for substrings.

**What the change actually restores, rather than adds:** `playwright.config.ts:119` documents the intent as *"Non-sharded CI (nightly / manual): html + github + json"* and line 131 configures exactly `[["html"], ["github"], ["json"]]`. A CLI `--reporter` **replaces** the config's list rather than merging with it, so the action's `--reporter=html,github` had been silently overriding that three-reporter intent down to two. The task closes a pre-existing mismatch between documented intent and behaviour in the file it touches.

- [ ] **Step 5: Commit**

```bash
git add .github/actions/run-e2e/action.yml scripts/run-e2e-json-report.test.mjs
git commit -m "feat(ci): emit results.json from the shared E2E action

The triage measurement needs a per-test status and a zero-test abort signal.
daily-stable.yml already produces exactly that shape from merge-reports; the
manual lane was the outlier, reporting html,github and uploading only the HTML
report -- whose embedded payload is not a format to build a measurement on.

PLAYWRIGHT_JSON_OUTPUT_NAME is what keeps the report out of stdout. The
destructive lane keeps --reporter=github so it overwrites neither artifact.

Note the guard's limit: a regex over workflow text pins a spelling, not a
behaviour (#1226). It is here because this reporter list is now load-bearing for
`manual.yml`, the lane the measurement dispatches to; the parsing behaviour is
covered against real fixtures instead.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Render the triage table from the dispatch reports

> ⚠️ **SUPERSEDED — Task 6 is implemented; read `scripts/build-triage-table.mjs`
> and the design's §2 Output.** The interface below is missing the pieces that
> matter most, and the code blocks under it are pre-fix:
> (a) **`rowsFor(baseline, byTitle)`** is the one shared row computation both
> renderers consume — the JSON sidecar exists so the follow-up work reads DATA
> rather than re-parsing our own markdown, which only holds if the two outputs
> cannot drift on how a row is computed;
> (b) `verdictFor` handles **all four** of Playwright's statuses — `flaky` is a
> retry named in the detail (never a hard failure), a `skipped` observation
> leaves the ratio instead of diluting it, and an unrecognised status is
> `unknown` **with the value named**;
> (c) a row carries the **quarantine marker** and the **failure signature**
> (with its truncation stated in the code), plus `unmatchedTitles` for the
> opposite direction of silence — an observed title that is not in the baseline;
> (d) an unreadable `--report` is a named refusal, not a stack.
> Marked stale rather than rewritten, on purpose.

**Files:**
- Create: `scripts/build-triage-table.mjs`
- Test: `scripts/build-triage-table.test.mjs`

**Interfaces:**
- Consumes: the baseline (Task 3) and one or more `results.json` files (Task 5).
- Produces:
  ```js
  export function reportTotal(report)                 // -> number  (from stats)
  export function collectObservations(report)         // -> Map<title, {status, backendErrors}[]>
  export function verdictFor(observations)            // -> { verdict, detail }
  export function renderTable(baseline, byTitle)      // -> markdown string
  ```
  ```js
  export function renderJson(baseline, byTitle)       // -> { version: 1, rows: [{spec, tier, title, verdict, detail, backendErrors}] }
  ```
  CLI: `node scripts/build-triage-table.mjs --baseline <p> --report a.json --report b.json --out docs/triage/inherited-spec-triage.md --out-json /tmp/triage/verdicts.json`. Exit 2 when any report executed zero tests. The JSON sidecar exists so the re-dispatch of the non-green tests is derived from data rather than by re-parsing our own markdown.

- [ ] **Step 1: Write the failing tests**

Create `scripts/build-triage-table.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  reportTotal, collectObservations, verdictFor, renderTable, renderJson,
} from "./build-triage-table.mjs";

const report = (specs, stats) => ({
  stats: stats ?? { expected: specs.length, unexpected: 0, flaky: 0, skipped: 0 },
  suites: [{ title: "file", file: "a/x.spec.ts", specs, suites: [] }],
});
const spec = (title, status, stdout = []) => ({
  title, tests: [{ status, results: [{ status: status === "expected" ? "passed" : "failed", stdout }] }],
});

test("reportTotal reads stats, not the suite walk", () => {
  assert.equal(reportTotal(report([spec("a", "expected")])), 1);
  assert.equal(reportTotal({ stats: {}, suites: [] }), 0);
  assert.equal(reportTotal(null), 0);
});

test("collectObservations keys by test title", () => {
  const obs = collectObservations(report([spec("a", "expected"), spec("b", "unexpected")]));
  assert.deepEqual([...obs.keys()].sort(), ["a", "b"]);
  assert.equal(obs.get("a")[0].status, "expected");
});

test("collectObservations finds a backend error in stdout", () => {
  // The fixture logs it on stdout, which is where it goes -- a grep of stderr
  // under a JSON reporter returns a false zero.
  const obs = collectObservations(report([
    spec("a", "expected", [{ text: "🚨 Backend Error: 500 POST /api/v1/flows/\n" }]),
  ]));
  assert.equal(obs.get("a")[0].backendErrors, 1);
});

test("verdictFor: all green over three observations", () => {
  const v = verdictFor([{ status: "expected" }, { status: "expected" }, { status: "expected" }]);
  assert.equal(v.verdict, "green");
  assert.match(v.detail, /3\/3/);
});

test("verdictFor: mixed is flaky with the rate", () => {
  const v = verdictFor([{ status: "expected" }, { status: "unexpected" }, { status: "expected" }]);
  assert.equal(v.verdict, "flaky");
  assert.match(v.detail, /2\/3/);
});

test("verdictFor: never passing is a hard failure", () => {
  assert.equal(verdictFor([{ status: "unexpected" }, { status: "unexpected" }]).verdict, "hard-failure");
});

test("verdictFor: only skipped is 'skipped', not green", () => {
  assert.equal(verdictFor([{ status: "skipped" }, { status: "skipped" }]).verdict, "skipped");
});

test("verdictFor: no observation is UNKNOWN, never clean", () => {
  const v = verdictFor([]);
  assert.equal(v.verdict, "unknown");
  assert.match(v.detail, /absent from every report/i);
});

test("renderJson carries one machine-readable row per baseline test", () => {
  const baseline = { specs: [{ relativePath: "a/x.spec.ts", tier: "T2",
    tests: [{ title: "seen" }, { title: "never ran" }] }] };
  const j = renderJson(baseline, collectObservations(report([spec("seen", "expected")])));
  assert.equal(j.version, 1);
  assert.deepEqual(j.rows.map((r) => [r.title, r.verdict]), [["seen", "green"], ["never ran", "unknown"]]);
  assert.equal(j.rows[0].spec, "a/x.spec.ts");
});

test("renderTable lists every baseline test, including the unobserved ones", () => {
  const baseline = { specs: [{ relativePath: "a/x.spec.ts", tier: "T2",
    tests: [{ title: "seen" }, { title: "never ran" }] }] };
  const md = renderTable(baseline, collectObservations(report([spec("seen", "expected")])));
  assert.match(md, /seen/);
  assert.match(md, /never ran/);
  assert.match(md, /unknown/i);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
node --test scripts/build-triage-table.test.mjs
```
Expected: FAIL — cannot find module `./build-triage-table.mjs`.

- [ ] **Step 3: Write the script**

Create `scripts/build-triage-table.mjs`:

```js
#!/usr/bin/env node
/**
 * Renders `docs/triage/inherited-spec-triage.md` from the measurement's
 * `results.json` reports. Design: §2.
 *
 *   node scripts/build-triage-table.mjs --report s1.json --report s2.json \
 *     --report s3.json --out docs/triage/inherited-spec-triage.md
 *
 * Keyed on test TITLE, which the baseline records as collision-free and which
 * survives the path differences between a sharded and an unsharded report.
 */
import fs from "fs";

const BACKEND_ERROR = "🚨 Backend Error";

export function reportTotal(report) {
  const s = report?.stats ?? {};
  return (s.expected ?? 0) + (s.unexpected ?? 0) + (s.flaky ?? 0) + (s.skipped ?? 0);
}

export function collectObservations(report) {
  const out = new Map();
  const walk = (suites) => {
    for (const suite of suites ?? []) {
      for (const spec of suite.specs ?? []) {
        for (const t of spec.tests ?? []) {
          const backendErrors = (t.results ?? [])
            .flatMap((r) => r.stdout ?? [])
            .filter((chunk) => String(chunk?.text ?? chunk).includes(BACKEND_ERROR)).length;
          const list = out.get(spec.title) ?? [];
          list.push({ status: t.status, backendErrors });
          out.set(spec.title, list);
        }
      }
      walk(suite.suites);
    }
  };
  walk(report?.suites);
  return out;
}

export function verdictFor(observations) {
  const n = observations.length;
  if (n === 0) {
    return {
      verdict: "unknown",
      detail: "absent from every report — not measured, and an unmeasured test is not a clean one",
    };
  }
  const green = observations.filter((o) => o.status === "expected").length;
  const skipped = observations.filter((o) => o.status === "skipped").length;
  if (skipped === n) return { verdict: "skipped", detail: `skipped in ${n}/${n} run(s)` };
  if (green === n) return { verdict: "green", detail: `${green}/${n} green` };
  if (green === 0) return { verdict: "hard-failure", detail: `0/${n} green` };
  return { verdict: "flaky", detail: `${green}/${n} green` };
}

const ICON = {
  green: "✅", flaky: "🟡", "hard-failure": "❌", skipped: "⏭️", unknown: "❔",
};

export function renderTable(baseline, byTitle) {
  const lines = [
    "<!-- Generated by scripts/build-triage-table.mjs. Do not hand-edit. -->",
    "",
    "# Inherited spec triage — measured verdicts",
    "",
    "One row per test in `tests/assets/triage/inherited-backlog-baseline.json`.",
    "A verdict is an input to the decision rules in",
    "`docs/triage/inherited-spec-triage-design.md` §3, never a conclusion.",
    "",
    "| | Tier | Spec | Test | Verdict | Backend errors |",
    "|---|---|---|---|---|---|",
  ];
  const tally = {};
  for (const spec of baseline.specs ?? []) {
    for (const t of spec.tests ?? []) {
      const obs = byTitle.get(t.title) ?? [];
      const { verdict, detail } = verdictFor(obs);
      tally[verdict] = (tally[verdict] ?? 0) + 1;
      const errors = obs.reduce((a, o) => a + (o.backendErrors ?? 0), 0);
      lines.push(
        `| ${ICON[verdict]} | ${spec.tier} | \`${spec.relativePath}\` | ${t.title.replace(/\|/g, "\\|")} ` +
          `| ${detail} | ${errors || ""} |`,
      );
    }
  }
  lines.push("", "## Tally", "");
  for (const [k, v] of Object.entries(tally).sort()) lines.push(`- ${ICON[k]} ${k}: ${v}`);
  lines.push("");
  return lines.join("\n");
}

/** The same verdicts as the table, in a shape the re-dispatch can read back. */
export function renderJson(baseline, byTitle) {
  const rows = [];
  for (const spec of baseline.specs ?? []) {
    for (const t of spec.tests ?? []) {
      const obs = byTitle.get(t.title) ?? [];
      const { verdict, detail } = verdictFor(obs);
      rows.push({
        spec: spec.relativePath, tier: spec.tier, title: t.title, verdict, detail,
        backendErrors: obs.reduce((a, o) => a + (o.backendErrors ?? 0), 0),
      });
    }
  }
  return { version: 1, rows };
}

function args(argv, name) {
  const out = [];
  argv.forEach((a, i) => {
    if (a === `--${name}` && argv[i + 1]) out.push(argv[i + 1]);
    if (a.startsWith(`--${name}=`)) out.push(a.split("=").slice(1).join("="));
  });
  return out;
}

function main(argv) {
  const baselinePath = args(argv, "baseline")[0] ?? "tests/assets/triage/inherited-backlog-baseline.json";
  const reportPaths = args(argv, "report");
  const outPath = args(argv, "out")[0] ?? "docs/triage/inherited-spec-triage.md";
  if (!reportPaths.length) {
    console.error("[triage-table] no --report given: nothing to measure");
    return 1;
  }
  const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
  const byTitle = new Map();
  for (const p of reportPaths) {
    const report = JSON.parse(fs.readFileSync(p, "utf8"));
    const total = reportTotal(report);
    if (total === 0) {
      console.error(
        `[triage-table] ABORT: ${p} executed zero tests. A dispatch whose --grep matched ` +
          "nothing is green and measures nothing; treating it as data would record every " +
          "test in that shard as unmeasured while implying the run covered them.",
      );
      return 2;
    }
    console.log(`[triage-table] ${p}: ${total} test result(s)`);
    for (const [title, obs] of collectObservations(report)) {
      byTitle.set(title, [...(byTitle.get(title) ?? []), ...obs]);
    }
  }
  fs.writeFileSync(outPath, renderTable(baseline, byTitle));
  console.log(`[triage-table] wrote ${outPath}`);
  const jsonPath = args(argv, "out-json")[0];
  if (jsonPath) {
    fs.writeFileSync(jsonPath, `${JSON.stringify(renderJson(baseline, byTitle), null, 2)}\n`);
    console.log(`[triage-table] wrote ${jsonPath}`);
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main(process.argv.slice(2)));
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
node --test scripts/build-triage-table.test.mjs
```
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/build-triage-table.mjs scripts/build-triage-table.test.mjs
git commit -m "feat(triage): render the measured verdict table from results.json

Keyed on test title, which the baseline records as collision-free and which
survives the path differences between reports. Three states are deliberately not
collapsed into 'green': skipped-everywhere, absent-from-every-report (UNKNOWN --
an unmeasured test is not a clean one, #1012), and a report whose stats total is
zero, which aborts with exit 2 rather than recording a shard as unmeasured while
implying it ran.

Backend errors are counted off stdout, which is where the fixture logs them; a
grep of stderr under a JSON reporter returns a false zero.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: Run the measurement and commit the table

No new code. This is the dispatch the previous tasks exist to make honest, and it produces the artifact Phase 2's issues are filed from.

**Files:**
- Create: `docs/triage/inherited-spec-triage.md` (written by Task 6's script)

- [ ] **Step 1: Verify the baseline on the issue's own branch**

Tasks 1–7 are ONE issue and ONE branch (see *How this becomes issues*), so the
measurement runs from that branch — never from `main`, which does not yet carry
Task 5's `results.json` and would dispatch a run whose report cannot be read:

```bash
git rev-parse --abbrev-ref HEAD   # the issue's branch, not main
npm run triage:baseline -- --check
```
Expected: `in sync`. If it is stale, refresh and commit it before dispatching — measuring against a stale target is how the table ends up with UNKNOWN rows nobody can explain.

- [ ] **Step 2: Verify each shard's selection before spending a runner**

```bash
npm run triage:verify
```
Expected, exit 0: `[triage-grep] verified set-exact: 92 wanted / 92 selected / 0 missing / 0 extra; shards 31/31/30`.

**Set-exact, never a count** — this is the check ruling P14 actually made, and
its own words are that "92 can be reached by dropping some and adding others".
`--verify` compares `--list`'s selected `spec::title` **pairs** against the
baseline's, so a title selected in the wrong file is one *missing* plus one
*extra* rather than a match, and a shard that selected nothing is named by
number even when the total is right. `--list` runs nothing, so this costs no
Langflow instance, no provider key and no runner minute.

Anything but exit 0 stops here: re-read the anchoring argument in
`scripts/build-triage-grep.mjs`'s `escapeTitle` docblock and the design's §2
before touching the fragment.

- [ ] **Step 3: Unmute the quarantined tests on a throwaway measurement branch**

A `test.fixme`/`test.skip` declaration records `0/N` and reads as clean, so the
7 disabled declarations inside the backlog would be measured as "skipped" and tell
us nothing. Unmute them
on a branch that is **never merged**, and dispatch from that ref.

```bash
mkdir -p /tmp/triage
# Forks the ISSUE's branch, which is what carries Task 5's results.json.
git checkout -b measure/inherited-triage
node -e 'const b=require("./tests/assets/triage/inherited-backlog-baseline.json");
for (const s of b.specs) for (const t of s.tests) if (t.modifier)
  console.log(`${s.relativePath}:${t.line}\ttest.${t.modifier}\t${t.title}`)' | tee /tmp/triage/muted.tsv
```

Expected: **7** lines. (The suite holds 10 disabled declarations; the other 3 sit
in files that still have `@stable` tests, so they are outside this population by
clause 4 — `loop-component-regression`, `publish-flow` and
`credential-secret-exposure`.) Edit each one, turning `test.fixme(` / `test.skip(` into
`test(` at the listed line, then confirm none is left:

```bash
npm run triage:baseline && \
node -e 'const b=require("./tests/assets/triage/inherited-backlog-baseline.json");
const left=b.specs.flatMap(s=>s.tests.filter(t=>t.modifier).map(t=>`${s.relativePath} ${t.title}`));
console.log(left.length?"STILL MUTED:\n"+left.join("\n"):"all unmuted")'
git commit -am "test: unmute the quarantined backlog specs for the triage measurement

MEASUREMENT BRANCH — do not merge. A test.fixme records 0/N and reads as clean,
so the 7 quarantined declarations in the backlog would be measured as skipped and
yield no verdict.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git push -u origin measure/inherited-triage
```
Expected: `all unmuted`, and the baseline regenerated on this branch with every
`modifier` empty. **Revert the baseline file before dispatching** if the write
changed anything other than the modifiers — the fragments must still select the
same 92 titles.

- [ ] **Step 4: Dispatch NINE measurement runs from that ref — three passes over three shards**

```bash
for pass in 1 2 3; do
  for i in 1 2 3; do
    gh workflow run manual.yml --repo oriontech-me/langflow-e2e \
      --ref measure/inherited-triage \
      -f langflow_target=latest \
      -f langflow_image=nightly \
      -f test_grep="$(node scripts/build-triage-grep.mjs --shards 3 --shard $i)" \
      -f provider=auto \
      -f retries=0
    sleep 5   # so the runs are distinguishable by creation order
  done
done
sleep 30
gh run list --repo oriontech-me/langflow-e2e --workflow manual.yml \
  --branch measure/inherited-triage --limit 9 \
  --json databaseId,status,createdAt --jq '.[] | "\(.databaseId)\t\(.status)"' | tee /tmp/triage/runs.tsv
```
Expected: **9** lines in `runs.tsv`.

**Three passes, not one, and it is EVERY test that gets three observations —
green ones included** (design §2, revised 2026-09-09). An earlier revision of
this plan measured each test once and re-dispatched only the reds, which cannot
satisfy §3's PROMOTE gate ("3/3 green, no exceptions"): a green test had one
observation, and §4 forbids re-measuring later. Runner minutes are free here and
the nine dispatches are parallel, so wall clock is unchanged from three — and
three observations for a *green* test is exactly what makes `flaky` detectable
**before** a promotion rather than after it.

Leave `test_tag` empty: the tag is what would AND a second filter in, and the
fragment already **is** the selection. `retries=0` because a retry inside one
dispatch hides the intermittence the three passes exist to measure.

**Before reading any provider-spec red**, confirm the credentials were live for
that run — this account has three recorded drains (#772, #1029, #1169), and a
credit error persists as a run row that reads exactly like a product bug. Each
dispatch's `Collect models` step names the active providers.

- [ ] **Step 5: Collect the nine reports and render the table**

```bash
cut -f1 /tmp/triage/runs.tsv | while read -r id; do
  gh run download "$id" --repo oriontech-me/langflow-e2e \
    -n "playwright-json-manual-$id" -D "/tmp/triage/$id"
done
ls /tmp/triage/*/results.json | wc -l    # expect 9
git checkout -   # back to the issue's branch; the table is committed there
node scripts/build-triage-table.mjs \
  $(for f in /tmp/triage/*/results.json; do printf -- '--report %s ' "$f"; done) \
  --out docs/triage/inherited-spec-triage.md \
  --out-json /tmp/triage/verdicts.json
```
Expected: nine `N test result(s)` lines, summing to **3 × the baseline's
`testCount`**, then two `wrote …` lines.

**Check the report count before rendering.** Nine is not decoration: a download
that silently produced fewer leaves some tests with one or two observations, and
`2/2 green` is not the `3/3 green` §3's gate requires. The table will not say
so on its own — the detail column reports the ratio it measured, so the reader
has to know nine reports went in.

Two named refusals to expect rather than debug:
- **exit 2** — a report executed zero tests, i.e. that shard's `--grep` matched
  nothing. Re-dispatch that shard; do not commit a partial table.
- **`[triage-table] ENOENT: …/*/results.json`** — the glob matched nothing and
  bash passed the pattern through literally, so the downloads failed. Re-run the
  download loop.

`git checkout -` matters for a reason beyond tidiness: the quarantine column is
read from the **committed baseline**, which on the issue's branch still records
`main`'s `test.skip` / `test.fixme` declarations. Rendering from the measurement
branch (where Step 3 regenerated the baseline with every modifier empty) would
produce a table that silently drops all 7 markers.

- [ ] **Step 6: Commit the table**

Commit **only** the markdown — the sidecar and the downloaded reports stay in
`/tmp`:

```bash
git add docs/triage/inherited-spec-triage.md
git commit -m "docs(triage): the measured verdicts for the 55 never-validated specs

Nine dispatches: three passes over three shards, so EVERY test has three
observations and flaky is separable from a hard failure without a second round.
retries=0 throughout -- a retry inside one dispatch hides exactly the
intermittence this table exists to record -- and the 7 quarantined declarations
in the backlog were unmuted on a throwaway branch, since a test.fixme records
0/N and reads as clean. Their rows carry the Quarantine marker, read from this
branch's committed baseline.

This is the scoping pass the wave's later items are filed from; a verdict here is
an input to the design's §3 decision rules, never a conclusion.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

> **Superseded step, deliberately removed.** An earlier revision had a *Step 6:
> re-dispatch everything not green, twice*. It is redundant now that Step 4
> measures every test three times (design §2, revised 2026-09-09), and it was
> also the step a review found to carry no shard-sizing rule of its own. Do not
> reinstate it: re-measuring after the table lands is what §4 forbids.

- [ ] **Step 7: Delete the measurement branch**

```bash
git push origin --delete measure/inherited-triage && git branch -D measure/inherited-triage
```
It must not survive: an unmuted quarantined spec on a long-lived branch is one
merge away from putting a known-broken test back in the daily.

---

### Task 8: The ownership guard

**Files:**
- Create: `scripts/lib/stable-ownership.ts`
- Create: `scripts/check-stable-ownership.ts`
- Create: `tests/assets/triage/stable-exemptions.json`
- Test: `scripts/lib/stable-ownership.test.ts`
- Modify: `package.json` (add `check:stable-ownership`)

**Interfaces:**
- Consumes: `collectBacklog`/`Backlog` (Task 2), `BaselineFile` (Task 3).
- Produces:
  ```ts
  export type Verdict = "owned" | "exempt" | "expired-exemption" | "unowned-baseline" | "unowned-new" | "unknown";
  export interface Exemption { spec: string; reason: string; issue?: number }
  export interface IssueRef { number: number; state: "open" | "closed" }
  export interface OwnershipInput {
    backlogSpecs: string[];
    baselineSpecs: string[];
    exemptions: Exemption[];
    /** null when the issue lookup failed — every row then reads `unknown`. */
    issuesBySpec: Map<string, IssueRef[]> | null;
  }
  export interface OwnershipRow { spec: string; verdict: Verdict; detail: string }
  export function ownershipReport(input: OwnershipInput):
    { rows: OwnershipRow[]; failures: OwnershipRow[]; notices: OwnershipRow[] };
  ```

- [ ] **Step 1: Write the failing tests**

Create `scripts/lib/stable-ownership.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { ownershipReport } from "./stable-ownership";

const base = {
  backlogSpecs: ["a/x.spec.ts"],
  baselineSpecs: ["a/x.spec.ts"],
  exemptions: [],
  issuesBySpec: new Map<string, { number: number; state: "open" | "closed" }[]>(),
};

test("an open issue naming the spec owns it", () => {
  const r = ownershipReport({ ...base, issuesBySpec: new Map([["a/x.spec.ts", [{ number: 7, state: "open" }]]]) });
  assert.equal(r.rows[0].verdict, "owned");
  assert.equal(r.failures.length, 0);
});

// Keying on the tracker's state rather than the tag's is what produced two false
// orphans in the #1504 audit: an issue can close WITH the restoration performed.
test("a closed issue does not own it", () => {
  const r = ownershipReport({ ...base, issuesBySpec: new Map([["a/x.spec.ts", [{ number: 7, state: "closed" }]]]) });
  assert.equal(r.rows[0].verdict, "unowned-baseline");
});

test("a baseline spec with no owner is a notice, not a failure", () => {
  const r = ownershipReport(base);
  assert.equal(r.rows[0].verdict, "unowned-baseline");
  assert.equal(r.failures.length, 0);
  assert.equal(r.notices.length, 1);
});

test("a spec beyond the baseline with no owner fails", () => {
  const r = ownershipReport({ ...base, backlogSpecs: ["a/x.spec.ts", "b/new.spec.ts"] });
  const row = r.rows.find((x) => x.spec === "b/new.spec.ts")!;
  assert.equal(row.verdict, "unowned-new");
  assert.equal(r.failures.length, 1);
});

test("an exemption declares a spec, and its expiry is reported", () => {
  const exempt = ownershipReport({ ...base, exemptions: [{ spec: "a/x.spec.ts", reason: "not bundled in the tested image" }] });
  assert.equal(exempt.rows[0].verdict, "exempt");

  const expired = ownershipReport({
    ...base,
    exemptions: [{ spec: "a/x.spec.ts", reason: "blocked upstream", issue: 9 }],
    issuesBySpec: new Map([["a/x.spec.ts", [{ number: 9, state: "closed" }]]]),
  });
  assert.equal(expired.rows[0].verdict, "expired-exemption");
  assert.equal(expired.failures.length, 0);
  assert.equal(expired.notices.length, 1);
});

test("a failed issue lookup makes every row unknown and fails", () => {
  const r = ownershipReport({ ...base, issuesBySpec: null });
  assert.equal(r.rows[0].verdict, "unknown");
  assert.equal(r.failures.length, 1);
  assert.match(r.rows[0].detail, /could not be/i);
});

// The pinned negative scope. Enterprise is the largest zero-@stable population
// in the repo and its absence of the tag is correct, never debt.
test("an Enterprise-only population produces no rows at all", () => {
  const r = ownershipReport({ backlogSpecs: [], baselineSpecs: [], exemptions: [], issuesBySpec: new Map() });
  assert.deepEqual(r.rows, []);
  assert.deepEqual(r.failures, []);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
node --require ts-node/register --test scripts/lib/stable-ownership.test.ts
```
Expected: FAIL — cannot find module `./stable-ownership`.

- [ ] **Step 3: Write the verdict module and its CLI**

Create `scripts/lib/stable-ownership.ts`:

```ts
/**
 * Does every spec with no `@stable` test have an owner?
 *
 * Pure and total: the CLI does the IO, this decides. Design: §5.
 *
 * NOT the same question as #1746's, which is about a tag that was REMOVED and
 * has a restoration to reconcile. This one is about a tag that was never there.
 * Same thesis, separate reports.
 */
export type Verdict =
  | "owned" | "exempt" | "expired-exemption" | "unowned-baseline" | "unowned-new" | "unknown";

export interface Exemption { spec: string; reason: string; issue?: number }
export interface IssueRef { number: number; state: "open" | "closed" }
export interface OwnershipInput {
  backlogSpecs: string[];
  baselineSpecs: string[];
  exemptions: Exemption[];
  issuesBySpec: Map<string, IssueRef[]> | null;
}
export interface OwnershipRow { spec: string; verdict: Verdict; detail: string }

export function ownershipReport(input: OwnershipInput): {
  rows: OwnershipRow[]; failures: OwnershipRow[]; notices: OwnershipRow[];
} {
  const baseline = new Set(input.baselineSpecs);
  const exemptBySpec = new Map(input.exemptions.map((e) => [e.spec, e]));
  const rows: OwnershipRow[] = [];

  for (const spec of [...input.backlogSpecs].sort()) {
    if (input.issuesBySpec === null) {
      rows.push({
        spec, verdict: "unknown",
        detail: "issue state could not be read; a verdict this guard cannot produce is not a pass",
      });
      continue;
    }
    const issues = input.issuesBySpec.get(spec) ?? [];
    const open = issues.filter((i) => i.state === "open");
    const exemption = exemptBySpec.get(spec);

    if (exemption) {
      // Verified in BOTH directions (#1084): a declaration whose reason expired
      // has to surface, or this guard grows the silent-expiry problem it exists
      // to close.
      const linked = exemption.issue
        ? issues.find((i) => i.number === exemption.issue)
        : undefined;
      if (exemption.issue && (!linked || linked.state === "closed")) {
        rows.push({
          spec, verdict: "expired-exemption",
          detail: `exemption cites #${exemption.issue}, which is ${linked ? "closed" : "not found"}: "${exemption.reason}"`,
        });
        continue;
      }
      rows.push({ spec, verdict: "exempt", detail: exemption.reason });
      continue;
    }
    if (open.length) {
      rows.push({ spec, verdict: "owned", detail: `owned by ${open.map((i) => `#${i.number}`).join(", ")}` });
      continue;
    }
    const known = baseline.has(spec);
    rows.push({
      spec,
      verdict: known ? "unowned-baseline" : "unowned-new",
      detail: known
        ? "in the frozen baseline, no open issue owns it"
        : "not in the frozen baseline and no open issue owns it: this spec entered the backlog without a tracker",
    });
  }

  return {
    rows,
    failures: rows.filter((r) => r.verdict === "unowned-new" || r.verdict === "unknown"),
    notices: rows.filter((r) => r.verdict === "unowned-baseline" || r.verdict === "expired-exemption"),
  };
}
```

Create `tests/assets/triage/stable-exemptions.json`:

```json
{
  "version": 1,
  "comment": "Specs deliberately and durably outside @stable. A reason is mandatory; an `issue` makes the declaration expire when that issue closes, which is reported rather than honoured silently (#1084).",
  "exemptions": [
    {
      "spec": "core-functionality/model-provider/groq-provider.spec.ts",
      "reason": "The Groq components are not bundled in the tested image — a packaging decision, not a test defect. See docs/component-distribution-policy.md (#1039)."
    },
    {
      "spec": "core-functionality/model-provider/mistral-provider.spec.ts",
      "reason": "The Mistral components are not bundled in the tested image — a packaging decision, not a test defect. See docs/component-distribution-policy.md (#1039)."
    }
  ]
}
```

Create `scripts/check-stable-ownership.ts`:

```ts
/**
 * CLI shell over `lib/stable-ownership.ts`. Reads the derived backlog, the frozen
 * baseline, the exemptions file and the live issue state, then reports.
 *
 *   npm run check:stable-ownership              # human output
 *   npm run check:stable-ownership -- --markdown  # an issue body
 *
 * Exit 1 on any failure row (a spec beyond the baseline with no owner, or a
 * verdict that could not be produced). Notices never fail: a pre-existing orphan
 * is not the current author's fault, and failing on it would redden unrelated
 * PRs until someone runs an audit (#980).
 */
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { REPO_ROOT } from "./lib/stable-tests";
import { collectBacklog } from "./lib/inherited-backlog";
import { ownershipReport, type Exemption, type IssueRef } from "./lib/stable-ownership";
import { BASELINE_PATH, type BaselineFile } from "./update-inherited-backlog-baseline";

const EXEMPTIONS_PATH = path.join(REPO_ROOT, "tests", "assets", "triage", "stable-exemptions.json");

/** Open AND closed issues, keyed by every spec path their body or title names. */
function issuesBySpec(specs: string[]): Map<string, IssueRef[]> | null {
  try {
    const raw = execFileSync(
      "gh",
      ["issue", "list", "--state", "all", "--limit", "500", "--json", "number,state,title,body"],
      { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const issues = JSON.parse(raw) as { number: number; state: string; title: string; body: string }[];
    const map = new Map<string, IssueRef[]>();
    for (const spec of specs) {
      const basename = path.basename(spec);
      const hits = issues
        .filter((i) => `${i.title}\n${i.body ?? ""}`.includes(basename))
        .map((i) => ({ number: i.number, state: i.state.toLowerCase() === "open" ? "open" : "closed" } as IssueRef));
      if (hits.length) map.set(spec, hits);
    }
    return map;
  } catch (err) {
    console.error(`[ownership] issue lookup failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function main(argv: string[]): number {
  const markdown = argv.includes("--markdown");
  const backlog = collectBacklog();
  const backlogSpecs = backlog.specs.map((s) => s.relativePath);
  let baseline: BaselineFile | null = null;
  try {
    baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8")) as BaselineFile;
  } catch {
    console.error(
      `[ownership] cannot read ${path.relative(REPO_ROOT, BASELINE_PATH)}. Without it every spec ` +
        "reads as new and every row would fail; run `npm run triage:baseline`.",
    );
    return 1;
  }
  const exemptions: Exemption[] = JSON.parse(fs.readFileSync(EXEMPTIONS_PATH, "utf8")).exemptions;

  const report = ownershipReport({
    backlogSpecs,
    baselineSpecs: baseline.specs.map((s) => s.relativePath),
    exemptions,
    issuesBySpec: issuesBySpec(backlogSpecs),
  });

  if (markdown) {
    console.log("## Specs with no `@stable` test and no owner\n");
    console.log("| Spec | Verdict | Detail |");
    console.log("|---|---|---|");
    for (const r of [...report.failures, ...report.notices]) {
      console.log(`| \`${r.spec}\` | ${r.verdict} | ${r.detail} |`);
    }
    console.log(
      `\n${report.rows.length} spec(s) in the backlog · ${report.failures.length} failing · ` +
        `${report.notices.length} notice(s).`,
    );
  } else {
    for (const r of report.rows) console.log(`${r.verdict.padEnd(18)} ${r.spec} — ${r.detail}`);
    console.log(
      `\n[ownership] ${report.rows.length} spec(s), ${report.failures.length} failure(s), ` +
        `${report.notices.length} notice(s).`,
    );
  }
  return report.failures.length ? 1 : 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
```

Add to `package.json` `scripts`:

```json
"check:stable-ownership": "ts-node scripts/check-stable-ownership.ts",
```

- [ ] **Step 4: Run the tests, then the CLI against the real repo**

```bash
node --require ts-node/register --test scripts/lib/stable-ownership.test.ts && \
npm run check:stable-ownership
```
Expected: tests PASS. The CLI prints one line per backlog spec and exits **0** — every one of the 55 is in the frozen baseline, so the worst verdict available is `unowned-baseline`, which is a notice. A non-zero exit here means the baseline is stale; refresh it rather than weakening the verdict.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/stable-ownership.ts scripts/lib/stable-ownership.test.ts \
        scripts/check-stable-ownership.ts tests/assets/triage/stable-exemptions.json package.json
git commit -m "feat(triage): guard that every spec with no @stable test has an owner

An open issue, or a committed exemption with a reason. The exemption is verified
in both directions (#1084): one citing an issue that has closed is reported as
expired rather than honoured silently, which is the failure mode the HTTP-error
policy was raised about.

Severity follows the diff (#980): a spec in the frozen baseline is a notice,
because a pre-existing orphan is not the current author's fault; a spec BEYOND
the baseline fails, because that is the author's own diff. A verdict the guard
cannot produce -- a failed issue lookup, an unreadable baseline -- fails rather
than reading as a pass (#1012).

Keyed on the TAG's state, never the tracker's: an issue can close with the
restoration performed, and keying the other way produced two false orphans in
the #1504 audit. Enterprise yielding zero rows is pinned by a test, since it is
the largest zero-@stable population in the repo and correct as it stands (#1010).

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 9: Wire the guard into the PR lane and the daily

A warning nobody reads is not a mechanism — `mode=count` sat in the daily's prep log for weeks. The PR lane gets the diff-scoped verdict; the daily owns the standing report, and it reaches a human as an issue body.

**Files:**
- Modify: `.github/workflows/pr-validation.yml` (the `checklist-guard` job, after the `npm run check:checklist-coverage` step at line 177)
- Modify: `.github/workflows/daily-stable.yml` (the `merge` job, after the `runguard` step)
- Test: `scripts/stable-ownership-wiring.test.mjs`

**Interfaces:**
- Consumes: `npm run check:stable-ownership` (Task 8).
- Produces: a `::notice::`/failure on the PR lane, and a standing GitHub issue titled `[Ownership] Specs with no @stable test and no owner`.

- [ ] **Step 1: Write the failing test**

Create `scripts/stable-ownership-wiring.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const PR = fs.readFileSync(".github/workflows/pr-validation.yml", "utf8");
const DAILY = fs.readFileSync(".github/workflows/daily-stable.yml", "utf8");

test("the PR lane runs the ownership guard in the checklist-guard job", () => {
  const job = PR.slice(PR.indexOf("\n  checklist-guard:"), PR.indexOf("\n  doc-deps-guard:"));
  assert.match(job, /check:stable-ownership/);
});

test("the daily runs the guard and pipes it into an issue body", () => {
  assert.match(DAILY, /check:stable-ownership.*--markdown|--markdown/s);
  assert.match(DAILY, /\[Ownership\] Specs with no `@stable` test and no owner/);
});

test("the daily's ownership step does not depend on the test job's result", () => {
  // The guard reads ASTs and issue state, not the report, so it must run on a
  // green day too -- a report that only exists when something else failed is the
  // log line this mechanism is supposed to replace.
  const step = DAILY.slice(DAILY.indexOf("Report stable ownership"));
  assert.match(step.slice(0, 400), /if:\s*always\(\)/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
node --test scripts/stable-ownership-wiring.test.mjs
```
Expected: FAIL — neither workflow mentions the guard.

- [ ] **Step 3: Wire both lanes**

In `.github/workflows/pr-validation.yml`, in the `checklist-guard` job after the `check:checklist-coverage` step:

```yaml
      # Ownership of specs with no `@stable` test (design: docs/triage/…-design.md §5).
      # Severity follows the diff: a spec in the frozen baseline is a notice, a spec
      # beyond it fails. `continue-on-error` is deliberately ABSENT -- the failing
      # case is the PR author's own diff.
      - name: Check @stable ownership
        run: npm run check:stable-ownership
```

In `.github/workflows/daily-stable.yml`, in the `merge` job after the `runguard` step:

```yaml
      # The standing ownership report. Unconditional: this guard reads the spec
      # ASTs and live issue state, not the run report, so it is just as valid on a
      # green day -- and a report that only appears when something else failed is
      # exactly the unread log line it replaces (#1252). `continue-on-error`
      # because the report is an observation, not a release verdict: a `gh`
      # hiccup here must not redden a green daily (#980).
      - name: Report stable ownership
        if: always()
        continue-on-error: true
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          set -o pipefail
          TITLE='[Ownership] Specs with no `@stable` test and no owner'
          npm run --silent check:stable-ownership -- --markdown > /tmp/ownership.md || true
          FAILURES=$(grep -cE '\| (unowned-new|unknown) \|' /tmp/ownership.md || true)
          NOTICES=$(grep -cE '\| (unowned-baseline|expired-exemption) \|' /tmp/ownership.md || true)
          EXISTING=$(gh issue list --state open --search "$TITLE in:title" --json number --jq '.[0].number // empty')
          if [ "$((FAILURES + NOTICES))" -eq 0 ]; then
            if [ -n "$EXISTING" ]; then
              gh issue close "$EXISTING" --comment "Every spec with no \`@stable\` test now has an owner."
            fi
            echo "[ownership] nothing to report"
            exit 0
          fi
          if [ -n "$EXISTING" ]; then
            gh issue edit "$EXISTING" --body-file /tmp/ownership.md
          else
            gh issue create --title "$TITLE" --label qa-infra --body-file /tmp/ownership.md
          fi
```

- [ ] **Step 4: Run the test to verify it passes, and the whole unit surface with it**

```bash
node --test scripts/stable-ownership-wiring.test.mjs && npm run test:scripts && npm run test:units && npm run typecheck
```
Expected: all four PASS. `typecheck` matters here: the two new TypeScript modules are under `scripts/`, which the root `tsconfig.json` includes.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/pr-validation.yml .github/workflows/daily-stable.yml \
        scripts/stable-ownership-wiring.test.mjs
git commit -m "ci(triage): run the ownership guard on the PR lane and in the daily

The PR lane gets the diff-scoped verdict, failing only on a spec the PR itself
added without an owner. The daily owns the standing report and updates ONE issue
in place -- created when there is something to say, closed when there is not --
because a warning nobody reads is not a mechanism (#1252's mode=count).

The daily's step is unconditional on purpose: the guard reads the spec ASTs and
live issue state rather than the run report, so it is just as valid on a green
day, and a report that appears only when something else failed is the log line
this replaces. continue-on-error, because an observation must not redden a green
daily (#980).

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## After this plan

The measurement's table is the input to Phase 2, which is deliberately not planned here: its items are the clusters the table reveals. When Task 7 lands, file the batch issues the same day, per the design's §4 — one issue per root cause, capped at what one PR can close, with the evidence rows in the body — and open a separate plan for the batch work if any single cluster needs more than one PR.

The design's §6 sizing puts T1 (26 specs / 41 tests) and this tooling in Wave 8, and T2 (29 specs / 51 tests) in Wave 9.
