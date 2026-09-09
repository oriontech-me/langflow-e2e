/**
 * Shared source of truth for "which declaration carries which tags", and the
 * `@stable` filter over it.
 *
 * Extracted from `scripts/stable-tests.ts` (the Phase 0 regenerator) so that the
 * checklist-coverage guard (`scripts/check-checklist-coverage.ts`) enforces the
 * SAME notion of `@stable` the generator publishes. Two independent parsers —
 * one regex-based, one AST-based — would be exactly the kind of "sources that
 * are supposed to agree but don't" drift that issue #985 is about.
 *
 * The parse is AST-based (TypeScript compiler API) rather than textual because
 * `@stable` appears in prose all over the suite: JSDoc headers explaining a
 * promotion, comments recording a removal ("@stable removed by daily triage
 * #704"), and commented-out `{ tag: [...] }` lines. Only a real `test(...)` call
 * whose options object has an inline `tag` array containing the literal
 * `"@stable"` counts.
 *
 * `parseTaggedTests` / `collectTaggedTests` expose every tagged DECLARATION —
 * `test(...)` and its modifiers (`.fixme`, `.skip`, `.only`, `.fail`, `.slow`) —
 * with whatever tags and modifier it carries. `parseStableTests` /
 * `collectStableTests` are a FILTER over that same walk, not a second one, so a
 * future consumer that needs the wider population (e.g. a never-validated
 * backlog) never has to keep a second AST walker in agreement with this one.
 */

import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";

export const REPO_ROOT = path.resolve(__dirname, "..", "..");
export const REGRESSION_ROOT = path.join(
  REPO_ROOT,
  "tests",
  "tests-automations",
  "regression",
);

export const STABLE_TAG = "@stable";

export interface StableTest {
  /** Title as written in the `test(...)` first argument (template `${...}` placeholders preserved). */
  title: string;
  /** Module path under `regression/`, e.g. `core-functionality/llm-agents`. */
  modulePath: string;
  /** Spec basename, e.g. `loop-component-regression.spec.ts`. */
  specFile: string;
  /** Path under `regression/`, e.g. `core-components/loop-component-regression.spec.ts`. */
  relativePath: string;
  /** 1-based source line of the `test(...)` call. */
  line: number;
}

export interface CollectResult {
  tests: StableTest[];
  /** Non-fatal parse problems (e.g. a `tag` option that is not an inline array). */
  warnings: string[];
}

// ─── Filesystem walk ─────────────────────────────────────────────────────────

/** Absolute paths of every `*.spec.ts` under `dir`, recursively. */
export function walkSpecs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkSpecs(full));
    } else if (entry.isFile() && entry.name.endsWith(".spec.ts")) {
      out.push(full);
    }
  }
  return out;
}

/** Every spec path under `regression/`, POSIX-separated and relative to it. */
export function listSpecPaths(): string[] {
  return walkSpecs(REGRESSION_ROOT)
    .map((p) => path.relative(REGRESSION_ROOT, p).split(path.sep).join("/"))
    .sort((a, b) => a.localeCompare(b));
}

// ─── AST helpers ─────────────────────────────────────────────────────────────

function literalText(node: ts.Node): string | null {
  if (ts.isStringLiteral(node)) return node.text;
  if (ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    let s = node.head.text;
    for (const span of node.templateSpans) {
      s += "${" + span.expression.getText() + "}" + span.literal.text;
    }
    return s;
  }
  return null;
}

interface TagReadResult {
  /** Tags extracted from the inline array literal, or null if no `tag` property was found. */
  tags: string[] | null;
  /** True when a `tag` property exists but its value is not a parseable inline array literal. */
  unparseable: boolean;
}

function readTagsArray(node: ts.Node): TagReadResult {
  if (!ts.isObjectLiteralExpression(node)) {
    return { tags: null, unparseable: false };
  }
  for (const prop of node.properties) {
    if (
      !ts.isPropertyAssignment(prop) ||
      !ts.isIdentifier(prop.name) ||
      prop.name.text !== "tag"
    ) {
      continue;
    }
    const init = prop.initializer;
    if (!ts.isArrayLiteralExpression(init)) {
      return { tags: null, unparseable: true };
    }
    const tags: string[] = [];
    for (const el of init.elements) {
      const t = literalText(el);
      if (t !== null) tags.push(t);
      else {
        // Non-literal element (spread, identifier, etc.) — treat as unparseable
        // so an `@stable` constant referenced indirectly does not silently slip past.
        return { tags: null, unparseable: true };
      }
    }
    return { tags, unparseable: false };
  }
  return { tags: null, unparseable: false };
}

/** Match exactly `test(...)` — not `test.describe`, `test.skip`, `test.only`, etc. */
function isPlainTestCall(call: ts.CallExpression): boolean {
  return ts.isIdentifier(call.expression) && call.expression.text === "test";
}

/** Match `test.describe(...)` and its modifiers (`.serial`, `.parallel`, `.only`, …). */
function isDescribeCall(call: ts.CallExpression): boolean {
  return /^test\.describe\b/.test(call.expression.getText());
}

/** Match `test(...)` and its declaration modifiers — never `test.describe`, never `test.step`. */
const DECLARATION_RE = /^test(?:\.(fixme|skip|only|fail|slow))?$/;

export interface TaggedTest {
  /** Title as written in the first argument (template `${...}` placeholders preserved). */
  title: string;
  /** Every literal string in the inline `tag: [...]` array, in source order. */
  tags: string[];
  /** "" for a plain `test(...)`; otherwise "fixme" | "skip" | "fail" | "only" | "slow". */
  modifier: string;
  /** Module path under `regression/`, e.g. `core-functionality/llm-agents`. */
  modulePath: string;
  /** Spec basename, e.g. `loop-component-regression.spec.ts`. */
  specFile: string;
  /** Path under `regression/`, e.g. `core-components/loop-component-regression.spec.ts`. */
  relativePath: string;
  /** 1-based source line of the declaration. */
  line: number;
}

/**
 * A parse problem, carrying WHICH declaration it is about.
 *
 * The modifier is what lets a consumer decide whether a warning is theirs.
 * `parseStableTests`'s population is plain `test(...)` calls only, so a
 * `test.skip(..., { tag: SHARED })` it cannot read is not a gap in ITS truth —
 * such a declaration can never be `@stable` to this repo whatever its tags say.
 * Forwarding it made `check-checklist-coverage.ts` (which exits 1 on any
 * warning) fail every PR that wrote one, with a message telling the author to
 * inline the array "so it shows up in Phase 0" — impossible for a modified
 * declaration. Measured base-vs-head on such a source: 0 warnings before Task
 * 1 widened the walk, 1 after.
 *
 * `null` means "not attributable to a declaration at all" — today only the
 * `@stable`-on-a-`test.describe` case, which every consumer needs: Playwright
 * really does apply that tag to each test inside, so those tests run in the
 * daily while staying out of Phase 0 and the checklist guard.
 */
export interface ParseWarning {
  /** Human-readable message — exactly what the string-valued arrays carry. */
  message: string;
  /** "" for a plain `test(...)`, the modifier for a modified one, `null` for a non-declaration. */
  modifier: string | null;
}

/**
 * True when a warning bears on the `@stable` population — i.e. on a plain
 * declaration, or on a `test.describe` tag that Playwright propagates into one.
 * The filter `parseStableTests` applies; exported so the rule is testable and
 * has exactly one definition.
 */
export function warningAffectsStable(w: ParseWarning): boolean {
  return w.modifier === "" || w.modifier === null;
}

export interface CollectTaggedResult {
  tests: TaggedTest[];
  /** Non-fatal parse problems (e.g. a `tag` option that is not an inline array). */
  warnings: string[];
  /** The same problems, each carrying the modifier of the declaration it is about. */
  warningDetails: ParseWarning[];
}

/**
 * Parse one spec's SOURCE TEXT for every DECLARATION that carries an inline
 * `tag` array — `test(...)` and its modifiers (`.fixme`, `.skip`, `.only`,
 * `.fail`, `.slow`) — regardless of which tags it carries. This is the ONE AST
 * walk in the module; `parseStableTests` below is a filter over it rather than
 * a second walker, which is the #985 drift this module exists to prevent.
 *
 * `filePath` is only used to derive the reported `modulePath` / `specFile` /
 * `relativePath`, so it may point at a file that does not exist; it must still
 * be an ABSOLUTE path under `REGRESSION_ROOT` for those to come out right —
 * the same contract `parseStableTests` has always had.
 *
 * An in-body `test.skip(condition, message)` guard also has two arguments,
 * exactly like a declaration's `(title, options)` — but its second argument is
 * a string, not an object literal carrying a `tag` property, so `readTagsArray`
 * reports "no tag array" rather than "unparseable" and it is silently not a
 * declaration. Counting it as one would inflate the population by every
 * provider guard in the suite (96 in `llm-agents` alone).
 */
export function parseTaggedTests(
  filePath: string,
  sourceText: string,
): CollectTaggedResult {
  const tests: TaggedTest[] = [];
  const warningDetails: ParseWarning[] = [];
  const relativePath = path
    .relative(REGRESSION_ROOT, filePath)
    .split(path.sep)
    .join("/");
  const modulePath = path.dirname(relativePath);
  const specFile = path.basename(relativePath);
  const source = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
  );

  function visit(node: ts.Node): void {
    // Playwright propagates a `test.describe` tag to every child test, and the
    // daily's `--grep "@stable"` honours it — but this parser is per-`test()`,
    // so a suite tagged that way would run in the stable lane while staying
    // invisible to Phase 0 and to the checklist guard. Warn instead of guessing:
    // the fix is to move `@stable` onto the individual `test()` calls (#985).
    if (
      ts.isCallExpression(node) &&
      isDescribeCall(node) &&
      node.arguments.length >= 2
    ) {
      const { tags } = readTagsArray(node.arguments[1]);
      if (tags?.includes(STABLE_TAG)) {
        const { line } = source.getLineAndCharacterOfPosition(
          node.getStart(source),
        );
        warningDetails.push({
          // Not a declaration: `null`, so every consumer keeps it. Playwright
          // really does propagate this tag into the tests inside.
          modifier: null,
          message:
            `${relativePath}:${line + 1} — \`@stable\` is declared on a \`test.describe\` block. ` +
            "Playwright applies it to every test inside, but this parser only reads per-`test()` " +
            "tags, so those tests would run in the daily while staying out of Phase 0 and the " +
            "checklist guard. Move `@stable` onto each `test(...)` call.",
        });
      }
    }
    if (ts.isCallExpression(node)) {
      const m = DECLARATION_RE.exec(node.expression.getText());
      if (m && node.arguments.length >= 2) {
        const title = literalText(node.arguments[0]);
        const { tags, unparseable } = readTagsArray(node.arguments[1]);
        const { line } = source.getLineAndCharacterOfPosition(
          node.getStart(source),
        );
        if (unparseable) {
          const modifier = m[1] ?? "";
          // The remediation has to be TRUE for whoever is being asked to act on
          // it. A plain declaration's unreadable tag array really can hide an
          // `@stable` test from Phase 0. A MODIFIED one cannot: `.skip` /
          // `.fixme` / `.only` / `.fail` / `.slow` are never `@stable` to this
          // repo (see `parseStableTests`), so telling that author to inline the
          // array "so it shows up in Phase 0" is asking for the impossible —
          // and it is a PR-blocking ask, since `check-checklist-coverage.ts`
          // exits 1 on any warning. What such a declaration really affects is
          // the never-validated backlog, which does count it.
          warningDetails.push({
            modifier,
            message:
              modifier === ""
                ? `${relativePath}:${line + 1} — \`tag\` option is not an inline array of string ` +
                  "literals; the script cannot determine if this test is `@stable`. Inline the " +
                  'array (e.g. `tag: ["@stable", ...]`) so it shows up in Phase 0.'
                : `${relativePath}:${line + 1} — \`tag\` option on a \`test.${modifier}(...)\` ` +
                  "declaration is not an inline array of string literals, so its tags cannot be " +
                  'read. Inline the array (e.g. `tag: ["@regression", ...]`) so the ' +
                  "never-validated backlog counts it. This does not affect Phase 0 or the " +
                  "checklist guard: a modified declaration is never `@stable` to this repo.",
          });
        }
        // A `tag` array is what makes this a DECLARATION rather than an in-body
        // `test.skip(cond, msg)` guard, which also carries two arguments.
        if (title !== null && tags) {
          tests.push({
            title,
            tags,
            modifier: m[1] ?? "",
            modulePath,
            specFile,
            relativePath,
            line: line + 1,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(source);
  return { tests, warnings: warningDetails.map((w) => w.message), warningDetails };
}

/**
 * Every tagged declaration across every spec under `regression/`, plus any
 * non-fatal parse warnings. Files are walked in sorted (absolute-path) order
 * so the result is deterministic across filesystems — POSIX does not
 * guarantee `readdirSync` order — but that is the only ordering promise: a
 * consumer that needs a specific key (e.g. `collectStableTests`'s
 * module → spec → line) sorts its own filtered result.
 */
export function collectTaggedTests(): CollectTaggedResult {
  const tests: TaggedTest[] = [];
  const warningDetails: ParseWarning[] = [];
  for (const file of walkSpecs(REGRESSION_ROOT).sort()) {
    const parsed = parseTaggedTests(file, fs.readFileSync(file, "utf-8"));
    tests.push(...parsed.tests);
    warningDetails.push(...parsed.warningDetails);
  }
  // Every warning, unfiltered: this population INCLUDES modified declarations,
  // so a tag array it cannot read really is a gap in its own truth — which is
  // why `collectBacklog()` refuses on it (`assertNoWarnings`).
  return { tests, warnings: warningDetails.map((w) => w.message), warningDetails };
}

/**
 * Parse one spec's SOURCE TEXT (no filesystem read) — the unit-testable seam
 * under `collectStableTests()`. `filePath` is only used to derive the reported
 * `modulePath` / `relativePath`, so it may point at a file that does not exist;
 * it must still be under `REGRESSION_ROOT` for those paths to come out right.
 *
 * A filter over `parseTaggedTests`: only a plain `test(...)` (no modifier —
 * `.skip` / `.fixme` / `.only` / `.fail` / `.slow` never run in the daily as
 * written, so counting one as validated coverage would overstate the release
 * signal) whose tags include `@stable`.
 *
 * **The warnings are filtered the same way**, and that is not cosmetic: both
 * consumers of this function treat a warning as fail-closed — `stable-tests.ts`
 * prints them and `check-checklist-coverage.ts` EXITS 1 on any — so forwarding
 * a warning about a declaration this population cannot contain turns the first
 * `test.skip(..., { tag: SHARED_TAGS })` anyone writes into a red PR whose
 * remediation is impossible to satisfy (`warningAffectsStable` above).
 * Fail-closed stays fail-closed for everything that IS this population's:
 * a plain declaration's unreadable tags, and a `test.describe` tag Playwright
 * propagates into one.
 */
export function parseStableTests(
  filePath: string,
  text: string,
): CollectResult {
  const { tests, warningDetails } = parseTaggedTests(filePath, text);
  const warnings = warningDetails.filter(warningAffectsStable).map((w) => w.message);
  const stable: StableTest[] = tests
    .filter((t) => t.modifier === "" && t.tags.includes(STABLE_TAG))
    .map(({ title, modulePath, specFile, relativePath, line }) => ({
      title,
      modulePath,
      specFile,
      relativePath,
      line,
    }));
  return { tests: stable, warnings };
}

/**
 * Every `@stable` `test()` call under `regression/`, sorted by module → spec →
 * source line, plus any non-fatal parse warnings.
 */
export function collectStableTests(): CollectResult {
  const all: StableTest[] = [];
  const warnings: string[] = [];
  for (const file of walkSpecs(REGRESSION_ROOT)) {
    const parsed = parseStableTests(file, fs.readFileSync(file, "utf-8"));
    all.push(...parsed.tests);
    warnings.push(...parsed.warnings);
  }
  all.sort((a, b) => {
    if (a.modulePath !== b.modulePath)
      return a.modulePath.localeCompare(b.modulePath);
    if (a.relativePath !== b.relativePath)
      return a.relativePath.localeCompare(b.relativePath);
    return a.line - b.line;
  });
  return { tests: all, warnings };
}

// ─── Declared suite size, OSS only ───────────────────────────────────────────

/**
 * `@enterprise` is a LANE selector, not a severity: `tests/fixtures/lane.ts`
 * grep-inverts it out of every run that does not set `PW_ENTERPRISE`, and the
 * tag is deliberately never combined with `@stable` because no scheduled
 * Enterprise lane exists (#1010). So an `@enterprise` test cannot be reached by
 * the nightly, by construction.
 */
export const ENTERPRISE_TAG = "@enterprise";

export interface DeclaredCounts {
  /** Every plain `test()` call under `regression/`, whatever it is tagged. */
  total: number;
  /** Those carrying `@enterprise`, directly or inherited from a `test.describe`. */
  enterprise: number;
  /** `total - enterprise` — the OSS suite a nightly can actually reach. */
  oss: number;
}

/**
 * Count the declared tests in one spec's SOURCE TEXT, split OSS / Enterprise.
 * The unit-testable seam under `collectDeclaredCounts()`.
 *
 * Unlike the `@stable` parser above, a `test.describe` tag is INHERITED rather
 * than warned about. The two want different things from the same situation:
 * Phase 0 lists individual tests, so a tag it cannot attribute to a `test()` is
 * a defect to report; a count only needs the total, and Playwright really does
 * apply a suite tag to every test inside it. Ignoring that here would count an
 * Enterprise suite as OSS and re-inflate the very number this exists to fix.
 */
export function parseDeclaredCounts(text: string): DeclaredCounts {
  const source = ts.createSourceFile(
    "declared.spec.ts",
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
  );

  let total = 0;
  let enterprise = 0;

  function visit(node: ts.Node, inheritedEnterprise: boolean): void {
    let childrenInherit = inheritedEnterprise;

    if (ts.isCallExpression(node)) {
      if (isDescribeCall(node) && node.arguments.length >= 2) {
        const { tags } = readTagsArray(node.arguments[1]);
        if (tags?.includes(ENTERPRISE_TAG)) childrenInherit = true;
      } else if (isPlainTestCall(node)) {
        total++;
        let isEnterprise = inheritedEnterprise;
        if (!isEnterprise && node.arguments.length >= 2) {
          const { tags } = readTagsArray(node.arguments[1]);
          if (tags?.includes(ENTERPRISE_TAG)) isEnterprise = true;
        }
        if (isEnterprise) enterprise++;
      }
    }

    ts.forEachChild(node, (child) => visit(child, childrenInherit));
  }

  visit(source, false);
  return { total, enterprise, oss: total - enterprise };
}

/** The same split across every spec under `regression/`. */
export function collectDeclaredCounts(): DeclaredCounts {
  const acc: DeclaredCounts = { total: 0, enterprise: 0, oss: 0 };
  for (const file of walkSpecs(REGRESSION_ROOT)) {
    const c = parseDeclaredCounts(fs.readFileSync(file, "utf-8"));
    acc.total += c.total;
    acc.enterprise += c.enterprise;
    acc.oss += c.oss;
  }
  return acc;
}

// ─── Declared tests with their tags (the orphan reconciler's input) ──────────

/**
 * Lane selectors, not severities. `tests/fixtures/lane.ts` grep-inverts each of
 * these out of every run that does not opt into its lane, and none of them is
 * ever combined with `@stable` because no scheduled lane exists for them
 * (#1010). A test that carries one is therefore out of the daily BY DESIGN —
 * the orphan reconciler must not read that as an unowned removal.
 */
export const LANE_TAGS = ["@destructive", "@enterprise", "@serving"] as const;

export interface DeclaredTest {
  /** Title as written in the declaring call's first argument. */
  title: string;
  /** Path under `regression/`, e.g. `core-components/loop-component-regression.spec.ts`. */
  relativePath: string;
  /** 1-based source line of the declaring call. */
  line: number;
  /**
   * Tags that reach the test: its own, in source order, plus any LANE tag
   * inherited from an enclosing `test.describe`. Inheriting the lane tags
   * matters for the same reason inheriting `@stable` does — Playwright applies
   * a suite tag to every test inside, so a suite hoisted to `@enterprise` would
   * otherwise turn every test in it into an orphan candidate.
   */
  tags: string[];
  /**
   * True when `@stable` reaches this test at all — on its own `tag` array or
   * inherited from an enclosing `test.describe`. Playwright's `--grep "@stable"`
   * honours the inherited form, so the daily really does run such a test; the
   * reconciler asks "is this test in the daily", which is that question and not
   * "is `@stable` written on this line".
   */
  stable: boolean;
  /**
   * Declared with a modifier that skips it before its body runs, on every lane
   * — `test.fixme(title, …)` or the declaring `test.skip(title, …)`.
   */
  fixme: boolean;
  /** A `tag` option existed but could not be read as an inline array of literals. */
  unparseableTags: boolean;
}

/**
 * Match a DECLARING call that also skips the test before its body runs —
 * `test.fixme(title, …)` and `test.skip(title, …)`.
 *
 * `test.skip` is in here for the reason the reconciler exists at all: without
 * it, a test quarantined with `test.skip("title", …)` is not a row in the
 * output — not an orphan, not owned, not UNKNOWN, simply absent, which is the
 * silent-nonexistent-path shape (#1092) inside the check written to end it.
 * There are none today, so this is latent rather than a live gap; that is why
 * it is a parser rule and not a report.
 *
 * The MODIFIER form (`test.skip(condition, "reason")`, called from inside a
 * test) cannot be confused with it: its first argument is a condition or an
 * arrow function, never a string literal, and it is not the two-arg
 * title-plus-body shape either.
 */
const DECLARING_SKIP_MODIFIERS = ["fixme", "skip"] as const;

function isSkippedDeclaration(call: ts.CallExpression): boolean {
  return (
    ts.isPropertyAccessExpression(call.expression) &&
    ts.isIdentifier(call.expression.expression) &&
    call.expression.expression.text === "test" &&
    (DECLARING_SKIP_MODIFIERS as readonly string[]).includes(
      call.expression.name.text,
    ) &&
    call.arguments.length >= 2 &&
    literalText(call.arguments[0]) !== null
  );
}

/**
 * Every declared test in one spec's SOURCE TEXT — `test(...)` and the declaring
 * forms of `test.fixme(...)` / `test.skip(...)` alike — with the tags that
 * reach it.
 *
 * Deliberately broader than `parseStableTests()`, which only ever needed the
 * `@stable` subset for the checklist blocks. The reconciler needs the
 * complement (a test WITHOUT `@stable`), so "no tag array at all" has to come
 * back as a row rather than as an absence.
 */
export function parseDeclaredTests(filePath: string, text: string): DeclaredTest[] {
  const source = ts.createSourceFile(
    filePath,
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
  );
  const relativePath = path
    .relative(REGRESSION_ROOT, filePath)
    .split(path.sep)
    .join("/");

  const out: DeclaredTest[] = [];

  function visit(
    node: ts.Node,
    inheritedStable: boolean,
    inheritedLane: string[],
  ): void {
    let childrenStable = inheritedStable;
    let childrenLane = inheritedLane;

    if (ts.isCallExpression(node)) {
      if (isDescribeCall(node) && node.arguments.length >= 2) {
        const { tags } = readTagsArray(node.arguments[1]);
        if (tags?.includes(STABLE_TAG)) childrenStable = true;
        const lane = (tags ?? []).filter((t) =>
          (LANE_TAGS as readonly string[]).includes(t),
        );
        if (lane.length > 0) childrenLane = [...inheritedLane, ...lane];
      } else if (isPlainTestCall(node) || isSkippedDeclaration(node)) {
        const title = literalText(node.arguments[0]);
        if (title !== null) {
          const { tags, unparseable } =
            node.arguments.length >= 2
              ? readTagsArray(node.arguments[1])
              : { tags: null, unparseable: false };
          const { line } = source.getLineAndCharacterOfPosition(
            node.getStart(source),
          );
          const own = tags ?? [];
          out.push({
            title,
            relativePath,
            line: line + 1,
            tags: [...own, ...inheritedLane.filter((t) => !own.includes(t))],
            stable: inheritedStable || own.includes(STABLE_TAG),
            fixme: isSkippedDeclaration(node),
            unparseableTags: unparseable,
          });
        }
      }
    }

    ts.forEachChild(node, (child) =>
      visit(child, childrenStable, childrenLane),
    );
  }

  visit(source, false, []);
  return out;
}

/** The same across every spec under `regression/`, sorted by path then line. */
export function collectDeclaredTests(): DeclaredTest[] {
  const all: DeclaredTest[] = [];
  for (const file of walkSpecs(REGRESSION_ROOT)) {
    all.push(...parseDeclaredTests(file, fs.readFileSync(file, "utf-8")));
  }
  all.sort((a, b) =>
    a.relativePath !== b.relativePath
      ? a.relativePath.localeCompare(b.relativePath)
      : a.line - b.line,
  );
  return all;
}
