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
