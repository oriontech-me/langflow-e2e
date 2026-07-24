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

/** Occurrences of `item.test` across rowsInWindow (failures + flaky).
 *  rowsInWindow must already include the latest run.
 *
 *  Recurrence is about the *same cause*, so `count`/`dates` report only the
 *  occurrences whose normalized error signature matches the item's — this is
 *  what the proposal should cite. A test can recur under the same title for
 *  different causes (different signatures); those inflate a raw title tally
 *  without being same-cause recurrence, so they are excluded from count/dates
 *  and surfaced separately as `total_count`/`total_dates` for context only.
 *  `same_signature` (>= 2 same-signature hits) is unchanged and still drives
 *  the actionable decision. */
export function computeRecurrence(item, rowsInWindow) {
  const target = normalizeSignature(item.error_signature);
  const allDates = [];
  const sameDates = [];
  for (const row of rowsInWindow) {
    const entries = [...(row.failures || []), ...(row.flaky || [])];
    const hit = entries.find((e) => e.test === item.test);
    if (!hit) continue;
    allDates.push(row.date);
    if (normalizeSignature(hit.error_signature) === target) sameDates.push(row.date);
  }
  allDates.sort();
  sameDates.sort();
  return {
    count: sameDates.length,
    dates: sameDates,
    same_signature: sameDates.length >= 2,
    total_count: allDates.length,
    total_dates: allDates,
  };
}

/** True when the run had more hard failures than the auto-remove guard allows. */
export function detectGuard(row, maxAutoRemove = 5) {
  return (row.totals?.failed || 0) > maxAutoRemove;
}

/** Provider tokens we recognise in labels, filenames, and titles. */
const KNOWN_PROVIDERS = ['openai', 'anthropic', 'google', 'groq', 'mistral', 'ollama'];

/** Best-effort provider from a bare model id (last-resort when only a model is known). */
function providerFromModel(model) {
  const m = String(model || '').toLowerCase();
  if (/^(gpt|o1|o3|o4|text-|davinci|chatgpt)/.test(m)) return 'openai';
  if (/^claude/.test(m)) return 'anthropic';
  if (/^gemini/.test(m)) return 'google';
  if (/^(mistral|mixtral|magistral|ministral|codestral|pixtral)/.test(m)) return 'mistral';
  if (/(llama|qwen|phi|gemma|deepseek)/.test(m)) return 'ollama';
  return null;
}

/**
 * Derive `{ provider, model }` for a failure/flake entry. Model-parameterized
 * specs run one `describe` per provider whose title carries the label
 * (`[<provider> / <model>]` or `[model:<id>]`) — the appender records that bracket
 * content as `entry.param`. When `param` is absent (older history, or a
 * non-parameterized spec) fall back to two cheap, descriptive signals: a
 * `<provider>-provider.spec.ts` filename, then a known provider token in the test
 * title (e.g. "... with Google provider"). Returns nulls when nothing matches —
 * this is a descriptive hint for grouping, never a verdict.
 */
export function parseProviderModel(entry) {
  const param = String(entry?.param || '').trim();
  // 1. Parameterization label: "<provider> / <model>"
  let m = /^([a-z0-9.\-_]+)\s*\/\s*(.+)$/i.exec(param);
  if (m) {
    const provider = m[1].toLowerCase();
    return { provider, model: m[2].trim() };
  }
  // 1b. "model:<id>" form (provider implicit → infer from the model id)
  m = /^model:\s*(.+)$/i.exec(param);
  if (m) {
    const model = m[1].trim();
    return { provider: providerFromModel(model), model };
  }
  // 2. Filename: "<provider>-provider.spec.ts"
  m = /([a-z0-9]+)-provider\.spec\.ts$/i.exec(String(entry?.file || ''));
  if (m && KNOWN_PROVIDERS.includes(m[1].toLowerCase())) {
    return { provider: m[1].toLowerCase(), model: null };
  }
  // 3. Provider token in the test title
  const title = String(entry?.test || '').toLowerCase();
  const hit = KNOWN_PROVIDERS.find((p) => new RegExp(`\\b${p}\\b`).test(title));
  return { provider: hit || null, model: null };
}

/**
 * Group failures/flakes by provider variant and flag **provider-wide** clusters:
 * the same provider failing across **≥2 distinct spec files** on one run. That is
 * a descriptive signal that the cause is likely environment/package (e.g. a
 * missing `langchain-<provider>` in the nightly, #898) rather than per-test rot or
 * parallel-load flakiness — it does NOT root-cause, it only makes the shared
 * provider dimension (already implicit in the labels) visible to grouping.
 * Entries with no derivable provider are ignored.
 */
export function computeProviderClusters(entries) {
  const byProvider = new Map();
  for (const e of entries || []) {
    const provider = e.provider || parseProviderModel(e).provider;
    if (!provider) continue;
    if (!byProvider.has(provider)) byProvider.set(provider, []);
    byProvider.get(provider).push(e);
  }
  const clusters = [];
  for (const [provider, items] of byProvider) {
    if (items.length < 2) continue; // a single failure is not a cluster
    const files = [...new Set(items.map((i) => i.file))];
    clusters.push({
      provider,
      count: items.length,
      files,
      tests: items.map((i) => ({ test: i.test, file: i.file, line: i.line })),
      provider_wide: files.length >= 2,
    });
  }
  clusters.sort((a, b) => b.count - a.count);
  return clusters;
}

/** Find the umbrella [Daily Failure] issue for a run id (matched in the body). */
export function matchUmbrella(issues, runId) {
  const hit = (issues || []).find(
    (i) => i.title?.startsWith('[Daily Failure]') && String(i.body || '').includes(runId),
  );
  return hit ? hit.number : null;
}

/** De-duplicate history entries by test+line, keeping the first occurrence. */
export function dedupeEntries(entries) {
  const seen = new Set();
  const out = [];
  for (const e of entries || []) {
    const key = `${e.test}\0${e.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

/** Newest [Daily Failure] umbrella issue by the date in its title, or null. */
export function findNewestUmbrella(issues) {
  const re = /^\[Daily Failure\].*failed on (\d{4}-\d{2}-\d{2})/;
  let best = null;
  for (const i of issues || []) {
    const m = re.exec(i.title || '');
    if (!m) continue;
    if (!best || m[1] > best.date) best = { date: m[1], number: i.number };
  }
  return best;
}

/** Assemble the normalized triage dataset from the latest red run. */
export function buildDataset(rows, issues, opts = {}) {
  const { windowDays = 30, maxAutoRemove = 5, runId = null } = opts;
  // Target a specific run when asked (e.g. re-triaging a past artifact); default
  // to the latest red run.
  const run = runId ? rows.find((r) => r.run_id === runId) || null : findLatestRedRun(rows);
  if (!run) return null;
  const window = rowsWithinDays(rows, run.date, windowDays);

  const withRecurrence = (e) => {
    const { provider, model } = parseProviderModel(e);
    return {
      test: e.test,
      file: e.file,
      line: e.line,
      tags: e.tags,
      provider,
      model,
      error_signature: stripAnsi(e.error_signature),
      recurrence: computeRecurrence(e, window),
    };
  };

  const hard_failures = dedupeEntries(run.failures).map(withRecurrence);
  const flakes = dedupeEntries(run.flaky).map(withRecurrence).map((f) => ({
    ...f,
    actionable: f.recurrence.same_signature,
  }));

  // Descriptive provider-wide signal: same provider failing across ≥2 spec files.
  const provider_wide_clusters = computeProviderClusters([...hard_failures, ...flakes]);

  const newest = findNewestUmbrella(issues);
  const stale_history =
    newest && newest.date > run.date
      ? { newest_umbrella: newest.number, newest_umbrella_date: newest.date, history_latest_date: run.date }
      : null;

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
    stale_history,
    totals: run.totals,
    hard_failures,
    flakes,
    provider_wide_clusters,
    skips: [],
  };
}
