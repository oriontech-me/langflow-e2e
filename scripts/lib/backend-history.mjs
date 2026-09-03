// Build the `backend` block of a run-history line (#1077).
//
// WHY THIS EXISTS. The mid-run worker wedge has been measured on #1077 since
// July, and every one of those measurements is a table someone typed by hand
// into a comment. The data behind them — the per-shard `liveness-N` artifacts —
// is uploaded with `retention-days: 7`, so a run drops out of reach a week after
// it happened: on 2026-09-02 the dailies of 08-24, 08-25 and 08-26 were already
// gone. #1077's first *Done when* asks for a BASELINE, and its second asks to
// compare a lever against it on four axes (outages per shard,
// `down_seconds_total`, per-shard wall clock, passed-spec count). Neither is
// possible against a series that evaporates, which is why the block lands in
// `reports/*-history.jsonl` — the one place in this repo that is durable,
// append-only and already committed back to `main`.
//
// It records; it decides nothing. No gate reads it, and it is deliberately NOT
// an input to the `@stable` auto-removal — that keys on the failure's own error
// signature (#1031), and the honesty note in `report-backend-outages.mjs`
// explains why overlap with an outage window is a lead and never a verdict.
//
// The numbers are the SAME numbers the merge job already renders into the
// umbrella issue: this module reuses `report-backend-outages.mjs`'s own
// `readSummaries` / `collectAttempts` / `attribute` rather than re-deriving
// them, so a row here and the section on the issue can never disagree about the
// run they both describe.
import {
  readSummaries,
  collectAttempts,
  attribute,
  normalizeSpecPath,
} from "../report-backend-outages.mjs";

/**
 * Per-spec-file test counts, in Playwright's own vocabulary.
 *
 * Counted over TESTS, not over attempts: `attribute()` already reports attempts
 * (the cost of a wedge is precisely that each collateral test burns its whole
 * retry budget), while the axis #1077 names is "passed-spec count" — the
 * coverage a lever must not trade away. The two answer different questions and
 * both are on the line.
 */
export function countByFile(report) {
  const byFile = new Map();
  const bump = (file, key) => {
    const norm = normalizeSpecPath(file);
    if (!byFile.has(norm)) byFile.set(norm, { passed: 0, failed: 0, flaky: 0, skipped: 0 });
    byFile.get(norm)[key] += 1;
  };
  const walk = (node, inheritedFile) => {
    const file = node.file || inheritedFile;
    for (const sub of node.suites || []) walk(sub, file);
    for (const spec of node.specs || []) {
      const specFile = spec.file || file;
      for (const test of spec.tests || []) {
        // Mirrors append-weekly-history.mjs's own mapping, so the per-shard
        // totals here sum to the line's run-level `totals` for the same run.
        if (test.status === "skipped") bump(specFile, "skipped");
        else if (test.status === "expected") bump(specFile, "passed");
        else if (test.status === "flaky") bump(specFile, "flaky");
        else bump(specFile, "failed");
      }
    }
  };
  for (const suite of report?.suites || []) walk(suite, suite.file);
  return byFile;
}

const emptyTotals = () => ({ passed: 0, failed: 0, flaky: 0, skipped: 0 });
const addTotals = (into, from) => {
  for (const key of Object.keys(into)) into[key] += from[key] || 0;
  return into;
};
const isZero = (t) => t.passed === 0 && t.failed === 0 && t.flaky === 0 && t.skipped === 0;
const round1 = (n) => Math.round(Number(n || 0) * 10) / 10;

/**
 * @param {object[]} summaries   per-shard `backend-liveness.json` summaries
 * @param {object|null} report   the merged Playwright JSON report
 * @param {number|null} shardTotal  the run's declared shard count, or null
 * @returns {object|null} the `backend` block, or null when no shard reported
 */
export function buildBackendBlock(summaries, report, shardTotal) {
  // No liveness data at all is the normal state OUTSIDE the daily (the weekly
  // lane, a local run, any caller that does not set LIVENESS_DIR). Omitting the
  // block there keeps a line that never had the measurement distinguishable
  // from one whose shards were measured and found silent — the second is
  // `shards_measured: 0`, which reads as UNKNOWN and never as a clean backend.
  if (!summaries.length) return null;

  const agg = attribute(summaries, collectAttempts(report));
  const byFile = countByFile(report);
  const claimed = new Set();

  const shards = agg.shards.map((shard, index) => {
    // Positional, not by label. `attribute()` maps `summaries` to its own
    // `shards` in order, so index IS the join — and re-deriving it from the
    // label reintroduces a collision the shared reporter does not have:
    // `watch-backend.mjs` writes `shard: ""` when WATCH_LABEL is unset, two
    // such summaries both read as "?", and a lookup would hand the second
    // shard the first one's totals. `daily-stable.yml` always sets the label;
    // a new lane is one forgotten env var away from not doing so.
    const summary = summaries[index];
    const totals = emptyTotals();
    // Deduplicated for the same reason `attribute()` deduplicates its own copy
    // of this list: `a.spec.ts` and `./a.spec.ts` are both accepted spellings
    // of one file, and counting a shard's file twice inflates that shard's
    // totals. `unassigned` below can only ever detect the UNDER-count, so a
    // duplicate would break the sum-to-run-totals invariant silently.
    for (const norm of new Set((summary?.files || []).map(normalizeSpecPath))) {
      claimed.add(norm);
      addTotals(totals, byFile.get(norm) || {});
    }
    return {
      shard: shard.shard,
      measured: shard.measured,
      outages: shard.outageCount,
      down_seconds: round1(shard.downSeconds),
      // The recorder's observed span (first probe → last probe), not the job's
      // duration: the recorder starts after the health gate and is killed in the
      // shard's teardown, so this is the window the outage shares are computed
      // against and the only wall clock the artifacts can support.
      span_seconds: round1(shard.spanSeconds),
      down_pct: round1(shard.downPct),
      failed_probes: shard.failedProbes,
      blips: shard.ignoredBlips,
      attempts: shard.attempts,
      failing: shard.failing,
      collateral: shard.collateral,
      totals,
    };
  });

  // A spec the merged report carries that no shard claimed. Named rather than
  // dropped (#1012): the per-shard totals would otherwise silently fail to sum
  // to the line's run-level `totals`, and the reader would have no way to tell
  // that from a shard having genuinely run nothing.
  const unassigned = emptyTotals();
  for (const [file, totals] of byFile) if (!claimed.has(file)) addTotals(unassigned, totals);

  return {
    // null, never 0: "the run did not declare a shard count" is not the same as
    // "the run had no shards", and only the first makes a silent shard — one
    // whose job died before writing a summary — undetectable.
    shard_total: Number.isFinite(shardTotal) && shardTotal > 0 ? shardTotal : null,
    shards_reported: agg.shards.length,
    shards_measured: agg.shardsMeasured,
    wedged: agg.wedged,
    outages_total: agg.outagesTotal,
    down_seconds_total: round1(agg.downSecondsTotal),
    blips_total: agg.blipsTotal,
    collateral_attempts: agg.collateralAttempts,
    shards,
    ...(isZero(unassigned) ? {} : { unassigned }),
  };
}

/** Read the summaries `dir` holds and build the block from them. */
export function backendBlockFromDir(dir, report, shardTotal) {
  return buildBackendBlock(readSummaries(dir), report, shardTotal);
}
