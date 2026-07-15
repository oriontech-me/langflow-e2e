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
