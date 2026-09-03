/**
 * How much of the in-scope OSS API is covered (#1692).
 *
 *   npx playwright test --grep @api        # produces the per-test records
 *   npm run api:coverage                  # aggregates and prints
 *
 * Reads the committed surface baseline (`tests/assets/api/api-surface-baseline.json`)
 * and the per-test records the `apiCoverage` fixture wrote under
 * `test-results/api-coverage/`, and reports `covered / in-scope` per family with
 * **every uncovered operation named**. A bare percentage hides which ones, which
 * is the lesson `reports/spec-durations.json` paid for (#1326): "170 of 178 have
 * a duration" read as a rounding error while hiding that the missing ones were
 * the expensive ones.
 *
 * Definitions — the full argument is in `docs/api/api-surface-coverage-gauge.md`:
 * an operation is covered when an `@api` spec drove it on purpose (declared it)
 * and asserted its contract (the test passed). Incidental traffic earns nothing.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  describeBaselineDefect,
  inScopeOperations,
  opKey,
  type ApiScopeExclusion,
  type ApiSurfaceBaseline,
} from "../tests/helpers/other/api-surface-drift";
import { COVERAGE_DIR, type CoverageRecord } from "../tests/fixtures/api-coverage";

const BASELINE_PATH = path.join(
  __dirname,
  "../tests/assets/api/api-surface-baseline.json",
);

/**
 * Only the regression suite can cover the product.
 *
 * Found the first time the report ran: `tests/fixtures/api-coverage-gate.spec.ts`
 * declares real operation keys and issues them against a **local stub server**,
 * so it credited three operations while asserting nothing about Langflow. A
 * fixture gate spec is a self-test of the harness, and the harness cannot be
 * evidence about the product.
 */
const COVERING_PREFIX = "tests/tests-automations/";

export interface FamilyCoverage {
  family: string;
  total: number;
  covered: number;
  uncovered: string[];
}

export interface CoverageResult {
  version?: string;
  inScope: number;
  covered: number;
  excludedCount: number;
  exclusions: ApiScopeExclusion[];
  uncovered: string[];
  families: FamilyCoverage[];
  /** Records read; 0 means unmeasured, not uncovered. */
  recordCount: number;
  /** Declared, but sitting in an excluded family — the spec and the list disagree. */
  declaredOutOfScope: string[];
  /** Declared, but absent from the surface — a typo, or a route upstream removed. */
  declaredNotInSurface: string[];
  /** Spec files whose records were dropped because the file is gone. */
  staleDropped?: string[];
}

/**
 * Records whose spec file still exists, and the paths of the ones dropped.
 *
 * Records survive between runs (see `COVERAGE_DIR`), which is what lets the
 * `@destructive` lane's second run add to the first's instead of replacing it.
 * The cost of surviving is staleness: a renamed or deleted test would keep
 * holding coverage forever, so its record goes — and is named, because a number
 * that falls with no explanation is the report shape #1012 forbids.
 */
export function dropStaleRecords(
  records: CoverageRecord[],
  exists: (file: string) => boolean = (file) =>
    fs.existsSync(path.join(__dirname, "..", file)),
): { kept: CoverageRecord[]; dropped: string[] } {
  const kept: CoverageRecord[] = [];
  const dropped: string[] = [];
  for (const rec of records) {
    if (exists(String(rec?.file ?? ""))) kept.push(rec);
    else dropped.push(String(rec?.file ?? "(no file)"));
  }
  return { kept, dropped: [...new Set(dropped)].sort() };
}

/** `/api/v2/files/{file_id}` → `/api/v2/files`. */
function familyOf(p: string): string {
  const parts = p.split("/").filter((s) => s !== "");
  return `/${parts.slice(0, 3).join("/")}`;
}

export function aggregateCoverage(
  baseline: ApiSurfaceBaseline,
  records: CoverageRecord[],
): CoverageResult {
  const defect = describeBaselineDefect(baseline);
  if (defect) {
    // A 0/0 report reads as "nothing to do" — the false-clean verdict the gauge
    // exists to prevent (#1012).
    throw new Error(`the surface baseline is unusable — ${defect}`);
  }

  // Records from outside the regression suite are dropped before anything is
  // counted — including `recordCount`, which is what tells a reader the run
  // measured nothing at all.
  const covering = records.filter((rec) =>
    String(rec?.file ?? "").startsWith(COVERING_PREFIX),
  );

  const inScope = inScopeOperations(baseline);
  const inScopeKeys = new Set(inScope.map((op) => opKey(op.method, op.path)));
  const allKeys = new Set(
    baseline.operations.map((op) => opKey(op.method, op.path)),
  );

  const covered = new Set<string>();
  const declaredOutOfScope = new Set<string>();
  const declaredNotInSurface = new Set<string>();
  for (const rec of covering) {
    for (const op of rec.declared ?? []) {
      if (inScopeKeys.has(op)) continue;
      // Two author errors that need different fixes: an excluded family means
      // the spec and the exclusion list disagree; an unknown key means a typo or
      // a route upstream dropped.
      (allKeys.has(op) ? declaredOutOfScope : declaredNotInSurface).add(op);
    }
    for (const op of rec.covered ?? []) {
      if (inScopeKeys.has(op)) covered.add(op);
    }
  }

  const byFamily = new Map<string, FamilyCoverage>();
  for (const op of inScope) {
    const key = opKey(op.method, op.path);
    const family = familyOf(op.path);
    const entry = byFamily.get(family) ?? {
      family,
      total: 0,
      covered: 0,
      uncovered: [],
    };
    entry.total += 1;
    if (covered.has(key)) entry.covered += 1;
    else entry.uncovered.push(key);
    byFamily.set(family, entry);
  }
  for (const entry of byFamily.values()) entry.uncovered.sort();

  return {
    version: baseline.version,
    inScope: inScope.length,
    covered: covered.size,
    excludedCount: baseline.operations.length - inScope.length,
    exclusions: baseline.exclusions ?? [],
    uncovered: [...inScopeKeys].filter((k) => !covered.has(k)).sort(),
    // Ordered by what is left to do, so the report opens on the actionable end.
    families: [...byFamily.values()].sort(
      (a, b) =>
        b.total - b.covered - (a.total - a.covered) ||
        a.family.localeCompare(b.family),
    ),
    recordCount: covering.length,
    declaredOutOfScope: [...declaredOutOfScope].sort(),
    declaredNotInSurface: [...declaredNotInSurface].sort(),
  };
}

export function formatCoverageReport(result: CoverageResult): string {
  const pct =
    result.inScope > 0 ? Math.round((result.covered / result.inScope) * 100) : 0;
  const lines: string[] = [];

  // Counts FIRST. Appending caveats as they occur puts the lists above the one
  // figure a reader opens this for (#1226).
  lines.push(
    `API coverage: ${result.covered} / ${result.inScope} in-scope operations (${pct}%)` +
      (result.version ? ` — surface baseline: Langflow ${result.version}` : ""),
  );
  lines.push(
    `  ${result.excludedCount} operation(s) excluded from the denominator, ${result.recordCount} per-test record(s) read`,
  );
  lines.push("");

  lines.push("Per family (most left to do first):");
  for (const f of result.families) {
    lines.push(`  ${String(f.covered).padStart(3)}/${String(f.total).padEnd(3)} ${f.family}`);
  }
  lines.push("");

  if (result.recordCount === 0) {
    // 0/199 from an empty directory means unmeasured, not uncovered, and the
    // two must not print the same way (#1012).
    lines.push(
      `⚠ no per-test coverage record was found under ${path.relative(process.cwd(), COVERAGE_DIR)} —`,
    );
    lines.push(
      "  this run measured nothing. Run the @api specs first: npx playwright test --grep @api",
    );
    lines.push("");
  }

  if (result.uncovered.length > 0) {
    lines.push(`Uncovered (${result.uncovered.length}):`);
    for (const op of result.uncovered) lines.push(`  ${op}`);
    lines.push("");
  }

  if (result.staleDropped && result.staleDropped.length > 0) {
    lines.push("⚠ dropped stale record(s) — the spec file no longer exists:");
    for (const f of result.staleDropped) lines.push(`  ${f}`);
    lines.push("");
  }

  if (result.declaredOutOfScope.length > 0) {
    lines.push("⚠ declared by a spec but OUT OF SCOPE — the spec and the exclusion list disagree:");
    for (const op of result.declaredOutOfScope) lines.push(`  ${op}`);
    lines.push("");
  }
  if (result.declaredNotInSurface.length > 0) {
    lines.push("⚠ declared by a spec but NOT IN THE SURFACE — a typo, or a route upstream removed:");
    for (const op of result.declaredNotInSurface) lines.push(`  ${op}`);
    lines.push("");
  }

  lines.push("Excluded from the denominator:");
  for (const e of result.exclusions) {
    lines.push(`  ${e.prefix}`);
    lines.push(`    ${e.reason}`);
  }
  return lines.join("\n");
}

/** Every per-test record on disk. A directory that is missing means zero records. */
export function readRecords(dir: string = COVERAGE_DIR): CoverageRecord[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const records: CoverageRecord[] = [];
  for (const name of names) {
    try {
      records.push(JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")));
    } catch (e) {
      // Named, never skipped in silence: a record this cannot read is coverage
      // the report is about to under-count.
      console.warn(
        `⚠ could not read coverage record ${name} — ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  return records;
}

function main(): void {
  let baseline: ApiSurfaceBaseline;
  try {
    baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8"));
  } catch (e) {
    console.error(
      `✖ could not read ${path.relative(process.cwd(), BASELINE_PATH)} — ${e instanceof Error ? e.message : String(e)}\n` +
        "  Generate it with: npm run api:baseline",
    );
    process.exit(1);
    return;
  }
  if (process.argv.includes("--reset")) {
    fs.rmSync(COVERAGE_DIR, { recursive: true, force: true });
    console.log(
      `cleared ${path.relative(process.cwd(), COVERAGE_DIR)} — the next run starts measuring from scratch`,
    );
    return;
  }
  try {
    const { kept, dropped } = dropStaleRecords(readRecords());
    console.log(
      formatCoverageReport({
        ...aggregateCoverage(baseline, kept),
        staleDropped: dropped,
      }),
    );
  } catch (e) {
    console.error(`✖ ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}

if (require.main === module) main();
