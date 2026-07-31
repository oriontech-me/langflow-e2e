// Baseline math for the token consumption monitor (issue #1197).
//
// Deliberately crude: a median over the last N history lines and a ratio threshold.
// A mean would let one expensive run raise the bar it is supposed to trip. No
// baseline means NO anomaly — a first run, or a spec seen for the first time, must
// never alarm, and a zero baseline is skipped rather than divided by.
export function median(numbers) {
  const values = (numbers ?? [])
    .map(Number)
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  if (!values.length) return null;
  const mid = Math.floor(values.length / 2);
  return values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
}

const round = (n) => Math.round(n * 100) / 100;

export function detectAnomalies({ run, history = [], minBaseline = 5, ratio = 3 } = {}) {
  const anomalies = [];
  if (!run || history.length < minBaseline) return anomalies;

  const runUsd = Number(run?.totals?.usd_estimated) || 0;
  const runBaseline = median(history.map((h) => h?.totals?.usd_estimated));
  if (runBaseline && runUsd / runBaseline >= ratio) {
    anomalies.push({
      scope: "run",
      key: "run",
      run_usd: round(runUsd),
      baseline_usd: round(runBaseline),
      ratio: round(runUsd / runBaseline),
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
        run_usd: round(usd),
        baseline_usd: round(baseline),
        ratio: round(usd / baseline),
      });
    }
  }
  return anomalies;
}
