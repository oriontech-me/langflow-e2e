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
