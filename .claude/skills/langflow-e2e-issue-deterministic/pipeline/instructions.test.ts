import { test } from 'node:test'
import assert from 'node:assert/strict'
import { instructionFor } from './instructions.ts'
import { initState, setType } from './state.ts'

function stateAt(phase: string, type?: string) {
  const s = initState(493, 'oriontech-me/langflow-e2e')
  if (type) setType(s, type as never, 'heuristic', 'x')
  s.phase = phase as never
  s.issueData = {
    title: 'Create agent-tools.spec.ts', body: '**Done when**: merged',
    labels: ['roadmap'], milestone: 'Wave 1 — Agents & providers',
    state: 'OPEN', bodyFormat: 'A',
  }
  return s
}

test('SPECIFY instruction points to langflow-e2e skill and format-A criterion rule', () => {
  const text = instructionFor(stateAt('SPECIFY', 'new-spec'))
  assert.match(text, /langflow-e2e/)
  assert.match(text, /Validation criterion/)
  assert.match(text, /complete 493 SPECIFY/)
})

test('SPECIFY for validate-promote asks for locate + force-failability audit', () => {
  const text = instructionFor(stateAt('SPECIFY', 'validate-promote'))
  assert.match(text, /force-fail/i)
  assert.match(text, /existing spec/i)
})

test('DEBUG instruction points to systematic-debugging and verdict taxonomy', () => {
  const text = instructionFor(stateAt('DEBUG', 'fix'))
  assert.match(text, /systematic-debugging/)
  assert.match(text, /verdict/)
})

test('AWAIT_PR_AUTH instruction says report and WAIT', () => {
  const text = instructionFor(stateAt('AWAIT_PR_AUTH', 'new-spec'))
  assert.match(text, /WAIT/)
  assert.match(text, /authorize-pr/)
})

test('DISPATCH instruction covers fan-out per CONTRIBUTING', () => {
  const text = instructionFor(stateAt('DISPATCH', 'daily-failure-triage'))
  assert.match(text, /one dedicated issue per problem/i)
})

// `REGRESSIONS.md`'s own header names the pipeline REPORT phase as an owner of
// the mandatory row, and the phase instruction never mentioned the file — which
// is half of why #1777 reached a PR without one. The row belongs in the REPORT
// diff, not bolted on after the PR gate refuses.
test('REPORT names the ledger obligation under a product verdict, and only then', () => {
  const withVerdict = stateAt('REPORT', 'fix')
  withVerdict.steps.DEBUG = {
    startedAt: 'x', attempts: 1, evidence: { verdict: 'langflow-regression' },
  }
  const text = instructionFor(withVerdict)
  assert.match(text, /REGRESSIONS\.md/)
  assert.match(text, /Candidates/)
  assert.match(text, /regressions:summary/)

  // A test-defect owes no row, so the phase must not ask for one.
  const testDefect = stateAt('REPORT', 'fix')
  testDefect.steps.DEBUG = {
    startedAt: 'x', attempts: 1, evidence: { verdict: 'test-defect' },
  }
  assert.doesNotMatch(instructionFor(testDefect), /REGRESSIONS\.md/)
  // A type with no DEBUG phase at all reads the same way.
  assert.doesNotMatch(instructionFor(stateAt('REPORT', 'new-spec')), /REGRESSIONS\.md/)
})

test('DEBUG asks for the upstream ticket so the PR gate can verify the row', () => {
  const text = instructionFor(stateAt('DEBUG', 'fix'))
  assert.match(text, /upstreamTicket/)
  assert.match(text, /REGRESSIONS\.md/)
})
