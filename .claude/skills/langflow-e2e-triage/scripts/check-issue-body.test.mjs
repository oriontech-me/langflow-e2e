import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, checkIssue, renderVerdictComment } from './check-issue-body.mjs';
import { renderDedicatedIssueBody, classifyIssueTitle } from './lib/triage-core.mjs';

const CLUSTER = {
  umbrella: 744,
  run: { run_id: '30261409427', run_url: 'https://gh/runs/30261409427', date: '2026-07-27' },
  summary: 'Two @stable tests hard-failed with the same shape.',
  tests: [
    {
      file: 'core-functionality/llm-agents/agent-component-regression.spec.ts',
      line: 145,
      test: 'agent interaction suite',
      waits_for: "getByTestId('div-chat-message')",
      error_signature: 'Error: expect(locator).toBeVisible() failed',
    },
  ],
  whyOneCause: 'Both failed in the same 40s window on shard 3.',
  preliminaryRead: 'Guard did not trip.',
  investigation: 'Product first: confirm on the current nightly.',
};

const GOOD_BODY = renderDedicatedIssueBody(CLUSTER);

test('classifyIssueTitle separates umbrella, dedicated and everything else', () => {
  // Both umbrella shapes daily-stable.yml actually emits.
  assert.equal(classifyIssueTitle('[Daily Failure] @stable tests failed on 2026-07-27 (img)'), 'umbrella');
  assert.equal(classifyIssueTitle('[Daily Failure] @stable run executed ZERO tests on 2026-07-27 (img)'), 'umbrella');
  assert.equal(classifyIssueTitle('[Daily #744] agent execution never completes'), 'dedicated');
  assert.equal(classifyIssueTitle('renameFlow residual flake'), 'other');
  assert.equal(classifyIssueTitle(''), 'other');
  assert.equal(classifyIssueTitle(null), 'other');
});

test('the umbrella is never validated against the dedicated contract', () => {
  // It carries the same daily-failure label but a different body; enforcing
  // here would fail every red day forever.
  const r = checkIssue({
    title: '[Daily Failure] @stable tests failed on 2026-07-27 (img)',
    body: '## Daily @stable E2E Failure\n\n- **Date:** 2026-07-27',
  });
  assert.equal(r.kind, 'umbrella');
  assert.equal(r.checked, false);
  assert.deepEqual(r.problems, []);
});

test('an unrelated title carrying the label is left alone', () => {
  const r = checkIssue({ title: 'renameFlow residual flake', body: 'anything' });
  assert.equal(r.checked, false);
  assert.match(r.reason, /not a dedicated per-cause issue/);
});

test('a compliant dedicated body passes', () => {
  const r = checkIssue({ title: '[Daily #744] agent execution never completes', body: GOOD_BODY });
  assert.equal(r.kind, 'dedicated');
  assert.equal(r.checked, true);
  assert.deepEqual(r.problems, []);
});

test('a hand-written dedicated body is caught', () => {
  const r = checkIssue({
    title: '[Daily #744] something broke',
    body: 'Three tests failed today, looks like the agent is down.',
  });
  assert.equal(r.checked, true);
  assert.ok(r.problems.length >= 5);
  assert.ok(r.problems.some((p) => /missing section/.test(p)));
  assert.ok(r.problems.some((p) => /provenance line/.test(p)));
});

test('a body that drops the spec path is caught even when it looks complete', () => {
  // The QA Platform matches on those paths; prose alone is invisible to it.
  const body = GOOD_BODY.replace(
    '`core-functionality/llm-agents/agent-component-regression.spec.ts:145`',
    'agent-component-regression',
  );
  const r = checkIssue({ title: '[Daily #744] x', body });
  assert.ok(r.problems.some((p) => /backticked repo-relative spec path/.test(p)));
});

test('renderVerdictComment is null when there is nothing to report', () => {
  assert.equal(renderVerdictComment(checkIssue({ title: '[Daily #744] x', body: GOOD_BODY })), null);
  assert.equal(renderVerdictComment(checkIssue({ title: '[Daily Failure] x', body: '' })), null);
});

test('renderVerdictComment lists the problems and does not threaten closure', () => {
  const c = renderVerdictComment(checkIssue({ title: '[Daily #744] x', body: 'nothing' }), {
    issueNumber: 99,
  });
  assert.match(c, /does not meet the dedicated-issue contract/);
  assert.match(c, /Nothing was closed or rejected/);
  assert.match(c, /dedicated-issue-contract-guard:99/);
  assert.match(c, /- missing section: ## Symptom/);
});

test('parseArgs reads the flags the workflow passes', () => {
  assert.deepEqual(parseArgs(['--title', 'T', '--body-file', 'b.md', '--json']), {
    title: 'T',
    bodyFile: 'b.md',
    json: true,
  });
  assert.throws(() => parseArgs(['--nope']), /unknown flag/);
});
