// Pure, I/O-free triage helpers. Everything here is unit-tested with fixtures;
// all filesystem / gh access lives in build-triage-dataset.mjs.

/** Parse JSONL history text into an array of run rows (chronological order). */
export function parseHistory(text) {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

/** Last run row that had at least one hard failure or flake; null if all green. */
export function findLatestRedRun(rows) {
  for (let i = rows.length - 1; i >= 0; i--) {
    const t = rows[i].totals || {};
    if ((t.failed || 0) > 0 || (t.flaky || 0) > 0) return rows[i];
  }
  return null;
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\[[0-9;]*m/g;

/** Strip ANSI SGR escape sequences. */
export function stripAnsi(s) {
  return String(s || '').replace(ANSI_RE, '');
}

/** Canonical form for comparing error signatures across runs. */
export function normalizeSignature(sig) {
  return stripAnsi(sig).replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Days between two YYYY-MM-DD dates (a - b), UTC, calendar days. */
function daysBetween(a, b) {
  const ms = Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z');
  return Math.round(ms / 86400000);
}

/** Rows whose date falls in [asOfDate - windowDays, asOfDate]. */
export function rowsWithinDays(rows, asOfDate, windowDays) {
  return rows.filter((r) => {
    const d = daysBetween(asOfDate, r.date);
    return d >= 0 && d <= windowDays;
  });
}

/** Occurrences of `item.test` across rowsInWindow (failures + flaky), with
 *  same-signature detection. rowsInWindow must already include the latest run. */
export function computeRecurrence(item, rowsInWindow) {
  const target = normalizeSignature(item.error_signature);
  const dates = [];
  let sameSig = 0;
  for (const row of rowsInWindow) {
    const entries = [...(row.failures || []), ...(row.flaky || [])];
    const hit = entries.find((e) => e.test === item.test);
    if (!hit) continue;
    dates.push(row.date);
    if (normalizeSignature(hit.error_signature) === target) sameSig++;
  }
  dates.sort();
  return { count: dates.length, dates, same_signature: sameSig >= 2 };
}

/** True when the run had more hard failures than the auto-remove guard allows. */
export function detectGuard(row, maxAutoRemove = 5) {
  return (row.totals?.failed || 0) > maxAutoRemove;
}

/** Find the umbrella [Daily Failure] issue for a run id (matched in the body). */
export function matchUmbrella(issues, runId) {
  const hit = (issues || []).find(
    (i) => i.title?.startsWith('[Daily Failure]') && String(i.body || '').includes(runId),
  );
  return hit ? hit.number : null;
}

/** Assemble the normalized triage dataset from the latest red run. */
export function buildDataset(rows, issues, opts = {}) {
  const { windowDays = 30, maxAutoRemove = 5 } = opts;
  const run = findLatestRedRun(rows);
  if (!run) return null;
  const window = rowsWithinDays(rows, run.date, windowDays);

  const withRecurrence = (e) => ({
    test: e.test,
    file: e.file,
    line: e.line,
    tags: e.tags,
    error_signature: stripAnsi(e.error_signature),
    recurrence: computeRecurrence(e, window),
  });

  const hard_failures = (run.failures || []).map(withRecurrence);
  const flakes = (run.flaky || []).map(withRecurrence).map((f) => ({
    ...f,
    actionable: f.recurrence.same_signature,
  }));

  return {
    run: {
      run_id: run.run_id,
      run_url: run.run_url,
      date: run.date,
      langflow_image: run.langflow_image,
      duration_ms: run.duration_ms,
    },
    umbrella_issue: matchUmbrella(issues, run.run_id),
    guard_tripped: detectGuard(run, maxAutoRemove),
    totals: run.totals,
    hard_failures,
    flakes,
    skips: [],
  };
}
