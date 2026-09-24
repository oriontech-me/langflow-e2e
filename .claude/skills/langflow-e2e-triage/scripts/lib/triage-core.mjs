// Pure, I/O-free triage helpers. Everything here is unit-tested with fixtures;
// all filesystem / gh access lives in build-triage-dataset.mjs.

// Imported, not injected like the infra classifier: this module is pure too, and
// it is the SAME comparison the appender's keys were derived for (#1626).
import { compareRecurrence } from '../../../../../scripts/lib/recurrence-key.mjs';

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

/**
 * How much of a failed attempt must sit inside measured backend downtime before
 * the run's own measurement outranks the recurrence criterion (#1763).
 *
 * WHY A FRACTION AND NOT A BOOLEAN. `report-backend-outages.mjs` already counts
 * failing attempts that TOUCH an outage window, and its own honesty note says
 * why that count cannot decide anything: on a shard measured 33-73 % down,
 * "the attempt touched a window" is close to a coin flip, and in this repo's
 * history `collateral_attempts > 0` on 11 of the 15 days that carry a `backend`
 * block. The fraction is a different instrument. The two instances #1763 was
 * raised on measured 82 % / 87 % (`agent-system-prompt.spec.ts:213`, 2026-09-08)
 * and 66 % (`locale-resilience.spec.ts:116`, 2026-09-10) of the attempt span
 * inside one contiguous window, while the case the issue names as one that must
 * NOT exempt anything — a 6-second blip inside a 130-second attempt — scores
 * 0.046.
 *
 * 0.5 sits well above that blip and well below every measured instance, and it
 * is deliberately a KNOB with the measurement printed beside it: an entry below
 * the threshold keeps `actionable: true` and still carries its `outage_overlap`,
 * so raising or lowering this never hides evidence, it only moves who decides.
 * Read a coverage figure against the shard's own `shard_down_pct`, which travels
 * on the block for exactly that reason.
 */
export const OUTAGE_COVERAGE_THRESHOLD = 0.5;

/**
 * Did the run MEASURE this entry into a backend outage hard enough to outrank
 * the recurrence criterion? Requires every failed attempt to clear the
 * threshold — one corroborated attempt beside one clean one is a test that
 * failed while the backend was answering, which is the spec's own failure.
 *
 * `unmeasured` and `clear` both return false, and a missing block returns false
 * too: a row written before #1763, or by a lane with no liveness recorder, has
 * no measurement, and absence of evidence never exempts anything (#1012).
 */
export function outageCorroborated(overlap, threshold = OUTAGE_COVERAGE_THRESHOLD) {
  if (!overlap || overlap.state !== 'overlapped') return false;
  if (!(Number(overlap.failed_attempts) > 0)) return false;
  return Number(overlap.min_coverage) >= threshold;
}

/** Occurrences of `item.test` across rowsInWindow (failures + flaky).
 *  rowsInWindow must already include the latest run.
 *
 *  Recurrence is about the *same cause*, so `count`/`dates` report only the
 *  occurrences whose recurrence key matches the item's — this is what the
 *  proposal should cite. A test can recur under the same title for different
 *  causes; those inflate a raw title tally without being same-cause recurrence,
 *  so they are excluded from count/dates and surfaced separately as
 *  `total_count`/`total_dates` for context only. `same_signature` (>= 2
 *  same-cause hits) still drives the actionable decision.
 *
 *  "Same cause" is `compareRecurrence()` (`scripts/lib/recurrence-key.mjs`,
 *  #1626), no longer equality of `error_signature`: that string named neither the
 *  element nor the call site, so one spec collided with itself, and it carried the
 *  model and counters a marker assertion interpolates, so one cause never matched
 *  itself. A date whose row predates the keys can only be compared on the
 *  failure's head — the collision that issue was raised about — so it is counted
 *  (a legacy row read as "no recurrence" would reset every window the day the
 *  keys shipped) and ALSO listed in `unverified_dates`, which the proposal must
 *  check against that run's call log before citing the figure. */
export function computeRecurrence(item, rowsInWindow) {
  const allDates = [];
  const unverifiedDates = [];
  const sameDates = [];
  // What the backend was doing on each of the earlier occurrences (#1763). The
  // `liveness-*` artifacts expire after 7 days and this window is 30, so the
  // history row is the only place a past occurrence's outage state survives —
  // without it a triage recomputing recurrence sees a clean `actionable: true`
  // and has no trace of a refutation someone already paid for by hand. Four
  // states, and `unrecorded` is the fourth: a row written before #1763, which is
  // not the same as a row that measured and found nothing.
  const outageByDate = {};
  for (const row of rowsInWindow) {
    const entries = [...(row.failures || []), ...(row.flaky || [])];
    // The item's own row answers with the item itself: a legacy row compared
    // with itself is only `unverified` on the head. Every other row may carry the
    // title more than once — a parameterized spec emits one entry per provider —
    // so taking the first one let a sibling answer for the item, both for the
    // verdict and for the outage state recorded below. Only the item's own
    // variant answers when the row has one; see `bestHit`.
    const titled = entries.filter((e) => e.test === item.test);
    if (!titled.length) continue;
    allDates.push(row.date);
    const { verdict, hit } = titled.includes(item)
      ? { verdict: 'match', hit: item }
      : bestHit(item, titled);
    if (verdict === 'unverified') unverifiedDates.push(row.date);
    if (verdict !== 'none') {
      sameDates.push(row.date);
      outageByDate[row.date] = hit.outage_overlap?.state || 'unrecorded';
    }
  }
  allDates.sort();
  sameDates.sort();
  unverifiedDates.sort();
  return {
    count: sameDates.length,
    dates: sameDates,
    same_signature: sameDates.length >= 2,
    total_count: allDates.length,
    total_dates: allDates,
    unverified_dates: unverifiedDates,
    outage_by_date: outageByDate,
  };
}

const VERDICT_RANK = { match: 2, unverified: 1, none: 0 };

/**
 * The entry of a row that answers for `item`, and its verdict.
 *
 * When the row carries the item's own variant (same `param`), only those entries
 * answer: another provider failing the same way is that provider's recurrence,
 * and letting it answer would also hand the item that variant's outage state.
 * Every same-title entry answers when none shares the param, and that is the
 * COMMON case, not an edge: `param` carries the model, and the daily rotates the
 * provider by weekday (#1185), so most earlier rows hold another variant or none.
 * There a sibling's same-cause failure counts — including its outage state —
 * because it is the only occurrence that row has; the title-only rule always did
 * this, and refusing it would make a rotated provider's cause unable to recur.
 */
function bestHit(item, candidates) {
  const sameParam = candidates.filter((e) => (e.param ?? null) === (item.param ?? null));
  const pool = sameParam.length ? sameParam : candidates;
  let best = { verdict: 'none', hit: pool[0] };
  for (const e of pool) {
    const v = compareRecurrence(item, e);
    if (VERDICT_RANK[v] > VERDICT_RANK[best.verdict]) best = { verdict: v, hit: e };
  }
  return best;
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

/**
 * De-duplicate history entries by test+line+param, keeping the first occurrence.
 *
 * `param` is in the key for the reason #1763's join key carries it (see
 * `scripts/lib/spec-param.mjs`): a model-parameterized spec emits one entry per
 * provider with the SAME title and the SAME line — the variant lives only in the
 * enclosing describe — so a 2-part key collapses them into one row and the
 * SURVIVOR's verdict answers for both. That is decided by describe declaration
 * order, and it is not hypothetical: 3 of the 55 committed history rows already
 * carry a colliding `(test, line)` pair in `flaky[]` (2026-07-13/15/22, all
 * agent specs), and the weekday provider rotation (#1185) is `continue-on-error`
 * with the multi-provider run as its documented fallback.
 *
 * It costs nothing on the common path — a spec with no `param` keys on the empty
 * string, so the pre-#1763 rows (whose `param` is absent on both sides) still
 * collapse exactly as before. What it buys is the two guarantees the exemptions
 * are written on: one variant's evidence never decides another's verdict, and a
 * variant that was NOT exempted is no longer dropped from the list in silence
 * (#1012) — the failure `outage_excluded` exists to make visible.
 */
export function dedupeEntries(entries) {
  const seen = new Set();
  const out = [];
  for (const e of entries || []) {
    const key = `${e.test}\0${e.line}\0${e.param ?? ''}`;
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

/**
 * Which contract an issue title is subject to.
 *
 * The gate must never validate the **umbrella** against the dedicated-issue
 * contract: `daily-stable.yml` opens it with the same `daily-failure` label but a
 * completely different body, so enforcing here would fail every red day forever.
 * The title is the discriminator the codebase already uses (`matchUmbrella`,
 * `findNewestUmbrella`).
 *
 * Returns `'umbrella'`, `'dedicated'`, or `'other'` — and only `'dedicated'` is
 * enforced. `'other'` is deliberately permissive: an issue carrying the label
 * without either title shape is somebody's manual note, not a contract breach.
 */
export function classifyIssueTitle(title) {
  const t = String(title || '').trim();
  if (/^\[Daily Failure\]/.test(t)) return 'umbrella';
  if (/^\[Daily #\d+\]/.test(t)) return 'dedicated';
  return 'other';
}

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
 * the dedup against open issues stays matchable via `normalizeSignature()`. Two things still have
 * to be neutralised or the table silently breaks: a literal `|` ends the cell
 * early, and an embedded newline ends the row. Both are escaped rather than
 * stripped — `normalizeSignature()` collapses whitespace and the reader can
 * still see the original characters, so matching survives the escaping.
 */
function tableCell(value) {
  return stripAnsi(value).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>').trim();
}

/** Table rows of the Symptom table: not the header, not the `|---|` separator. */
function symptomRows(text) {
  return text
    .split('\n')
    .filter((l) => /^\s*\|.*\|\s*$/.test(l))
    .filter((l) => !/^\s*\|[\s\-:|]+\|\s*$/.test(l))
    .filter((l) => !/\|\s*Signature\s*\|/.test(l));
}

/** Cells of a Markdown table row, splitting only on unescaped pipes. */
function rowCells(line) {
  return line
    .trim()
    .replace(/^\||\|$/g, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.trim());
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
    upstream = null,
    summary,
    tests,
    whyOneCause,
    preliminaryRead,
    investigation,
    deliverables = [],
    flakeSignal = null,
  } = input || {};

  // Guard the umbrella the same way renderDedicatedIssueTitle does. buildDataset
  // legitimately returns `umbrella_issue: null` when matchUmbrella() finds no
  // umbrella carrying this run id, and interpolating that produces "#null" — a
  // body the validator then rejects as a malformed provenance line, naming the
  // wrong cause in a job with nobody watching. Fail here, where the reason is known.
  if (!Number.isInteger(Number(umbrella)) || Number(umbrella) <= 0) {
    throw new Error(`renderDedicatedIssueBody: umbrella must be a positive issue number, got ${JSON.stringify(umbrella)} — matchUmbrella() returns null when no umbrella carries this run id`);
  }
  if (!run?.run_id) throw new Error('renderDedicatedIssueBody: run.run_id is required');
  // Without this the provenance line renders "(run 123, undefined)" and the
  // validator's `\(run .+\)` used to accept it — the line that joins the issue
  // back to its history row, shipped broken.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(run?.date || ''))) {
    throw new Error(`renderDedicatedIssueBody: run.date must be YYYY-MM-DD, got ${JSON.stringify(run?.date)}`);
  }
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

  // The seam to the treatment layer. This issue tracks the *failure*; what is
  // done about it is worked on the Jira board, so the key has to be a field the
  // body always carries — not a mention inside a deliverable checkbox, which
  // cannot be swept and disappears if nobody ticks it. Rendered unfilled at
  // triage time (the card rarely exists yet) precisely so the slot is visible
  // and someone fills it later.
  const upstreamLine = `**Upstream:** ${String(upstream || '').trim() || '_not filed_'}`;

  const rows = tests.map((t) => {
    // The title is quoted, not fenced, so a `"` inside it would close the quote early.
    const title = tableCell(t.test).replace(/"/g, "'");
    const spec = `\`${t.file}:${t.line}\`` + (t.test ? ` ("${title}")` : '');
    const waits = t.waits_for ? `\`${tableCell(t.waits_for)}\`` : '—';
    return `| ${spec} | ${waits} | \`${tableCell(t.error_signature)}\` |`;
  });

  const items = [...DEFAULT_DELIVERABLES, ...deliverables].map((d) => `- [ ] ${d}`);

  const out = [
    provenance,
    '',
    upstreamLine,
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

  // The date is matched explicitly: `\(run .+\)` accepted "(run 123, undefined)",
  // which shipped a provenance line that joins to nothing.
  if (!/^Spun out of daily-failure triage #\d+ \(run .+, \d{4}-\d{2}-\d{2}\)\./m.test(text)) {
    problems.push('missing or malformed provenance line (expected: "Spun out of daily-failure triage #N (run <id>, YYYY-MM-DD).")');
  }

  if (!/`[^`\s]+\.spec\.ts:\d+`/.test(text)) {
    problems.push('no backticked repo-relative spec path with a line number — the QA Platform cannot match this issue to a failure');
  }

  // Shape is not content. A body can carry every heading and say nothing under
  // them — which the renderer cannot produce, but a hand-written or enriched one
  // can, and those are exactly what this function exists to cover.
  const lines = text.split('\n');
  for (const heading of DEDICATED_ISSUE_SECTIONS) {
    const at = lines.findIndex((l) => l.trim() === heading);
    if (at < 0) continue; // already reported as missing above
    const body_ = [];
    for (let i = at + 1; i < lines.length && !/^##\s/.test(lines[i]); i++) body_.push(lines[i]);
    if (!body_.join('').trim()) problems.push(`empty section: ${heading}`);
  }

  // The whole point of the format: every affected test carries a signature.
  const rows = symptomRows(text);
  if (rows.length === 0) {
    problems.push('the Symptom table has no test rows');
  } else {
    const blank = rows.filter((r) => !rowCells(r).at(-1));
    if (blank.length) {
      problems.push(`${blank.length} Symptom row(s) with an empty Signature cell — copy it verbatim from reports/daily-history.jsonl, or "unknown" if that is what the run recorded`);
    }
  }

  if (!/^\*\*Upstream:\*\* .+/m.test(text)) {
    problems.push('missing the **Upstream:** line — the seam to the Jira/upstream card; render it as _not filed_ when no card exists yet, never omit it');
  }

  if (!/- \[ \] /.test(text)) {
    problems.push('no checkbox deliverables — "Deliverables (Done when)" must be actionable');
  }

  // Unfilled template scaffolding. Deliberately case-SENSITIVE: an earlier
  // case-insensitive `\bTODO\b` matched ordinary prose, and a test legitimately
  // titled "todo list renders" reaches this text outside backticks (the table
  // quotes the title, it does not fence it) — which aborted issue creation for a
  // real cluster in the unattended Phase 7 path.
  const placeholder = /<(?:one sentence|symptom|umbrella|verbatim|placeholder)[^>]*>|\bTODO\b/.exec(
    text.replace(/`[^`]*`/g, ''),
  );
  if (placeholder) problems.push(`unfilled placeholder left in the body: ${placeholder[0]}`);

  if (throwOnError && problems.length) {
    throw new Error(`Dedicated issue body is invalid:\n  - ${problems.join('\n  - ')}`);
  }
  return problems;
}

/** Assemble the normalized triage dataset from the latest red run. */
/**
 * Is this entry's failure the harness failing to reach the backend, rather than
 * the spec's own? Returns `{ id, from }`, where `from` records HOW it was decided
 * so the proposal can be honest about the strength of the answer (#1310):
 *
 *  - `run-record` — `infra_signature` was written into the history row at run
 *    time, classified from the FULL error text. Authoritative.
 *  - `error-signature-fallback` — the row predates the field, so the stored
 *    `error_signature` was classified instead. Strictly weaker: that is line 1
 *    only, so a transport error wrapped by an assertion is invisible to it (the
 *    `#751` credential guard being the usual wrapper).
 *  - `unclassified` — the row predates the field AND no classifier was injected,
 *    so no exemption could be computed at all.
 *
 * **`unclassified` does NOT protect the flake, and saying otherwise was the
 * defect Copilot caught on this PR.** The label records the gap; it does not
 * close it. `actionable` is `recurrent && !infra_signature`, and an unclassified
 * entry carries `infra_signature: null` — so a recurrent transport-level flake in
 * that state stays actionable and would be filed and quarantined exactly as
 * before #1310. There is no safe default available here: assuming collateral
 * would silently drop real flakes, and assuming attributable is the bug. So the
 * gap is made VISIBLE instead — `buildDataset` returns
 * `infra_classification_gap` naming how many entries are in this state, and the
 * production path is pinned by a structural test asserting
 * `build-triage-dataset.mjs` injects the classifier. Those two are what actually
 * prevent the regression; this label only names it.
 *
 * The recorded `null` is respected as an answer. Re-running the weaker fallback
 * over a row that was already classified at run time could only produce a worse
 * verdict, so absence of the field — not its falsiness — is what triggers it.
 */
function classifyEntryInfra(entry, classifyInfra) {
  if (Object.prototype.hasOwnProperty.call(entry, 'infra_signature')) {
    return { id: entry.infra_signature ?? null, from: 'run-record' };
  }
  if (typeof classifyInfra !== 'function') return { id: null, from: 'unclassified' };
  return {
    id: classifyInfra(entry.error_signature)?.id ?? null,
    from: 'error-signature-fallback',
  };
}

/**
 * @param opts.classifyInfra Optional `classifyInfraError` from
 *   `scripts/lib/infra-signatures.mjs`. Injected rather than imported so this
 *   module stays pure and I/O-free (the accessor reads its JSON at load).
 *   `build-triage-dataset.mjs` always passes it, pinned by a structural test.
 *   Omitting it does NOT fail safe: rows that predate `infra_signature` come back
 *   `unclassified`, which leaves a recurrent transport-level flake `actionable`
 *   just as before #1310. The returned `infra_classification_gap` is how that
 *   state announces itself — see `classifyEntryInfra`.
 */
export function buildDataset(rows, issues, opts = {}) {
  const { windowDays = 30, maxAutoRemove = 5, runId = null, classifyInfra = null } = opts;
  // Target a specific run when asked (e.g. re-triaging a past artifact); default
  // to the latest red run.
  const run = runId ? rows.find((r) => r.run_id === runId) || null : findLatestRedRun(rows);
  if (!run) return null;
  const window = rowsWithinDays(rows, run.date, windowDays);

  const withRecurrence = (e) => {
    const { provider, model } = parseProviderModel(e);
    const infra = classifyEntryInfra(e, classifyInfra);
    return {
      test: e.test,
      file: e.file,
      line: e.line,
      tags: e.tags,
      provider,
      model,
      error_signature: stripAnsi(e.error_signature),
      infra_signature: infra.id,
      infra_classified_from: infra.from,
      // Echoed on EVERY entry, exempting or not (#1763). The measurement is what
      // a human had to reconstruct by hand twice — downloading results.json,
      // four liveness artifacts and four container logs — and printing it only
      // where it happens to exempt would rebuild exactly that cost for the
      // entries below the threshold. Absent on a lane with no liveness recorder
      // and on rows written before #1763.
      ...(e.outage_overlap ? { outage_overlap: e.outage_overlap } : {}),
      recurrence: computeRecurrence(e, window),
    };
  };

  const hard_failures = dedupeEntries(run.failures).map(withRecurrence);

  // A flake is actionable when it recurs under the same cause (the recurrence
  // key, #1626) — AND when the failure is the spec's own. #1031 exempted wedge collateral from `@stable`
  // auto-removal, but that path only ever sees hard failures, so a flake whose
  // error is transport-level still satisfied the recurrence criterion and the
  // protocol then required a dedicated issue *and* a quarantine PR for it: a
  // spec quarantined because the backend stopped answering. Measured instance is
  // `agent-context-id-isolation.spec.ts:512` on run 30997773754 — a 20 s timeout
  // on `GET /api/v1/auto_login`, whose retry spent 108 of its 119 seconds inside
  // measured backend downtime (#1310).
  //
  // Demoted, never dropped: the flake stays in `flakes[]` carrying why it was
  // excluded, so the proposal can note it against the run's outage instead of
  // silently shortening the list (#1012).
  const flakes = dedupeEntries(run.flaky).map(withRecurrence).map((f) => {
    const recurrent = f.recurrence.same_signature;
    // The second exemption, and it reads a MEASUREMENT where the first reads a
    // STRING (#1763). `infra_signature` can only ever see a failure that reports
    // the transport; a spec that wraps its wait in an assertion reports the state
    // that never arrived, so a wedge-caused failure of it classifies `null` on
    // every attempt of every run and no pattern can be added to change that.
    // Adjudicated in this order on purpose: the signature is the stronger
    // evidence (an `ECONNREFUSED` is transport-level whatever the backend was
    // doing), so it keeps its own block and its own wording, and the overlap
    // answers only for the entries it could never reach.
    const outageExempt = !f.infra_signature && outageCorroborated(f.outage_overlap);
    return {
      ...f,
      actionable: recurrent && !f.infra_signature && !outageExempt,
      ...(recurrent && f.infra_signature
        ? {
            infra_excluded: {
              signature: f.infra_signature,
              classified_from: f.infra_classified_from,
              why: 'recurs under the same cause, but the error is transport-level — the harness could not reach the backend, so the failure is not attributable to this spec (#1031/#1310). Note it against the run backend outage; do not file or quarantine.',
            },
          }
        : {}),
      ...(recurrent && outageExempt
        ? {
            outage_excluded: {
              state: f.outage_overlap.state,
              min_coverage: f.outage_overlap.min_coverage,
              failed_attempts: f.outage_overlap.failed_attempts,
              threshold: OUTAGE_COVERAGE_THRESHOLD,
              ...(f.outage_overlap.shard !== undefined ? { shard: f.outage_overlap.shard } : {}),
              ...(f.outage_overlap.shard_down_pct !== undefined
                ? { shard_down_pct: f.outage_overlap.shard_down_pct }
                : {}),
              why: `recurs under the same cause, and the error is NOT transport-level — but the in-run liveness recorder measured every failed attempt of it at least ${Math.round(OUTAGE_COVERAGE_THRESHOLD * 100)}% inside a backend outage on its own shard, so the failure is not attributable to this spec (#1763). Note it against the run backend outage; do not file or quarantine. Read min_coverage against shard_down_pct before accepting it, and say so in the proposal — this is a measurement, not a signature.`,
            },
          }
        : {}),
    };
  });

  // Descriptive provider-wide signal: same provider failing across ≥2 spec files.
  const provider_wide_clusters = computeProviderClusters([...hard_failures, ...flakes]);

  // How many entries reached no infra verdict at all. Non-null presence IS the
  // signal (the same convention `run_errors` uses in the history schema): it
  // means the exemption could not be applied, so any recurrent transport-level
  // flake in this run is still sitting in `flakes[]` as actionable and a triage
  // reading this dataset must say so rather than present the list as filtered.
  // Reachable only by a caller that omits `classifyInfra` over pre-#1310 rows —
  // production cannot, which a structural test pins.
  const unclassified = [...hard_failures, ...flakes].filter(
    (e) => e.infra_classified_from === 'unclassified',
  );
  const infra_classification_gap = unclassified.length
    ? {
        entries: unclassified.length,
        why: 'no classifyInfra was injected and these rows predate the infra_signature field, so no wedge-collateral exemption could be computed — an unclassified entry is NOT a cleared one (#1012/#1310)',
      }
    : null;

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
    infra_classification_gap,
    totals: run.totals,
    hard_failures,
    flakes,
    provider_wide_clusters,
    skips: [],
  };
}
