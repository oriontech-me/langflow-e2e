/**
 * Auto-remove the `@stable` tag from tests that hard-failed in a stable run.
 *
 * Leadership decision: on a hard failure (a test that failed ALL retries in a
 * scheduled daily/weekly run), the `@stable` tag is removed automatically, with
 * NO human review. Restoring the tag is the human-gated step (a later PR once
 * the test or Langflow is fixed). This script performs the removal.
 *
 * Run: `PLAYWRIGHT_JSON=results.json npx ts-node scripts/remove-stable-from-failures.ts`
 *
 * Safety:
 *  - Only `failures[]` (status "unexpected" = failed every retry) are targeted;
 *    flaky tests (passed on a retry) keep `@stable`, per the triage policy.
 *  - Mass-failure guard: if the number of hard failures exceeds MAX_AUTO_REMOVE
 *    (or the report is missing/empty — the suite never really ran), NOTHING is
 *    removed. A red day where everything fails is almost always infra (Langflow
 *    container didn't boot, network/model outage), not per-test rot, and must
 *    not quarantine the whole stable suite.
 *
 * Editing is AST-located + text-spliced: the TypeScript compiler API finds the
 * exact `"@stable"` element inside the `test(...)` `{ tag: [...] }` array, and
 * only that element (plus one adjacent comma) is removed from the raw source,
 * so all other formatting/comments are preserved.
 *
 * Output: a single JSON object on stdout describing what happened, for the
 * caller (workflow / composite action) to build the commit message + issue body.
 */

import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";

const REPO_ROOT = path.resolve(__dirname, "..");
const STABLE_TAG = "@stable";

const reportPath = process.env.PLAYWRIGHT_JSON || "results.json";
const MAX_AUTO_REMOVE = Number.parseInt(process.env.MAX_AUTO_REMOVE || "5", 10);

interface Failure {
  title: string;
  file: string; // absolute path
  line: number; // 1-based test() line, as Playwright reports it
}

interface Removed {
  file: string; // repo-relative
  title: string;
  line: number;
  soleTag: boolean; // true if @stable was the ONLY tag (array left empty)
}

interface Skipped {
  file: string; // repo-relative
  title: string;
  line: number;
  reason: string;
}

// ─── Parse hard failures out of the Playwright JSON report ───────────────────
// Mirrors scripts/build-run-payload.mjs: only status "unexpected" counts as a
// hard failure; "flaky"/"skipped"/"expected" are ignored.

function collectHardFailures(reportFile: string): Failure[] {
  if (!fs.existsSync(reportFile)) return [];
  let report: any;
  try {
    report = JSON.parse(fs.readFileSync(reportFile, "utf8"));
  } catch {
    return [];
  }
  const failures: Failure[] = [];
  const resolveFile = (spec: any): string => {
    const f = spec?.file || spec?.location?.file || "";
    return path.isAbsolute(f) ? f : path.resolve(REPO_ROOT, f);
  };
  const visit = (node: any): void => {
    for (const spec of node.specs || []) {
      const file = resolveFile(spec);
      const line = spec?.line || spec?.location?.line || 0;
      for (const t of spec.tests || []) {
        if (t.status === "unexpected") {
          failures.push({ title: spec.title, file, line });
        }
      }
    }
    for (const child of node.suites || []) visit(child);
  };
  for (const s of report.suites || []) visit(s);
  return failures;
}

// ─── AST: find the `"@stable"` element inside a matching test()'s tag array ──

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

function isPlainTestCall(call: ts.CallExpression): boolean {
  return ts.isIdentifier(call.expression) && call.expression.text === "test";
}

/** The `@stable` string element node within `test()`'s tag array, if present. */
function findStableElement(
  call: ts.CallExpression,
): ts.ArrayLiteralExpression["elements"][number] | null {
  if (call.arguments.length < 2) return null;
  const opts = call.arguments[1];
  if (!ts.isObjectLiteralExpression(opts)) return null;
  for (const prop of opts.properties) {
    if (
      !ts.isPropertyAssignment(prop) ||
      !ts.isIdentifier(prop.name) ||
      prop.name.text !== "tag"
    ) {
      continue;
    }
    if (!ts.isArrayLiteralExpression(prop.initializer)) return null;
    for (const el of prop.initializer.elements) {
      if (literalText(el) === STABLE_TAG) return el;
    }
  }
  return null;
}

interface Match {
  element: ts.ArrayLiteralExpression["elements"][number];
  array: ts.ArrayLiteralExpression;
  line: number; // 1-based line of the test() call
}

/** All test() calls in `source` that carry `@stable`, with their line + element. */
function stableTestMatches(source: ts.SourceFile): Map<string, Match[]> {
  // keyed by title so we can match a failure by title (+ line as tiebreaker)
  const byTitle = new Map<string, Match[]>();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isPlainTestCall(node)) {
      const title = node.arguments.length >= 1 ? literalText(node.arguments[0]) : null;
      const element = findStableElement(node);
      if (title !== null && element) {
        const array = element.parent as ts.ArrayLiteralExpression;
        const line =
          source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        const list = byTitle.get(title) || [];
        list.push({ element, array, line });
        byTitle.set(title, list);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return byTitle;
}

/** Character range [start, end) to delete to drop one array element cleanly. */
function spliceRange(
  match: Match,
  source: ts.SourceFile,
): { start: number; end: number; soleTag: boolean } {
  const elements = match.array.elements;
  const idx = elements.indexOf(match.element);
  const el = match.element;
  if (elements.length === 1) {
    // Only tag: leave `[]`. Rare — @stable is normally paired with @release etc.
    return { start: el.getStart(source), end: el.getEnd(), soleTag: true };
  }
  if (idx < elements.length - 1) {
    // Not last: eat element + trailing comma + whitespace up to the next element.
    return {
      start: el.getStart(source),
      end: elements[idx + 1].getStart(source),
      soleTag: false,
    };
  }
  // Last element: eat leading comma + whitespace + element.
  return {
    start: elements[idx - 1].getEnd(),
    end: el.getEnd(),
    soleTag: false,
  };
}

// ─── Main ────────────────────────────────────────────────────────────────────

function main(): void {
  const failures = collectHardFailures(reportPath);

  const result: {
    status: "removed" | "none" | "guard_tripped";
    threshold: number;
    hardFailures: number;
    removed: Removed[];
    skipped: Skipped[];
  } = {
    status: "none",
    threshold: MAX_AUTO_REMOVE,
    hardFailures: failures.length,
    removed: [],
    skipped: [],
  };

  if (failures.length === 0) {
    process.stdout.write(JSON.stringify(result));
    return;
  }

  // Mass-failure guard: too many hard failures => treat as infra, remove nothing.
  if (failures.length > MAX_AUTO_REMOVE) {
    result.status = "guard_tripped";
    process.stdout.write(JSON.stringify(result));
    return;
  }

  // Group failures by file so each file is parsed + written once.
  const byFile = new Map<string, Failure[]>();
  for (const f of failures) {
    const list = byFile.get(f.file) || [];
    list.push(f);
    byFile.set(f.file, list);
  }

  for (const [file, fileFailures] of byFile) {
    const rel = path.relative(REPO_ROOT, file);
    if (!fs.existsSync(file)) {
      for (const f of fileFailures)
        result.skipped.push({ file: rel, title: f.title, line: f.line, reason: "spec file not found" });
      continue;
    }
    let text = fs.readFileSync(file, "utf8");
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const matches = stableTestMatches(source);

    // Resolve each failure to a single @stable test() element, then splice from
    // the END of the file backwards so earlier offsets stay valid.
    const ranges: Array<{ start: number; end: number; removed: Removed }> = [];
    for (const f of fileFailures) {
      const candidates = matches.get(f.title) || [];
      let match: Match | undefined;
      if (candidates.length === 1) {
        match = candidates[0];
      } else if (candidates.length > 1) {
        // Duplicate titles in one file: disambiguate by the reported line.
        match = candidates.find((c) => c.line === f.line);
      }
      if (!match) {
        // No @stable in the test()'s own tag array. Either it's inherited from a
        // describe block (not per-test removable) or the title didn't resolve.
        result.skipped.push({
          file: rel,
          title: f.title,
          line: f.line,
          reason: candidates.length
            ? "ambiguous title, no line match"
            : "no per-test @stable (describe-level tag or title mismatch)",
        });
        continue;
      }
      const { start, end, soleTag } = spliceRange(match, source);
      ranges.push({
        start,
        end,
        removed: { file: rel, title: f.title, line: match.line, soleTag },
      });
    }

    if (ranges.length === 0) continue;
    ranges.sort((a, b) => b.start - a.start); // splice back-to-front
    for (const r of ranges) {
      text = text.slice(0, r.start) + text.slice(r.end);
      result.removed.push(r.removed);
    }
    fs.writeFileSync(file, text);
  }

  result.status = result.removed.length > 0 ? "removed" : "none";
  process.stdout.write(JSON.stringify(result));
}

main();
