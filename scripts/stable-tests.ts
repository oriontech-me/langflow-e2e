/**
 * Regenerates the `Phase 0 — Validated` block (and the Coverage Summary Note
 * that points to it) inside QA-CHECKLIST.md by parsing `@stable` `test()`
 * calls from `tests/tests-automations/regression/**.spec.ts`.
 *
 * Run: `npx ts-node scripts/stable-tests.ts`
 *
 * Idempotent: a second run produces no diff when Phase 0 is in sync with the
 * `@stable` tags in the test source.
 *
 * Test titles are now the source of truth for the Phase 0 bullet text — they
 * surface in the rendered checklist as well as the Playwright report. Prefer
 * self-explanatory titles; wrap code substrings in backticks (Markdown inline
 * code) and template `${expr}` placeholders are rendered as `<expr>`.
 */

import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";

const REPO_ROOT = path.resolve(__dirname, "..");
const REGRESSION_ROOT = path.join(
  REPO_ROOT,
  "tests",
  "tests-automations",
  "regression",
);
const CHECKLIST_PATH = path.join(REPO_ROOT, "QA-CHECKLIST.md");

const STABLE_TAG = "@stable";

const warnings: string[] = [];

interface StableTest {
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

// ─── Filesystem walk ─────────────────────────────────────────────────────────

function walkSpecs(dir: string): string[] {
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

function parseStableTestsInFile(
  filePath: string,
  source: ts.SourceFile,
): StableTest[] {
  const out: StableTest[] = [];
  const relativePath = path
    .relative(REGRESSION_ROOT, filePath)
    .split(path.sep)
    .join("/");
  const modulePath = path.dirname(relativePath);

  function visit(node: ts.Node): void {
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
              "(e.g. `tag: [\"@stable\", ...]`) so it shows up in Phase 0.",
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

function collectStableTests(): StableTest[] {
  const all: StableTest[] = [];
  for (const file of walkSpecs(REGRESSION_ROOT)) {
    const text = fs.readFileSync(file, "utf-8");
    const source = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      /* setParentNodes */ true,
    );
    all.push(...parseStableTestsInFile(file, source));
  }
  all.sort((a, b) => {
    if (a.modulePath !== b.modulePath)
      return a.modulePath.localeCompare(b.modulePath);
    if (a.relativePath !== b.relativePath)
      return a.relativePath.localeCompare(b.relativePath);
    return a.line - b.line;
  });
  return all;
}

// ─── Markdown block builders ─────────────────────────────────────────────────

/**
 * Render a test title for the checklist. Replaces template literal
 * placeholders (e.g. `${provider}`) with angle-bracket markers (e.g.
 * `<provider>`) so they read as parameter names rather than leaking raw
 * template syntax into the rendered Markdown.
 */
function renderTitle(title: string): string {
  return title.replace(/\$\{([^}]+)\}/g, (_, expr) => `<${expr.trim()}>`);
}

function buildPhase0Block(tests: StableTest[]): string[] {
  const totalTests = tests.length;
  const distinctSpecs = new Set(tests.map((t) => t.relativePath)).size;

  const lines: string[] = [
    "### 🟢 Phase 0 — Validated",
    "",
    `> ${totalTests} \`test()\` calls carrying the \`@stable\` tag, distributed across ${distinctSpecs} spec`,
    "> files. Run weekly by the stable workflow. New specs are merged with all",
    "> tests tagged `@stable`; the tag is removed per-test during weekly triage",
    "> when a failure is classified as a test bug — so a spec may end up with a",
    "> mix of tagged and untagged tests over time.",
    "",
  ];

  // Group preserving sort order.
  const grouped = new Map<string, StableTest[]>();
  for (const t of tests) {
    const bucket = grouped.get(t.modulePath);
    if (bucket) bucket.push(t);
    else grouped.set(t.modulePath, [t]);
  }

  for (const [moduleKey, items] of grouped) {
    lines.push(`#### ${moduleKey}/`);
    for (const t of items) {
      lines.push(`- [x] ${renderTitle(t.title)} → \`${t.specFile}\``);
    }
    lines.push("");
  }

  return lines;
}

const NOTE_LINES: string[] = [
  "> Note: `Validated [x]` counts checklist bullets, not `test()` calls. The",
  "> `@stable` tag is per-`test()`, and a single `@stable` test may map to",
  "> several bullets via `test.step()` (e.g. the agent suite covers 7",
  "> bullets). The canonical list of `@stable` `test()` calls is in",
  "> **Phase 0 — Validated** below.",
];

// ─── Checklist patching ──────────────────────────────────────────────────────

function findIndex(
  lines: string[],
  pred: (l: string) => boolean,
  from = 0,
): number {
  for (let i = from; i < lines.length; i++) if (pred(lines[i])) return i;
  return -1;
}

function replaceNoteBlock(lines: string[]): string[] {
  const coverageHeader = findIndex(lines, (l) =>
    l.startsWith("## Coverage Summary"),
  );
  if (coverageHeader === -1) {
    throw new Error('Coverage Summary header not found ("## Coverage Summary")');
  }
  const noteStart = findIndex(
    lines,
    (l) => l.startsWith("> Note:"),
    coverageHeader,
  );
  if (noteStart === -1) {
    throw new Error(
      'Coverage Summary Note not found (line starting "> Note:" after "## Coverage Summary")',
    );
  }
  let noteEnd = noteStart;
  while (noteEnd + 1 < lines.length && lines[noteEnd + 1].startsWith(">")) {
    noteEnd++;
  }
  return [
    ...lines.slice(0, noteStart),
    ...NOTE_LINES,
    ...lines.slice(noteEnd + 1),
  ];
}

function replacePhase0Block(
  lines: string[],
  phase0Lines: string[],
): string[] {
  const phase0Header = "### 🟢 Phase 0 — Validated";
  const phase1Header = "### 🔵 Phase 1 — Next Delivery";

  const phase0Idx = findIndex(lines, (l) => l.trim() === phase0Header);
  if (phase0Idx === -1) {
    throw new Error(`Phase 0 header not found: "${phase0Header}"`);
  }
  const phase1Idx = findIndex(
    lines,
    (l) => l.trim() === phase1Header,
    phase0Idx + 1,
  );
  if (phase1Idx === -1) {
    throw new Error(`Phase 1 header not found: "${phase1Header}"`);
  }

  // Walk back from Phase 1 across blank lines to land on the `---` separator.
  let sepIdx = phase1Idx - 1;
  while (sepIdx > phase0Idx && lines[sepIdx].trim() === "") sepIdx--;
  if (lines[sepIdx].trim() !== "---") {
    throw new Error(`Expected "---" separator before "${phase1Header}"`);
  }

  return [
    ...lines.slice(0, phase0Idx),
    ...phase0Lines,
    ...lines.slice(sepIdx),
  ];
}

// ─── Main ────────────────────────────────────────────────────────────────────

function main(): void {
  const tests = collectStableTests();
  const phase0Lines = buildPhase0Block(tests);

  const original = fs.readFileSync(CHECKLIST_PATH, "utf-8");
  const trailingNewline = original.endsWith("\n");

  const lines = original.split("\n");
  if (trailingNewline) lines.pop();

  let updated = replaceNoteBlock(lines);
  updated = replacePhase0Block(updated, phase0Lines);

  let output = updated.join("\n");
  if (trailingNewline) output += "\n";

  const distinctSpecs = new Set(tests.map((t) => t.relativePath)).size;
  if (output === original) {
    console.log(
      `Phase 0 already up to date — ${tests.length} @stable test() calls across ${distinctSpecs} spec files.`,
    );
  } else {
    fs.writeFileSync(CHECKLIST_PATH, output, "utf-8");
    console.log(
      `Phase 0 regenerated in QA-CHECKLIST.md — ${tests.length} @stable test() calls across ${distinctSpecs} spec files.`,
    );
  }

  if (warnings.length > 0) {
    console.error(
      `\n${warnings.length} warning(s) — non-literal \`tag\` arrays may have caused @stable tests to be skipped:`,
    );
    for (const w of warnings) console.error(`  • ${w}`);
    process.exit(1);
  }
}

main();
