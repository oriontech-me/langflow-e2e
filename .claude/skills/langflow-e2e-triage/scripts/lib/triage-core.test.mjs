import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  parseHistory,
  findLatestRedRun,
  stripAnsi,
  normalizeSignature,
  computeRecurrence,
  rowsWithinDays,
  detectGuard,
  matchUmbrella,
  buildDataset,
  dedupeEntries,
  findNewestUmbrella,
  parseProviderModel,
  computeProviderClusters,
  renderDedicatedIssueTitle,
  renderDedicatedIssueBody,
  assertDedicatedIssueBody,
  DEDICATED_ISSUE_SECTIONS,
} from './triage-core.mjs';

const fixture = (name) =>
  readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), 'utf8');

test('parseHistory ignores blank lines and returns all rows', () => {
  const rows = parseHistory(fixture('history-sample.jsonl') + '\n\n');
  assert.equal(rows.length, 3);
  assert.equal(rows[0].run_id, '111');
});

test('parseHistory throws on a malformed non-blank line', () => {
  assert.throws(() => parseHistory('{not json}'));
});

test('findLatestRedRun returns the last row with failures or flakes', () => {
  const rows = parseHistory(fixture('history-sample.jsonl'));
  assert.equal(findLatestRedRun(rows).run_id, '333');
});

test('findLatestRedRun returns null when every run is green', () => {
  const green = [{ totals: { failed: 0, flaky: 0 } }];
  assert.equal(findLatestRedRun(green), null);
});

// Real signatures in reports/daily-history.jsonl carry the ESC byte (stored as
// an escape by the appender). Building it here rather than pasting a literal
// control character keeps the source clean — and an earlier version of these
// tests used ESC-less input, which is what let a broken ANSI_RE go unnoticed.
const ESC = String.fromCharCode(27);

test('stripAnsi removes escape codes', () => {
  assert.equal(stripAnsi(`${ESC}[2mError: x${ESC}[22m`), 'Error: x');
});

test('stripAnsi leaves no orphan ESC byte behind', () => {
  // Guards the drift where the pattern matched `[2m` without the ESC: the codes
  // vanished but the control bytes stayed, so two recordings of one cause
  // stopped comparing equal.
  const out = stripAnsi(`Error: ${ESC}[2mexpect(${ESC}[22mlocator).toBeVisible failed`);
  assert.ok(!out.includes(ESC));
  assert.equal(out, 'Error: expect(locator).toBeVisible failed');
});

test('stripAnsi does not eat bracketed text that is not an escape sequence', () => {
  assert.equal(stripAnsi('Error: index [2m] out of range'), 'Error: index [2m] out of range');
});

test('normalizeSignature makes ANSI and plain signatures compare equal', () => {
  assert.equal(
    normalizeSignature(`${ESC}[2mError: toBe equality${ESC}[22m`),
    normalizeSignature('Error:   toBe equality'),
  );
});

test('rowsWithinDays keeps only rows inside the window', () => {
  const rows = parseHistory(fixture('history-sample.jsonl'));
  const kept = rowsWithinDays(rows, '2026-07-14', 30);
  assert.deepEqual(kept.map((r) => r.run_id), ['222', '333']); // 06-13 is >30d out (outside 30-day window)
});

test('computeRecurrence flags a same-signature recurring flake', () => {
  const rows = rowsWithinDays(parseHistory(fixture('history-sample.jsonl')), '2026-07-14', 30);
  const r = computeRecurrence({ test: 'widget B toggles', error_signature: 'Error: toBe equality' }, rows);
  assert.equal(r.count, 2);
  assert.deepEqual(r.dates, ['2026-07-10', '2026-07-14']);
  assert.equal(r.same_signature, true);
});

test('computeRecurrence returns count 1 for a first-seen failure', () => {
  const rows = rowsWithinDays(parseHistory(fixture('history-sample.jsonl')), '2026-07-14', 30);
  const r = computeRecurrence({ test: 'flow C builds', error_signature: 'Error: 500 internal' }, rows);
  assert.equal(r.count, 1);
  assert.equal(r.same_signature, false);
});

test('computeRecurrence count/dates cover only same-signature occurrences (mixed signatures)', () => {
  // Same test title recurs 4x, but the first two flaked with an empty (different)
  // signature and only the last two share today's signature. count/dates must
  // report same-cause recurrence (2x), not the all-signature tally — that raw
  // tally lives in total_count/total_dates for context. (Models the
  // global-variables 4x->2x case from run #802 / issue #803.)
  const rows = [
    { date: '2026-07-02', flaky: [{ test: 'cred hidden', error_signature: '' }] },
    { date: '2026-07-09', flaky: [{ test: 'cred hidden', error_signature: '' }] },
    { date: '2026-07-15', failures: [{ test: 'cred hidden', error_signature: 'Error: toBe' }] },
    { date: '2026-07-17', failures: [{ test: 'cred hidden', error_signature: 'Error: toBe' }] },
  ];
  const r = computeRecurrence({ test: 'cred hidden', error_signature: 'Error: toBe' }, rows);
  assert.equal(r.count, 2);
  assert.deepEqual(r.dates, ['2026-07-15', '2026-07-17']);
  assert.equal(r.same_signature, true);
  assert.equal(r.total_count, 4);
  assert.deepEqual(r.total_dates, ['2026-07-02', '2026-07-09', '2026-07-15', '2026-07-17']);
});

test('detectGuard trips above the threshold', () => {
  assert.equal(detectGuard({ totals: { failed: 6 } }, 5), true);
  assert.equal(detectGuard({ totals: { failed: 5 } }, 5), false);
});

test('matchUmbrella finds the daily-failure issue by run id in the body', () => {
  const issues = JSON.parse(fixture('issues-sample.json'));
  assert.equal(matchUmbrella(issues, '333'), 900);
  assert.equal(matchUmbrella(issues, '777'), null);
});

test('buildDataset assembles run, flags actionable flake, marks umbrella', () => {
  const rows = parseHistory(fixture('history-sample.jsonl'));
  const issues = JSON.parse(fixture('issues-sample.json'));
  const ds = buildDataset(rows, issues);
  assert.equal(ds.run.run_id, '333');
  assert.equal(ds.umbrella_issue, 900);
  assert.equal(ds.guard_tripped, false);
  assert.equal(ds.hard_failures.length, 2);
  assert.equal(ds.flakes.length, 1);
  assert.equal(ds.flakes[0].actionable, true); // widget B recurs same-sig on 07-10 + 07-14
  const flowA = ds.hard_failures.find((f) => f.test === 'flow A executes');
  assert.equal(flowA.recurrence.count, 1);
  assert.equal(flowA.recurrence.same_signature, false);
});

test('dedupeEntries removes same test+line, keeps first occurrence', () => {
  const input = [
    { test: 'a', line: 1, tag: 'first' },
    { test: 'a', line: 1, tag: 'dup' },
    { test: 'a', line: 2, tag: 'diff-line' },
    { test: 'b', line: 1, tag: 'other' },
  ];
  const out = dedupeEntries(input);
  assert.equal(out.length, 3);
  assert.equal(out[0].tag, 'first'); // kept the first, dropped 'dup'
  assert.deepEqual(out.map((e) => `${e.test}:${e.line}`), ['a:1', 'a:2', 'b:1']);
});

test('dedupeEntries handles null/empty input', () => {
  assert.deepEqual(dedupeEntries(null), []);
  assert.deepEqual(dedupeEntries([]), []);
});

test('findNewestUmbrella picks the max date and ignores non-umbrella titles', () => {
  const issues = JSON.parse(fixture('issues-sample.json'));
  const newest = findNewestUmbrella(issues);
  assert.equal(newest.date, '2026-07-20');
  assert.equal(newest.number, 901);
});

test('findNewestUmbrella returns null when no umbrella titles present', () => {
  assert.equal(findNewestUmbrella([{ number: 1, title: '[Daily #744] some dedicated issue' }]), null);
});

test('buildDataset flags stale_history when a newer umbrella exists', () => {
  const rows = parseHistory(fixture('history-sample.jsonl'));
  const issues = JSON.parse(fixture('issues-sample.json'));
  const ds = buildDataset(rows, issues);
  // latest run 333 is 2026-07-14; umbrella 901 is 2026-07-20 → stale
  assert.equal(ds.stale_history.newest_umbrella, 901);
  assert.equal(ds.stale_history.newest_umbrella_date, '2026-07-20');
  assert.equal(ds.stale_history.history_latest_date, '2026-07-14');
});

test('buildDataset de-duplicates flakes by test+line', () => {
  // Synthetic single-run history with a duplicated flaky entry.
  const dupRow = {
    date: '2026-07-14', run_id: '500', run_url: 'x', langflow_image: 'i', duration_ms: 1,
    totals: { passed: 1, failed: 0, flaky: 2, skipped: 0 },
    failures: [],
    flaky: [
      { test: 'dup test', file: 'd.spec.ts', line: 9, tags: ['stable'], attempts: 2, error_signature: 'Error: x' },
      { test: 'dup test', file: 'd.spec.ts', line: 9, tags: ['stable'], attempts: 2, error_signature: 'Error: x' },
    ],
  };
  const ds = buildDataset([dupRow], []);
  assert.equal(ds.flakes.length, 1);
});

test('buildDataset de-duplicates hard failures by test+line', () => {
  const dupRow = {
    date: '2026-07-14', run_id: '501', run_url: 'x', langflow_image: 'i', duration_ms: 1,
    totals: { passed: 1, failed: 2, flaky: 0, skipped: 0 },
    failures: [
      { test: 'dup fail', file: 'e.spec.ts', line: 7, tags: ['stable'], attempts: 3, error_signature: 'Error: y' },
      { test: 'dup fail', file: 'e.spec.ts', line: 7, tags: ['stable'], attempts: 3, error_signature: 'Error: y' },
    ],
    flaky: [],
  };
  const ds = buildDataset([dupRow], []);
  assert.equal(ds.hard_failures.length, 1);
});

test('parseProviderModel: parameterization label "<provider> / <model>"', () => {
  assert.deepEqual(parseProviderModel({ param: 'google / gemini-2.5-flash' }), {
    provider: 'google',
    model: 'gemini-2.5-flash',
  });
});

test('parseProviderModel: "model:<id>" infers provider from the model id', () => {
  assert.deepEqual(parseProviderModel({ param: 'model:gpt-4o-mini' }), {
    provider: 'openai',
    model: 'gpt-4o-mini',
  });
});

test('parseProviderModel: falls back to <provider>-provider.spec.ts filename', () => {
  const r = parseProviderModel({ file: 'tests/.../model-provider/google-provider.spec.ts' });
  assert.equal(r.provider, 'google');
  assert.equal(r.model, null);
});

test('parseProviderModel: falls back to a provider token in the test title', () => {
  const r = parseProviderModel({ test: 'language model must respond with Google provider' });
  assert.equal(r.provider, 'google');
});

test('parseProviderModel: returns nulls when nothing matches', () => {
  assert.deepEqual(parseProviderModel({ test: 'renders on canvas', file: 'x.spec.ts' }), {
    provider: null,
    model: null,
  });
});

test('computeProviderClusters flags provider_wide across ≥2 files', () => {
  const entries = [
    { test: 'a', file: 'agent-x.spec.ts', line: 1, param: 'google / gemini-2.5-flash' },
    { test: 'b', file: 'agent-y.spec.ts', line: 2, param: 'google / gemini-2.5-flash' },
    { test: 'c', file: 'google-provider.spec.ts', line: 3 },
    { test: 'd', file: 'agent-x.spec.ts', line: 4, param: 'anthropic / claude-sonnet-5' },
  ];
  const clusters = computeProviderClusters(entries);
  const google = clusters.find((c) => c.provider === 'google');
  assert.equal(google.count, 3);
  assert.equal(google.provider_wide, true);
  assert.equal(google.files.length, 3);
  // anthropic has a single failure → not a cluster
  assert.equal(clusters.find((c) => c.provider === 'anthropic'), undefined);
});

test('computeProviderClusters: single-file provider is not provider_wide', () => {
  const entries = [
    { test: 'a', file: 'groq-provider.spec.ts', line: 1 },
    { test: 'b', file: 'groq-provider.spec.ts', line: 2, param: 'groq / llama-3' },
  ];
  const [c] = computeProviderClusters(entries);
  assert.equal(c.provider, 'groq');
  assert.equal(c.count, 2);
  assert.equal(c.provider_wide, false);
});

test('buildDataset attaches provider/model and provider_wide_clusters', () => {
  const row = {
    date: '2026-07-14', run_id: '600', run_url: 'x', langflow_image: 'i', duration_ms: 1,
    totals: { passed: 1, failed: 2, flaky: 0, skipped: 0 },
    failures: [
      { test: 'agent a', file: 'agent-x.spec.ts', line: 1, tags: [], attempts: 3, error_signature: 'E', param: 'google / gemini-2.5-flash' },
      { test: 'cfg', file: 'google-provider.spec.ts', line: 2, tags: [], attempts: 3, error_signature: 'E' },
    ],
    flaky: [],
  };
  const ds = buildDataset([row], []);
  assert.equal(ds.hard_failures[0].provider, 'google');
  assert.equal(ds.hard_failures[0].model, 'gemini-2.5-flash');
  const gw = ds.provider_wide_clusters.find((c) => c.provider === 'google');
  assert.equal(gw.provider_wide, true);
  assert.equal(gw.count, 2);
});

// --- dedicated-issue rendering ---------------------------------------------

const CLUSTER = {
  umbrella: 744,
  run: { run_id: '30261409427', run_url: 'https://gh/runs/30261409427', date: '2026-07-27' },
  summary: 'Three @stable tests hard-failed with the same shape.',
  tests: [
    {
      file: 'core-functionality/llm-agents/agent-component-regression.spec.ts',
      line: 145,
      test: 'agent interaction suite',
      waits_for: "getByTestId('div-chat-message')",
      error_signature: 'Error: expect(locator).toBeVisible() failed',
    },
  ],
  whyOneCause: 'All three failed in the same 40s window on shard 3.',
  preliminaryRead: 'Mass-failure day (guard tripped); consistent with saturation, not concluded.',
  investigation: 'Product first: confirm on the current nightly whether these flows complete.',
};

test('renderDedicatedIssueTitle uses the umbrella number', () => {
  assert.equal(
    renderDedicatedIssueTitle({ umbrella: 744, symptom: 'agent execution never completes' }),
    '[Daily #744] agent execution never completes',
  );
});

test('renderDedicatedIssueTitle rejects a non-issue-number umbrella', () => {
  // Guards the run-id-for-umbrella swap the reference doc warns about.
  assert.throws(() => renderDedicatedIssueTitle({ umbrella: 'abc', symptom: 'x' }), /positive issue number/);
  assert.throws(() => renderDedicatedIssueTitle({ umbrella: 744, symptom: '  ' }), /symptom is required/);
});

test('renderDedicatedIssueBody emits every canonical section in order', () => {
  const body = renderDedicatedIssueBody(CLUSTER);
  let cursor = -1;
  for (const heading of DEDICATED_ISSUE_SECTIONS) {
    const at = body.indexOf(heading);
    assert.ok(at > cursor, `${heading} missing or out of order`);
    cursor = at;
  }
  assert.match(body, /^Spun out of daily-failure triage #744 \(run \[30261409427\]/);
});

test('renderDedicatedIssueBody keeps the signature verbatim', () => {
  const body = renderDedicatedIssueBody(CLUSTER);
  assert.ok(body.includes('`Error: expect(locator).toBeVisible() failed`'));
});

test('renderDedicatedIssueBody preserves the literal "unknown" signature', () => {
  // The run recorded no error message; substituting a description here would
  // make the next run's history unmatchable.
  const body = renderDedicatedIssueBody({
    ...CLUSTER,
    tests: [{ ...CLUSTER.tests[0], error_signature: 'unknown' }],
  });
  assert.ok(body.includes('| `unknown` |'));
});

test('renderDedicatedIssueBody escapes a pipe so the table survives', () => {
  const body = renderDedicatedIssueBody({
    ...CLUSTER,
    tests: [{ ...CLUSTER.tests[0], error_signature: 'Error: got a|b, want c' }],
  });
  const row = body.split('\n').find((l) => l.includes('agent-component-regression'));
  assert.equal(row.split(/(?<!\\)\|/).length - 1, 4); // 4 unescaped delimiters = 3 cells
  assert.ok(row.includes('a\\|b'));
});

test('renderDedicatedIssueBody strips ANSI from a raw history signature', () => {
  // daily-history.jsonl stores signatures with the SGR codes Playwright emits.
  const esc = String.fromCharCode(27);
  const raw = `Error: ${esc}[2mexpect(${esc}[22mlocator).toBeVisible failed`;
  const body = renderDedicatedIssueBody({
    ...CLUSTER,
    tests: [{ ...CLUSTER.tests[0], error_signature: raw }],
  });
  assert.ok(!body.includes(esc));
  assert.ok(body.includes('Error: expect(locator).toBeVisible failed'));
});

test('renderDedicatedIssueBody refuses a test with no signature', () => {
  assert.throws(
    () => renderDedicatedIssueBody({ ...CLUSTER, tests: [{ file: 'a.spec.ts', line: 1 }] }),
    /no error_signature/,
  );
});

test('renderDedicatedIssueBody requires at least one test and the narrative fields', () => {
  assert.throws(() => renderDedicatedIssueBody({ ...CLUSTER, tests: [] }), /at least one affected test/);
  assert.throws(() => renderDedicatedIssueBody({ ...CLUSTER, whyOneCause: '' }), /whyOneCause is required/);
  assert.throws(() => renderDedicatedIssueBody({ ...CLUSTER, run: {} }), /run\.run_id is required/);
});

test('renderDedicatedIssueBody always carries the canonical deliverables', () => {
  const body = renderDedicatedIssueBody({ ...CLUSTER, deliverables: ['Extra thing.'] });
  assert.ok(body.includes('- [ ] **Quarantine lifted**'));
  assert.ok(body.includes('- [ ] Extra thing.'));
});

test('renderDedicatedIssueBody adds the flake block only when asked', () => {
  assert.ok(!renderDedicatedIssueBody(CLUSTER).includes('## Flake signal'));
  const body = renderDedicatedIssueBody({
    ...CLUSTER,
    flakeSignal: {
      dates: ['2026-07-08', '2026-07-09'],
      quarantine_pr: 870,
      specs: [{ file: 'core-functionality/playground/prefill.spec.ts', line: 97 }],
    },
  });
  assert.ok(body.includes('## Flake signal'));
  assert.ok(body.includes('(dailies 2026-07-08, 2026-07-09)'));
  assert.ok(body.includes('in PR #870'));
  assert.ok(body.includes('(test at line 97)'));
});

test('assertDedicatedIssueBody accepts a rendered body', () => {
  assert.deepEqual(assertDedicatedIssueBody(renderDedicatedIssueBody(CLUSTER)), []);
});

test('assertDedicatedIssueBody reports a missing section', () => {
  const body = renderDedicatedIssueBody(CLUSTER).replace('## Why these failures are one cause', '## Notes');
  assert.deepEqual(assertDedicatedIssueBody(body), [
    'missing section: ## Why these failures are one cause',
  ]);
});

test('assertDedicatedIssueBody rejects a spec named in prose only', () => {
  // `agent-max-tokens` alone is unmatchable by the QA Platform.
  const body = renderDedicatedIssueBody(CLUSTER).replace(
    /`core-functionality\/llm-agents\/agent-component-regression\.spec\.ts:145`/,
    'agent-component-regression',
  );
  assert.ok(assertDedicatedIssueBody(body).some((p) => /backticked repo-relative spec path/.test(p)));
});

test('assertDedicatedIssueBody catches an unfilled placeholder', () => {
  const body = renderDedicatedIssueBody({ ...CLUSTER, whyOneCause: '<one sentence: why>' });
  assert.ok(assertDedicatedIssueBody(body).some((p) => /unfilled placeholder/.test(p)));
});

test('assertDedicatedIssueBody ignores angle brackets inside code spans', () => {
  // A signature legitimately containing markup must not read as scaffolding.
  const body = renderDedicatedIssueBody({
    ...CLUSTER,
    tests: [{ ...CLUSTER.tests[0], error_signature: 'Error: <symptom> element not found' }],
  });
  assert.deepEqual(assertDedicatedIssueBody(body), []);
});

test('assertDedicatedIssueBody throws when asked', () => {
  assert.throws(() => assertDedicatedIssueBody('nothing here', { throwOnError: true }), /is invalid/);
});

test('renderDedicatedIssueBody always carries the Upstream slot', () => {
  // The seam to the treatment layer (Jira). Unfilled at triage time is normal —
  // omitted is not, or the failure layer stops linking to the card layer.
  assert.ok(renderDedicatedIssueBody(CLUSTER).includes('**Upstream:** _not filed_'));
  assert.ok(
    renderDedicatedIssueBody({ ...CLUSTER, upstream: 'LE-1234' }).includes('**Upstream:** LE-1234'),
  );
});

test('assertDedicatedIssueBody reports a dropped Upstream line', () => {
  const body = renderDedicatedIssueBody(CLUSTER).replace(/^\*\*Upstream:\*\* .+$/m, '');
  assert.ok(assertDedicatedIssueBody(body).some((p) => /Upstream/.test(p)));
});

// --- review findings on PR #1034 -------------------------------------------

test('renderDedicatedIssueBody rejects a missing or malformed run.date', () => {
  // Used to render "(run 123, undefined)" and pass validation — the provenance
  // line joins the issue to its history row, so it shipped broken.
  assert.throws(
    () => renderDedicatedIssueBody({ ...CLUSTER, run: { run_id: '1', run_url: 'u' } }),
    /run\.date must be YYYY-MM-DD/,
  );
  assert.throws(
    () => renderDedicatedIssueBody({ ...CLUSTER, run: { run_id: '1', date: '27/07/2026' } }),
    /run\.date must be YYYY-MM-DD/,
  );
});

test('renderDedicatedIssueBody rejects a null umbrella naming the real cause', () => {
  // buildDataset returns umbrella_issue: null when no umbrella carries the run id.
  assert.throws(
    () => renderDedicatedIssueBody({ ...CLUSTER, umbrella: null }),
    /positive issue number.*matchUmbrella/s,
  );
});

test('assertDedicatedIssueBody rejects a provenance line with no date', () => {
  const body = renderDedicatedIssueBody(CLUSTER).replace(', 2026-07-27).', ', undefined).');
  assert.ok(assertDedicatedIssueBody(body).some((p) => /provenance line/.test(p)));
});

test('a spec title containing "todo" is not a placeholder', () => {
  // Case-insensitive \bTODO\b matched ordinary prose. The table quotes the title
  // rather than fencing it, so the code-span strip does not protect it — this
  // aborted issue creation for a real cluster in the unattended path.
  const body = renderDedicatedIssueBody({
    ...CLUSTER,
    tests: [{ ...CLUSTER.tests[0], test: 'todo list renders after reload' }],
  });
  assert.deepEqual(assertDedicatedIssueBody(body), []);
});

test('an uppercase TODO is still caught', () => {
  const body = renderDedicatedIssueBody({ ...CLUSTER, investigation: 'TODO: decide the path' });
  assert.ok(assertDedicatedIssueBody(body).some((p) => /unfilled placeholder/.test(p)));
});

test('assertDedicatedIssueBody reports sections that carry no content', () => {
  const body = renderDedicatedIssueBody(CLUSTER).replace(
    'All three failed in the same 40s window on shard 3.',
    '',
  );
  assert.ok(
    assertDedicatedIssueBody(body).includes('empty section: ## Why these failures are one cause'),
  );
});

test('assertDedicatedIssueBody reports an empty Signature cell', () => {
  // The format's whole point; a hand-written or enriched table could drop it.
  const body = renderDedicatedIssueBody(CLUSTER).replace(
    '| `Error: expect(locator).toBeVisible() failed` |',
    '|  |',
  );
  assert.ok(assertDedicatedIssueBody(body).some((p) => /empty Signature cell/.test(p)));
});

test('assertDedicatedIssueBody reports a Symptom table with no rows', () => {
  const body = renderDedicatedIssueBody(CLUSTER).split('\n')
    .filter((l) => !l.includes('agent-component-regression'))
    .join('\n');
  assert.ok(assertDedicatedIssueBody(body).some((p) => /no test rows/.test(p)));
});

test('a quote inside a test title cannot break out of the quoted cell', () => {
  const body = renderDedicatedIssueBody({
    ...CLUSTER,
    tests: [{ ...CLUSTER.tests[0], test: 'the "new" flow opens' }],
  });
  assert.ok(body.includes(`("the 'new' flow opens")`));
  assert.deepEqual(assertDedicatedIssueBody(body), []);
});

// ─────────────────────────────────────────────────────────────────────────────
// #1310 — the infra-signature exemption reaches flakes
//
// #1031 exempted wedge collateral from `@stable` auto-removal, but that path only
// ever sees HARD failures. A flake whose error is transport-level still satisfied
// "same signature twice in 30 days", so the protocol required a dedicated issue
// AND a quarantine PR — i.e. a spec quarantined because the backend stopped
// answering. Real instance: agent-context-id-isolation.spec.ts:512 on run
// 30997773754 (20s timeout on GET /api/v1/auto_login; its retry spent 108 of 119
// seconds inside measured backend downtime).
// ─────────────────────────────────────────────────────────────────────────────

const TRANSPORT_SIG = 'TimeoutError: apiRequestContext.get: Timeout 20000ms exceeded.';
const SPEC_SIG = 'TimeoutError: locator.click: Timeout 20000ms exceeded.';

/** Two dailies so every flake below meets the same-signature recurrence bar. */
const infraRows = (entry) => [
  {
    version: 1, date: '2026-07-29', run_id: 'r1', run_url: 'u', langflow_image: 'i',
    duration_ms: 1, totals: { passed: 1, failed: 0, flaky: 1, skipped: 0 },
    failures: [], flaky: [entry],
  },
  {
    version: 1, date: '2026-08-05', run_id: 'r2', run_url: 'u', langflow_image: 'i',
    duration_ms: 1, totals: { passed: 1, failed: 0, flaky: 1, skipped: 0 },
    failures: [], flaky: [entry],
  },
];
const onlyFlake = (rows, opts = {}) => buildDataset(rows, [], { runId: 'r2', ...opts }).flakes[0];

// The pattern list is the real one, reached the way build-triage-dataset.mjs
// reaches it — a hand-rolled stub here would prove nothing about production.
const { classifyInfraError } = await import('../../../../../scripts/lib/infra-signatures.mjs');

test('#1310 a recurrent flake carrying a recorded infra signature is NOT actionable', () => {
  const f = onlyFlake(
    infraRows({
      test: 't', file: 'a.spec.ts', line: 1, tags: ['@stable'], attempts: 3,
      error_signature: TRANSPORT_SIG, infra_signature: 'api-request-timeout',
    }),
  );
  assert.equal(f.recurrence.same_signature, true, 'it must still be recognised as recurrent');
  assert.equal(f.actionable, false, 'but not actionable — the failure is not the spec\'s own');
  assert.equal(f.infra_signature, 'api-request-timeout');
  assert.equal(f.infra_classified_from, 'run-record');
});

test('#1310 the exclusion is visible, not silent — the flake stays in the list with a reason', () => {
  const ds = buildDataset(
    infraRows({
      test: 't', file: 'a.spec.ts', line: 1, tags: ['@stable'], attempts: 3,
      error_signature: TRANSPORT_SIG, infra_signature: 'api-request-timeout',
    }),
    [], { runId: 'r2' },
  );
  assert.equal(ds.flakes.length, 1, 'a demoted flake must never be dropped from the dataset (#1012)');
  assert.equal(ds.flakes[0].infra_excluded.signature, 'api-request-timeout');
  assert.equal(ds.flakes[0].infra_excluded.classified_from, 'run-record');
  assert.match(ds.flakes[0].infra_excluded.why, /not attributable/);
});

test('#1310 a recurrent flake whose error IS the spec\'s own stays actionable', () => {
  const f = onlyFlake(
    infraRows({
      test: 't', file: 'a.spec.ts', line: 1, tags: ['@stable'], attempts: 3,
      error_signature: SPEC_SIG, infra_signature: null,
    }),
  );
  assert.equal(f.actionable, true);
  assert.equal(f.infra_signature, null);
  assert.equal(f.infra_classified_from, 'run-record');
  assert.equal(f.infra_excluded, undefined, 'no exclusion block when nothing was excluded');
});

test('#1310 a recorded null is respected — the weaker fallback must not second-guess it', () => {
  // The row says "classified at run time, from the full error: attributable".
  // Re-classifying its one-line signature could only produce a worse answer, so
  // presence of the field, not its truthiness, is what decides.
  const f = onlyFlake(
    infraRows({
      test: 't', file: 'a.spec.ts', line: 1, tags: ['@stable'], attempts: 3,
      error_signature: TRANSPORT_SIG, infra_signature: null,
    }),
    { classifyInfra: classifyInfraError },
  );
  assert.equal(f.infra_classified_from, 'run-record', 'must not fall back over a row that carries the field');
  assert.equal(f.infra_signature, null);
  assert.equal(f.actionable, true);
});

test('#1310 a row predating the field falls back to classifying the stored signature', () => {
  const f = onlyFlake(
    infraRows({ test: 't', file: 'a.spec.ts', line: 1, tags: ['@stable'], attempts: 3, error_signature: TRANSPORT_SIG }),
    { classifyInfra: classifyInfraError },
  );
  assert.equal(f.infra_classified_from, 'error-signature-fallback');
  assert.equal(f.infra_signature, 'api-request-timeout');
  assert.equal(f.actionable, false);
});

test('#1310 the fallback is weaker, and the guard-wrapped shape shows exactly how', () => {
  // The stored signature is line 1 only. On run 30997773754 the #751 credential
  // guard wrapped a transport error this way, and no triage-side fallback can
  // see past that line — which is why the classification is written at run time.
  const wrapped = 'Error: Agent credential never settled on the persisted flow (#751 guard, #1072).';
  const viaFallback = onlyFlake(
    infraRows({ test: 't', file: 'a.spec.ts', line: 1, tags: ['@stable'], attempts: 3, error_signature: wrapped }),
    { classifyInfra: classifyInfraError },
  );
  assert.equal(viaFallback.infra_signature, null, 'the fallback cannot reach a cause line it never received');
  assert.equal(viaFallback.actionable, true, 'so it is still proposed — the documented limitation');

  const viaRecord = onlyFlake(
    infraRows({
      test: 't', file: 'a.spec.ts', line: 1, tags: ['@stable'], attempts: 3,
      error_signature: wrapped, infra_signature: 'api-request-timeout',
    }),
    { classifyInfra: classifyInfraError },
  );
  assert.equal(viaRecord.actionable, false, 'the run-time record does reach it');
});

test('#1310 with no classifier, an old row is unclassified — not silently attributable', () => {
  const f = onlyFlake(
    infraRows({ test: 't', file: 'a.spec.ts', line: 1, tags: ['@stable'], attempts: 3, error_signature: TRANSPORT_SIG }),
  );
  assert.equal(f.infra_classified_from, 'unclassified', 'unknown must be labelled unknown (#1012)');
});

test('#1310 hard failures carry the classification too, without changing their handling', () => {
  const rows = [{
    version: 1, date: '2026-08-05', run_id: 'r2', run_url: 'u', langflow_image: 'i',
    duration_ms: 1, totals: { passed: 1, failed: 1, flaky: 0, skipped: 0 },
    failures: [{
      test: 't', file: 'a.spec.ts', line: 1, tags: ['@stable'], attempts: 3,
      error_signature: TRANSPORT_SIG, infra_signature: 'api-request-timeout',
    }],
    flaky: [],
  }];
  const hf = buildDataset(rows, [], { runId: 'r2' }).hard_failures[0];
  assert.equal(hf.infra_signature, 'api-request-timeout');
  assert.equal(hf.infra_classified_from, 'run-record');
  // Hard-failure handling is #1031's, unchanged here: no actionable flag is
  // invented for them and nothing is demoted.
  assert.equal(hf.actionable, undefined);
  assert.equal(hf.infra_excluded, undefined);
});

test('#1310 build-triage-dataset.mjs actually injects the classifier', () => {
  // Structural, and deliberately so: every behavioural test above can pass while
  // production omits `classifyInfra`, in which case every pre-#1310 row comes
  // back `unclassified` and a wedge-collateral flake is proposed for quarantine
  // again — the exact regression this issue exists to close.
  const src = readFileSync(fileURLToPath(new URL('../build-triage-dataset.mjs', import.meta.url)), 'utf8');
  assert.match(src, /import\s*\{\s*classifyInfraError\s*\}\s*from\s*['"][^'"]*infra-signatures\.mjs['"]/,
    'the builder must import the real classifier, not re-implement one');
  // Bounded by the statement, not by `)`: the real call passes `fetchIssues()`
  // as an argument, so a `[^)]*` window closes before reaching the options object.
  assert.match(src, /buildDataset\([^;]*classifyInfra:\s*classifyInfraError/,
    'the builder must pass classifyInfra into buildDataset');
});
