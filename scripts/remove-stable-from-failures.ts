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
 *  - Infra-signature exemption (#1031): a hard failure whose last error is a
 *    transport-level error (see `scripts/lib/infra-signatures.ts`) is NOT
 *    attributable to the spec that reported it — it is collateral of a wedged
 *    backend (#1030/#1048). It is excluded from removal INDEPENDENTLY of the
 *    mass-failure guard, which only covers the wide wedge; the narrow one (a
 *    wedge costing ≤ MAX_AUTO_REMOVE tests) used to strip innocent tags.
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
import { classifyInfraError, stripAnsi } from "./lib/infra-signatures";

const REPO_ROOT = path.resolve(__dirname, "..");
const STABLE_TAG = "@stable";

const reportPath = process.env.PLAYWRIGHT_JSON || "results.json";
const MAX_AUTO_REMOVE = Number.parseInt(process.env.MAX_AUTO_REMOVE || "5", 10);
/**
 * Corroboration only, from `report-backend-outages.mjs`'s `wedged` output
 * (#1030): "true" | "false" | "" (unmeasured / step skipped). It changes the
 * WORDING of the exemption, never the decision — the exemption has to hold when
 * the liveness recorder produced nothing, which is exactly the run where the
 * backend state is least known.
 */
const BACKEND_WEDGED = process.env.BACKEND_WEDGED || "";

interface Failure {
  title: string;
  file: string; // absolute path
  line: number; // 1-based test() line, as Playwright reports it
  /** Last failed attempt's error, ANSI-stripped and truncated; "" if none. */
  error: string;
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

/** A hard failure the run cannot attribute to its spec (#1031). */
interface Exempt {
  file: string; // repo-relative
  title: string;
  line: number;
  /** `InfraSignature.id` that matched, e.g. `api-request-timeout`. */
  signature: string;
  /** Why that signature cannot be the spec's own fault. */
  why: string;
  /** The matched error text, truncated for the issue body. */
  error: string;
}

// ─── Parse hard failures out of the Playwright JSON report ───────────────────
// Mirrors scripts/build-run-payload.mjs: only status "unexpected" counts as a
// hard failure; "flaky"/"skipped"/"expected" are ignored.

/**
 * Base directories to try, in order, when resolving a non-absolute spec path
 * from the report. The Playwright JSON reporter emits `spec.file` relative to
 * the Playwright `rootDir` (`<repo>/tests`, from `testDir: "./tests"`), NOT the
 * repo root — so `REPO_ROOT` alone never matches and every failure was silently
 * skipped as "spec file not found" (issue #476). We prefer the report's own
 * `config.rootDir` (absolute, correct in the run that produced it), then the
 * conventional `<repo>/tests`, then `REPO_ROOT` as a last resort, and pick the
 * first base under which the file actually exists on disk.
 */
function candidateBases(report: any): string[] {
  const bases: string[] = [];
  const rootDir = report?.config?.rootDir;
  if (typeof rootDir === "string" && rootDir) bases.push(rootDir);
  bases.push(path.join(REPO_ROOT, "tests"));
  bases.push(REPO_ROOT);
  return bases;
}

/** Max error characters carried into the result JSON / issue body. */
const ERROR_MAX = 240;

/**
 * The error of the LAST failed attempt — the same result `build-run-payload.mjs`
 * picks for `error_signature`, so the exemption and the history file talk about
 * the same attempt. Last, not first: retries are what a wedge burns, and the
 * final attempt is the one that decided the verdict.
 *
 * Unlike `firstErr` there, this keeps the whole message (plus the stack) rather
 * than its first line — a transport error is often the *cause* line under an
 * assertion header, and truncating to line one would hide it.
 */
export function lastFailureError(test: any): string {
  const results: any[] = Array.isArray(test?.results) ? test.results : [];
  const lastFailed =
    [...results].reverse().find((r) => r?.status !== "passed" && r?.status !== "skipped") ??
    results[results.length - 1];
  const e = lastFailed?.error || lastFailed?.errors?.[0];
  if (!e) return "";
  const message = stripAnsi(e.message || e.value || "");
  const stack = stripAnsi(e.stack || "");
  const combined = stack && !message.includes(stack) ? `${message}\n${stack}` : message || stack;
  return combined.slice(0, ERROR_MAX);
}

export function collectHardFailures(reportFile: string): Failure[] {
  if (!fs.existsSync(reportFile)) return [];
  let report: any;
  try {
    report = JSON.parse(fs.readFileSync(reportFile, "utf8"));
  } catch {
    return [];
  }
  const failures: Failure[] = [];
  const bases = candidateBases(report);
  const resolveFile = (spec: any): string => {
    const f = spec?.file || spec?.location?.file || "";
    if (!f) return "";
    if (path.isAbsolute(f)) return f;
    for (const base of bases) {
      const candidate = path.resolve(base, f);
      if (fs.existsSync(candidate)) return candidate;
    }
    // Nothing matched: return the tests/-rebased path (the correct base per
    // testDir) so the downstream "spec file not found" skip is meaningful.
    return path.resolve(path.join(REPO_ROOT, "tests"), f);
  };
  const visit = (node: any): void => {
    for (const spec of node.specs || []) {
      const file = resolveFile(spec);
      const line = spec?.line || spec?.location?.line || 0;
      for (const t of spec.tests || []) {
        if (t.status === "unexpected") {
          failures.push({ title: spec.title, file, line, error: lastFailureError(t) });
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
  const allFailures = collectHardFailures(reportPath);

  // Partition BEFORE the guard, and report both sides in every branch (#1031).
  // Doing it after would lose the collateral labelling on precisely the run that
  // motivated this — the wide wedge, where the guard returns early.
  const failures: Failure[] = [];
  const exempt: Exempt[] = [];
  for (const f of allFailures) {
    const signature = classifyInfraError(f.error);
    if (!signature) {
      failures.push(f);
      continue;
    }
    exempt.push({
      file: path.relative(REPO_ROOT, f.file),
      title: f.title,
      line: f.line,
      signature: signature.id,
      why: signature.why,
      error: f.error,
    });
  }

  const result: {
    status: "removed" | "none" | "guard_tripped";
    threshold: number;
    /** Every hard failure in the report, exempt ones included. */
    hardFailures: number;
    /** Hard failures the run CAN attribute to their spec — the removal candidates. */
    attributableFailures: number;
    removed: Removed[];
    skipped: Skipped[];
    exempt: Exempt[];
    /** "true" | "false" | "" — the #1030 liveness verdict, for wording only. */
    backendWedged: string;
  } = {
    status: "none",
    threshold: MAX_AUTO_REMOVE,
    hardFailures: allFailures.length,
    attributableFailures: failures.length,
    removed: [],
    skipped: [],
    exempt,
    backendWedged: BACKEND_WEDGED,
  };

  if (failures.length === 0) {
    process.stdout.write(JSON.stringify(result));
    return;
  }

  // Mass-failure guard: too many hard failures => treat as infra, remove nothing.
  //
  // Counts EVERY hard failure, not just the attributable ones. Netting the
  // exempt ones out would make the mechanism strictly more aggressive than it
  // is today: on run 30374528125 (19 failures, 14 with an infra signature) the
  // guard trips and removes nothing, while an attributable-only count would
  // remove 5 tags with no review. #1031 asks to protect innocent specs, not to
  // widen auto-removal's reach — so the removal set here is always a subset of
  // what the pre-#1031 script would have produced.
  if (allFailures.length > MAX_AUTO_REMOVE) {
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

  // Fail louder: a "spec file not found" skip means path resolution is broken
  // (the exact failure mode of #476) — the report has real hard failures we
  // couldn't act on. Surface a GitHub Actions warning annotation on stderr so
  // it's visible in the log instead of exiting quietly as `none`.
  const notFound = result.skipped.filter((s) => s.reason === "spec file not found");
  if (notFound.length > 0) {
    process.stderr.write(
      `::warning title=Auto-remove @stable::${notFound.length} hard failure(s) skipped because their spec file could not be resolved on disk — path resolution may be broken (see #476). Files: ${notFound
        .map((s) => s.file)
        .join(", ")}\n`,
    );
  }

  process.stdout.write(JSON.stringify(result));
}

// Only run when invoked as a script — keeps the module importable from tests.
if (require.main === module) {
  main();
}
