// Baseline math for the token consumption monitor (issue #1197).
//
// Deliberately crude: a median over the given history and a ratio threshold. A
// mean would let one expensive run raise the bar it is supposed to trip. No
// baseline means NO anomaly — a first run, or a spec seen for the first time, must
// never alarm, and a zero baseline is skipped rather than divided by.
//
// This module does NOT window the history to "the last N lines" itself — despite
// what an earlier version of this comment claimed (#1197 review, finding I7). It
// takes whatever `history` array the caller hands it and computes a plain median
// over the whole thing. Windowing to a recent slice (so the baseline tracks
// deliberate suite growth instead of staying anchored to a stale all-time median
// that would flag every run as an anomaly for months) is the CALLER's job —
// `summarize()` in `scripts/watch-tokens.mjs` slices to `ANOMALY_HISTORY_WINDOW`
// lines before calling `detectAnomalies()`. Keep it that way: a pure function
// with no notion of "recent" is what makes this module unit-testable without a
// clock or a real history file.
export function median(numbers) {
  const values = (numbers ?? [])
    .map(Number)
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  if (!values.length) return null;
  const mid = Math.floor(values.length / 2);
  return values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
}

// Two decimals silently loses a real sub-cent trace cost ($0.000035 is a typical
// SINGLE-trace spend, not noise) — round(0.000035) === 0, so both sides of the
// comparison print "$0.00" and the anomaly line reads as a contradiction ("run:
// $0.00 vs a $0.00 baseline (6×)", #1197 review, finding I5). Six decimals is
// enough to keep that visible; the ratio doesn't need the same precision, so it
// keeps its own, coarser rounding.
const ROUND_USD_DECIMALS = 6;
const ROUND_RATIO_DECIMALS = 2;
const roundUsd = (n) => Math.round(n * 10 ** ROUND_USD_DECIMALS) / 10 ** ROUND_USD_DECIMALS;
const roundRatio = (n) => Math.round(n * 10 ** ROUND_RATIO_DECIMALS) / 10 ** ROUND_RATIO_DECIMALS;

export function detectAnomalies({ run, history = [], minBaseline = 5, ratio = 3 } = {}) {
  const anomalies = [];
  if (!run || history.length < minBaseline) return anomalies;

  const runUsd = Number(run?.totals?.usd_estimated) || 0;
  const runBaseline = median(history.map((h) => h?.totals?.usd_estimated));
  if (runBaseline && runUsd / runBaseline >= ratio) {
    anomalies.push({
      scope: "run",
      key: "run",
      run_usd: roundUsd(runUsd),
      baseline_usd: roundUsd(runBaseline),
      ratio: roundRatio(runUsd / runBaseline),
    });
  }

  for (const spec of run?.by_spec ?? []) {
    const past = history
      .flatMap((h) => h?.by_spec ?? [])
      .filter((s) => s?.file === spec.file)
      .map((s) => s.usd_estimated);
    if (past.length < minBaseline) continue;
    const baseline = median(past);
    const usd = Number(spec.usd_estimated) || 0;
    if (baseline && usd / baseline >= ratio) {
      anomalies.push({
        scope: "spec",
        key: spec.file,
        run_usd: roundUsd(usd),
        baseline_usd: roundUsd(baseline),
        ratio: roundRatio(usd / baseline),
      });
    }
  }
  return anomalies;
}
