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

test('stripAnsi removes escape codes', () => {
  assert.equal(stripAnsi('[2mError: x[22m'), 'Error: x');
});

test('normalizeSignature makes ANSI and plain signatures compare equal', () => {
  assert.equal(
    normalizeSignature('[2mError: toBe equality[22m'),
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
