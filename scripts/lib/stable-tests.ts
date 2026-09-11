/**
 * Shared source of truth for "which `test()` calls carry `@stable`".
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
 */

import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";

// `playwright.config.ts`'s own lane exclusion, imported rather than restated so
// the completeness check (#1812) and the runner cannot disagree about which
// tests a normal listing contains. `lane.ts` is dependency-free by design — it
// imports nothing, Playwright included — so a script can read it.
import { resolveLane } from "../../tests/fixtures/lane";

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
    // Playwright's `tag` option is `string | string[]`, and the string form is as
    // real as the array one — it reaches `grepInvert` identically. Reading only
    // the array meant `{ tag: "@destructive" }` on a describe was invisible here
    // while the runner excluded the file: a false `missing` and a red daily
    // (#1812). Zero occurrences in this suite today, which is why widening it
    // changes no count anywhere.
    const single = literalText(init);
    if (single !== null) return { tags: [single], unparseable: false };
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

function parseStableTestsInFile(
  filePath: string,
  source: ts.SourceFile,
  warnings: string[],
): StableTest[] {
  const out: StableTest[] = [];
  const relativePath = path
    .relative(REGRESSION_ROOT, filePath)
    .split(path.sep)
    .join("/");
  const modulePath = path.dirname(relativePath);

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
        warnings.push(
          `${relativePath}:${line + 1} — \`@stable\` is declared on a \`test.describe\` block. ` +
            "Playwright applies it to every test inside, but this parser only reads per-`test()` " +
            "tags, so those tests would run in the daily while staying out of Phase 0 and the " +
            "checklist guard. Move `@stable` onto each `test(...)` call.",
        );
      }
    }
    if (ts.isCallExpression(node) && isPlainTestCall(node)) {
      const args = node.arguments;
      if (args.length >= 2) {
        const title = literalText(args[0]);
        const { tags, unparseable } = readTagsArray(args[1]);
        const { line } = source.getLineAndCharacterOfPosition(
          node.getStart(source),
        );
        if (unparseable) {
          warnings.push(
            `${relativePath}:${line + 1} — \`tag\` option is not an inline array of string literals; ` +
              "the script cannot determine if this test is `@stable`. Inline the array " +
              '(e.g. `tag: ["@stable", ...]`) so it shows up in Phase 0.',
          );
        }
        if (title !== null && tags && tags.includes(STABLE_TAG)) {
          out.push({
            title,
            modulePath,
            specFile: path.basename(relativePath),
            relativePath,
            line: line + 1,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(source);
  return out;
}

/**
 * Parse one spec's SOURCE TEXT (no filesystem read) — the unit-testable seam
 * under `collectStableTests()`. `filePath` is only used to derive the reported
 * `modulePath` / `relativePath`, so it may point at a file that does not exist;
 * it must still be under `REGRESSION_ROOT` for those paths to come out right.
 */
export function parseStableTests(
  filePath: string,
  text: string,
): CollectResult {
  const warnings: string[] = [];
  const source = ts.createSourceFile(
    filePath,
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
  );
  return { tests: parseStableTestsInFile(filePath, source, warnings), warnings };
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
  /**
   * The declaring token when `fixme` is true — `"fixme"` or `"skip"` — or
   * `""` for a plain `test(...)`. Additive alongside `fixme`: that boolean
   * answers "does this run in no lane", which is all a consumer filtering for
   * `@stable` needs, but the never-validated backlog's unmute step has to
   * tell the operator WHICH call to change back. Reading that back out of the
   * source with a regex is the same kind of instrument that produced wrong
   * claims elsewhere in this repo's own tooling (a substring read standing in
   * for a parse). This field is read off the exact AST node `fixme` already
   * inspects, never by re-reading the source line, so there stays one
   * authority for both questions.
   */
  modifier: string;
  /** A `tag` option existed but could not be read as an inline array of literals. */
  unparseableTags: boolean;
  /**
   * The string Playwright matches `--grep` / `grepInvert` against, minus the
   * file and project prefixes the caller knows and this parser does not.
   *
   * Playwright does NOT grep the tag array: `TestCase._grepTitleWithTags()`
   * joins every ancestor suite's title AND tags, then the test's own title and
   * tags, with spaces, and runs the pattern over that one string
   * (`node_modules/playwright/lib/common/test.js`). So a lane tag reaches
   * `grepInvert` through a `test.describe` TITLE, through a describe's tag
   * array, through the test's own title, and as a SUBSTRING of a longer token
   * (`@serving-identity`) — four routes an exact match over `tags` cannot see,
   * and every one of them a FALSE `missing` for #1812's detector, which is the
   * direction that gets a detector switched off.
   *
   * Reproduced rather than approximated, because the consumer's whole claim is
   * that it can predict what the listing will contain.
   */
  grepTitle: string;
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

/**
 * Stands in for a suite title this parser cannot evaluate — a template
 * substitution, an identifier, a call — inside `DeclaredTest.grepTitle`.
 *
 * Playwright greps the RUNTIME title, so such a segment could hold anything,
 * a lane tag included. Omitting it silently is what turns an unknown into a
 * confident "this file should have been listed" (#1812/#1012); the marker is
 * chosen so it can never match a lane pattern on its own.
 */
export const UNRESOLVED_TITLE = "\u27e8unresolved\u27e9";

/**
 * Does this grep string contain a segment whose RUNTIME value this parser could
 * not determine?
 *
 * Two shapes, because `literalText` renders them differently and both are real
 * in this suite: a `test.describe` title the parser cannot read at all becomes
 * `UNRESOLVED_TITLE`, while a template with substitutions comes back with its
 * `${expr}` source text in place of the value — 20 describe titles here are that
 * second form, almost all of them the provider-parametrized specs.
 */
export function hasUnresolvedTitleSegment(grepTitle: string): boolean {
  return grepTitle.includes(UNRESOLVED_TITLE) || grepTitle.includes("${");
}

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
    inheritedGrep: string[],
    inheritedUnparseable: boolean,
  ): void {
    let childrenStable = inheritedStable;
    let childrenLane = inheritedLane;
    let childrenGrep = inheritedGrep;
    let childrenUnparseable = inheritedUnparseable;

    if (ts.isCallExpression(node)) {
      if (isDescribeCall(node) && node.arguments.length >= 2) {
        const { tags, unparseable: describeUnparseable } = readTagsArray(
          node.arguments[1],
        );
        if (tags?.includes(STABLE_TAG)) childrenStable = true;
        const lane = (tags ?? []).filter((t) =>
          (LANE_TAGS as readonly string[]).includes(t),
        );
        if (lane.length > 0) childrenLane = [...inheritedLane, ...lane];
        // A suite `tag` this parser cannot read hides whatever it holds from
        // every child, INCLUDING a lane tag — and the child is what the report
        // is keyed on, so the unreadability has to travel down with it or the
        // file is counted as fully understood (#1812).
        if (describeUnparseable) childrenUnparseable = true;
        // The suite's TITLE and its WHOLE tag array, in Playwright's own order,
        // because that is what `_collectGrepTitlePath` pushes — not just the
        // lane tags `childrenLane` keeps for the reconciler.
        //
        // A title this parser cannot evaluate (a template substitution, an
        // identifier) becomes an explicit marker rather than being omitted:
        // Playwright greps the RUNTIME string, so the segment could hold
        // anything, and a silent omission is the shape that reports a file the
        // runner excluded as MISSING. The marker can never match a lane pattern
        // itself; `declaredStableSpecFiles` reads it to say so out loud.
        const describeTitle = literalText(node.arguments[0]);
        childrenGrep = [
          ...inheritedGrep,
          describeTitle !== null ? describeTitle : UNRESOLVED_TITLE,
          ...(tags ?? []),
        ];
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
          // Same node `isSkippedDeclaration` already matched: a plain `test(...)`
          // call's expression is a bare Identifier, so this reads "" for it and
          // the property-access name ("fixme" | "skip") for the other case —
          // never a second AST walk, never a source-text read.
          const modifier = ts.isPropertyAccessExpression(node.expression)
            ? node.expression.name.text
            : "";
          out.push({
            title,
            relativePath,
            line: line + 1,
            tags: [...own, ...inheritedLane.filter((t) => !own.includes(t))],
            stable: inheritedStable || own.includes(STABLE_TAG),
            fixme: isSkippedDeclaration(node),
            modifier,
            unparseableTags: unparseable || inheritedUnparseable,
            grepTitle: [...inheritedGrep, title, ...own].join(" "),
          });
        }
      }
    }

    ts.forEachChild(node, (child) =>
      visit(child, childrenStable, childrenLane, childrenGrep, childrenUnparseable),
    );
  }

  visit(source, false, [], [], false);
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

// ─── What the shard matrix EXPECTS the listing to contain (#1812) ────────────

/**
 * Playwright's own `testMatch`, copied from `playwright.config.ts`.
 *
 * Deliberately not `walkSpecs`'s `.spec.ts` suffix test. The two answer different
 * questions and must not be merged: `walkSpecs` feeds the Phase 0 / checklist
 * blocks, which are scoped to `regression/` and count what the repo publishes,
 * while this one has to reproduce EXACTLY the file set Playwright collects — a
 * `.spec.mts` is collected by the config (its comment says so in as many words)
 * and would otherwise read as a file the listing invented.
 */
export const SPEC_FILE_PATTERN = /\.spec\.[cm]?[jt]s$/;

/** `testDir` from `playwright.config.ts` — the root the JSON report's paths are relative to. */
export const TESTS_ROOT = path.join(REPO_ROOT, "tests");

/** Absolute paths of every Playwright-collectable spec under `dir`, recursively. */
export function walkCollectableSpecs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkCollectableSpecs(full));
    else if (entry.isFile() && SPEC_FILE_PATTERN.test(entry.name)) out.push(full);
  }
  return out;
}

export interface DeclaredStableSpecs {
  /** Absolute root the paths below are relative to. */
  root: string;
  /**
   * Files declaring at least one `@stable` test a NORMAL lane can select, POSIX
   * and sorted — i.e. what `playwright test --grep @stable --list` must contain.
   */
  files: string[];
  /**
   * Files whose every `@stable` test also carries a lane tag. Excluded from
   * `files` because `config.grepInvert` removes them from every normal listing,
   * and reported because `CLAUDE.md` forbids that combination (#1010): an entry
   * here is a spec that runs in no scheduled lane, not a detector artefact.
   */
  laneOnly: string[];
  /**
   * Files carrying a `tag` option this parser could not read — on a test or on
   * an enclosing `test.describe`. Their `@stable` membership AND their lane
   * membership are both UNKNOWN, so such a test counts toward neither `files`
   * nor `laneOnly`: a file whose every `@stable` test is undecidable appears
   * here alone, and may then show up as listed-only, which is the benign
   * direction (#1012).
   */
  unparseable: string[];
  /**
   * Files with an `@stable` test whose grep string this parser cannot fully
   * evaluate — a `test.describe` title built from a template substitution or an
   * identifier. They ARE counted in `files`, deliberately: 20 describe titles in
   * this suite are interpolated, most of them the provider-parametrized specs —
   * #1764's own family — and dropping them would blind the detector on exactly
   * the specs it exists for.
   *
   * What the unknown costs is one direction of certainty: if such a file turns
   * up as MISSING, the cause may be a lane tag arriving through the
   * interpolation, which Playwright greps and this parser cannot see. The
   * verdict says so rather than leaving the reader to discover it (#1012).
   */
  unresolvedTitles: string[];
}

/**
 * The spec files the daily's `--grep @stable --list` is expected to produce.
 *
 * Derived from the AST, never from a grep for the token: `@stable` appears in
 * prose all over this suite, and `CLAUDE.md` records that the loose substring
 * test overcounts by 8 files — one of whose only occurrence is the comment
 * "`@release`, never `@stable`".
 *
 * Scoped to `tests/`, not to `regression/`. Five listed files live outside the
 * regression tree (`collect-models.spec.ts` and the four `fixtures/*-gate.spec.ts`),
 * so the narrower scope reports them as phantom losses — measured, 242 against the
 * listing's 247.
 *
 * A test declared under a `test.describe` tagged `@stable` counts, because
 * Playwright's `--grep` honours the inherited tag and the daily therefore really
 * does run it; `parseDeclaredTests` already resolves that inheritance, and the
 * lane tags with it.
 */
export function declaredStableSpecFiles(
  root: string = TESTS_ROOT,
): DeclaredStableSpecs {
  const files: string[] = [];
  const laneOnly: string[] = [];
  const unparseable: string[] = [];
  const unresolvedTitles: string[] = [];
  // Which tests a normal listing EXCLUDES, decided by the same regex the config
  // excludes them with and over the same string Playwright matches it against.
  //
  // The first version tested `LANE_TAGS` for exact membership in the `tag` array
  // and, after one review, `String.includes` on the test's own title. Both are
  // narrower than Playwright, in the direction that costs a red day: the engine
  // runs `config.grepInvert` over `_grepTitleWithTags()` — every ancestor suite's
  // title AND tags, then the test's title and tags, space-joined, with the FILE
  // suite's title (the path relative to `testDir`) at the front — so a lane tag
  // reaches it through a `test.describe` title, through a describe's tag array,
  // and as a substring of a longer token (`@serving-identity`). Each of those was
  // measured against a real `--list`: the file was excluded from the listing and
  // counted by the declaration, i.e. a false `missing`, i.e. a red daily and an
  // umbrella naming a file that nothing lost.
  //
  // `resolveLane({})` rather than a regex of our own: the exclusion is
  // `playwright.config.ts`'s, so a fourth lane tag must not need a second edit
  // here to stay correct. `{}` is the normal run — no lane flag set — which is
  // the listing the daily's matrix is built from.
  const grepInvert = resolveLane({}).grepInvert;
  const excluded = (rel: string, t: DeclaredTest) =>
    !!grepInvert && grepInvert.test(`${rel} ${t.grepTitle}`);

  for (const abs of walkCollectableSpecs(root)) {
    const rel = path.relative(root, abs).split(path.sep).join("/");
    const tests = parseDeclaredTests(abs, fs.readFileSync(abs, "utf-8"));
    if (tests.some((t) => t.unparseableTags)) unparseable.push(rel);
    const stable = tests.filter((t) => t.stable);
    if (stable.length === 0) continue;
    // An unreadable tag option leaves the lane question UNDECIDABLE, so such a
    // test votes for neither bucket: claiming the file should have been listed
    // is the false-red direction, and claiming it is lane-only would hide a real
    // loss. It is reported in `unparseable` either way.
    const decidable = stable.filter((t) => !t.unparseableTags);
    if (stable.some((t) => hasUnresolvedTitleSegment(t.grepTitle)))
      unresolvedTitles.push(rel);
    if (decidable.length === 0) continue;
    if (decidable.some((t) => !excluded(rel, t))) files.push(rel);
    else laneOnly.push(rel);
  }
  const sort = (a: string, b: string) => a.localeCompare(b);
  return {
    root,
    files: files.sort(sort),
    laneOnly: laneOnly.sort(sort),
    unparseable: unparseable.sort(sort),
    unresolvedTitles: unresolvedTitles.sort(sort),
  };
}
