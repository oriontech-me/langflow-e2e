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
