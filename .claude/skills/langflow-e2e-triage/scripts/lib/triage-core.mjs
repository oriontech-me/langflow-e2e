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

// The ESC is required: without it the pattern strips the `[2m` and leaves the
// bare ESC byte behind, so a signature recorded with ANSI never compares equal to
// the same signature recorded without it — silently breaking the same-signature
// recurrence rule. `scripts/build-run-payload.mjs` already uses this form.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;]*m/g;

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

// ---------------------------------------------------------------------------
// Dedicated-issue rendering
//
// The canonical body format lives in ../../references/issue-templates.md, but a
// Markdown reference is only ever advice to whoever (or whatever) is composing
// the issue. Since Claude Code is the primary author of these issues — Phase 7
// runs `gh issue create`, which bypasses .github/ISSUE_TEMPLATE entirely — the
// structure has to be code to actually hold. These two functions are that:
// render from data, then assert before creating.
// ---------------------------------------------------------------------------

/** Section headings a dedicated issue must carry, in order. */
export const DEDICATED_ISSUE_SECTIONS = [
  '## Symptom',
  '## Why these failures are one cause',
  '## Preliminary read (descriptive — NOT a verdict)',
  '## Investigation directive',
  '## Deliverables (Done when)',
];

/** Canonical acceptance criteria. Callers may extend, but not drop, these. */
const DEFAULT_DELIVERABLES = [
  'Root cause confirmed per spec (product regression vs. test/wait-strategy vs. environment), with evidence on the current nightly.',
  'Each spec passes reliably (multiple clean `--retries=0` runs), fixing waits/flow as needed.',
  '**Quarantine lifted** in the fix PR — remove `test.fixme` **and** restore `@stable`, re-validated per `CONTRIBUTING.md`. *(Nothing to lift if nothing was quarantined.)*',
  'If the root cause is a **product (Langflow) regression**: recorded as such here, and this issue stays **open** until the upstream fix lands in `langflowai/langflow-nightly:latest` (or the `release-1.x.x` branch), is re-validated there, and `@stable` is restored — not on a test-side mute.',
];

/**
 * Make a value safe as a single Markdown table cell.
 *
 * Signatures are copied verbatim out of `reports/daily-history.jsonl` so that
 * recurrence stays matchable via `normalizeSignature()`. Two things still have
 * to be neutralised or the table silently breaks: a literal `|` ends the cell
 * early, and an embedded newline ends the row. Both are escaped rather than
 * stripped — `normalizeSignature()` collapses whitespace and the reader can
 * still see the original characters, so matching survives the escaping.
 */
function tableCell(value) {
  return stripAnsi(value).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>').trim();
}

/**
 * Title for a dedicated issue: `[Daily #<umbrella>] <symptom>`.
 *
 * The number is the **umbrella issue** number, never the run id — they are both
 * bare integers in the dataset and swapping them produces a plausible-looking
 * title that links nowhere, so it is enforced here instead of being a note in
 * the reference doc.
 */
export function renderDedicatedIssueTitle({ umbrella, symptom }) {
  const n = Number(umbrella);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`renderDedicatedIssueTitle: umbrella must be a positive issue number, got ${JSON.stringify(umbrella)}`);
  }
  const s = String(symptom || '').trim();
  if (!s) throw new Error('renderDedicatedIssueTitle: symptom is required');
  return `[Daily #${n}] ${s}`;
}

/**
 * Render the canonical dedicated-issue body from triage data.
 *
 * `tests[]` entries carry `error_signature` exactly as recorded in the history
 * row — including the literal string `"unknown"`, which is preserved rather
 * than replaced by a description. A paraphrased signature cannot be matched
 * against the next run's history, which is what would silently turn per-cause
 * issues back into one-issue-per-day.
 */
export function renderDedicatedIssueBody(input) {
  const {
    umbrella,
    run,
    provenanceNote = '',
    summary,
    tests,
    whyOneCause,
    preliminaryRead,
    investigation,
    deliverables = [],
    flakeSignal = null,
  } = input || {};

  if (!run?.run_id) throw new Error('renderDedicatedIssueBody: run.run_id is required');
  if (!Array.isArray(tests) || tests.length === 0) {
    throw new Error('renderDedicatedIssueBody: at least one affected test is required');
  }
  for (const [i, t] of tests.entries()) {
    if (!t?.file || !t?.line) throw new Error(`renderDedicatedIssueBody: tests[${i}] needs file and line`);
    if (!t?.error_signature) {
      throw new Error(`renderDedicatedIssueBody: tests[${i}] (${t.file}:${t.line}) has no error_signature — copy it verbatim from reports/daily-history.jsonl, or "unknown" if that is what the run recorded`);
    }
  }
  for (const [field, value] of [
    ['summary', summary],
    ['whyOneCause', whyOneCause],
    ['preliminaryRead', preliminaryRead],
    ['investigation', investigation],
  ]) {
    if (!String(value || '').trim()) throw new Error(`renderDedicatedIssueBody: ${field} is required`);
  }

  const runRef = run.run_url ? `[${run.run_id}](${run.run_url})` : `\`${run.run_id}\``;
  const provenance =
    `Spun out of daily-failure triage #${umbrella} (run ${runRef}, ${run.date}).` +
    (provenanceNote.trim() ? ` ${provenanceNote.trim()}` : '');

  const rows = tests.map((t) => {
    const spec = `\`${t.file}:${t.line}\`` + (t.test ? ` ("${tableCell(t.test)}")` : '');
    const waits = t.waits_for ? `\`${tableCell(t.waits_for)}\`` : '—';
    return `| ${spec} | ${waits} | \`${tableCell(t.error_signature)}\` |`;
  });

  const items = [...DEFAULT_DELIVERABLES, ...deliverables].map((d) => `- [ ] ${d}`);

  const out = [
    provenance,
    '',
    '## Symptom',
    '',
    String(summary).trim(),
    '',
    '| Spec (line) | Waits for | Signature |',
    '|---|---|---|',
    ...rows,
    '',
    '## Why these failures are one cause',
    '',
    String(whyOneCause).trim(),
    '',
    '## Preliminary read (descriptive — NOT a verdict)',
    '',
    String(preliminaryRead).trim(),
    '',
    '## Investigation directive',
    '',
    String(investigation).trim(),
    '',
    '## Deliverables (Done when)',
    '',
    ...items,
  ];

  if (flakeSignal) {
    const { dates = [], quarantine_pr = null, specs = [] } = flakeSignal;
    const when = dates.length ? ` (dailies ${dates.join(', ')})` : '';
    const pr = quarantine_pr ? ` in PR #${quarantine_pr}` : '';
    out.push(
      '',
      '## Flake signal',
      '',
      `This test is confirmed recurrent${when}. As prevention it was **quarantined** at triage${pr} — \`@stable\` removed **and** \`test.fixme\` added — so it stops running in **every** context (daily, PR impacted-specs gate, full suite) until this issue is worked:`,
      '',
      ...specs.map((s) => `- \`${s.file}\` (test at line ${s.line})`),
      '',
      'Lifting the quarantine after the fix (remove `test.fixme` + restore `@stable`) is a deliverable of this issue.',
    );
  }

  return out.join('\n') + '\n';
}

/**
 * Validate a dedicated-issue body before `gh issue create`.
 *
 * Covers hand-written and enriched bodies too, so it is deliberately broader
 * than the renderer's own input checks. Returns the list of problems; callers
 * that want it fatal pass `{ throwOnError: true }`.
 *
 * The backticked `path.spec.ts:line` check is not cosmetic: the QA Platform
 * parses those paths out of the body to decide whether a failure on a run page
 * is already tracked, and renders the `tracked · #NNN` chip from the match. A
 * spec named in prose alone is invisible to it.
 */
export function assertDedicatedIssueBody(body, opts = {}) {
  const { throwOnError = false } = opts;
  const text = String(body || '');
  const problems = [];

  for (const heading of DEDICATED_ISSUE_SECTIONS) {
    if (!text.includes(heading)) problems.push(`missing section: ${heading}`);
  }

  if (!/^Spun out of daily-failure triage #\d+ \(run .+\)/m.test(text)) {
    problems.push('missing or malformed provenance line (expected: "Spun out of daily-failure triage #N (run <id>, <date>).")');
  }

  if (!/`[^`\s]+\.spec\.ts:\d+`/.test(text)) {
    problems.push('no backticked repo-relative spec path with a line number — the QA Platform cannot match this issue to a failure');
  }

  if (!/- \[ \] /.test(text)) {
    problems.push('no checkbox deliverables — "Deliverables (Done when)" must be actionable');
  }

  // Unfilled template scaffolding. Matches the `<placeholder>` form used in the
  // reference doc and the issue form; real content rarely contains it, and when
  // it does (an HTML tag in a signature) the signature is inside backticks.
  const placeholder = /<(?:one sentence|symptom|umbrella|verbatim|placeholder|TODO)[^>]*>|\bTODO\b/i.exec(
    text.replace(/`[^`]*`/g, ''),
  );
  if (placeholder) problems.push(`unfilled placeholder left in the body: ${placeholder[0]}`);

  if (throwOnError && problems.length) {
    throw new Error(`Dedicated issue body is invalid:\n  - ${problems.join('\n  - ')}`);
  }
  return problems;
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
