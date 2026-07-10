import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  checkSpecDoc, checkQaDiff, checkForceFailCoverage,
  checkNoMutationMarkers, checkPrReadiness, BRANCH_RE,
} from './gates.ts'

const GOOD_DOC = `# agent-tools spec
## What this test validates
x
## Tags
@release @agents
## Validation criterion
concrete observable
## External dependencies
OpenAI key
Last validated: 1.11.x
`

test('checkSpecDoc passes a complete doc', () => {
  assert.deepEqual(checkSpecDoc(GOOD_DOC, '1.11'), [])
})

test('checkSpecDoc flags each missing mandatory section', () => {
  const problems = checkSpecDoc('# empty doc', '1.11')
  assert.equal(problems.length, 5)
})

test('checkSpecDoc flags stale Last validated', () => {
  const doc = GOOD_DOC.replace('1.11.x', '1.9.x')
  assert.match(checkSpecDoc(doc, '1.11').join(' '), /Last validated/)
})

test('checkSpecDoc does not let a prefix match hide a different minor version', () => {
  // '1.11.x'.startsWith('1.1') is true — a naive prefix check would miss this drift.
  const problems = checkSpecDoc(GOOD_DOC, '1.1')
  assert.match(problems.join(' '), /Last validated/)
})

test('checkQaDiff allows bullet edits and indented continuations', () => {
  const diff = [
    '--- a/QA-CHECKLIST.md', '+++ b/QA-CHECKLIST.md',
    '-- [ ] §2.3 — agent uses tools',
    '+- [x] §2.3 — agent uses tools',
    '+  `tests/tests-automations/regression/x.spec.ts`',
  ].join('\n')
  assert.deepEqual(checkQaDiff(diff), [])
})

test('checkQaDiff rejects generated table and Phase 0 edits', () => {
  const bad1 = '+| core | 10 | 50% |'
  const bad2 = '+### Phase 0 — Validated (12)'
  assert.ok(checkQaDiff(bad1).length > 0)
  assert.ok(checkQaDiff(bad2).length > 0)
})

test('checkQaDiff rejects top-level non-bullet prose changes', () => {
  assert.ok(checkQaDiff('+Some new paragraph').length > 0)
})

test('FF coverage requires one red entry per enumerated test', () => {
  const required = [{ file: 'a.spec.ts', titles: ['t1', 't2'] }]
  const ff = [{ file: 'a.spec.ts', test: 't1', mutation: 'inverted assert', unexpected: 1, at: 'x' }]
  const problems = checkForceFailCoverage(required, ff)
  assert.equal(problems.length, 1)
  assert.match(problems[0], /t2/)
})

test('FF entry with zero unexpected does not count', () => {
  const required = [{ file: 'a.spec.ts', titles: ['t1'] }]
  const ff = [{ file: 'a.spec.ts', test: 't1', mutation: 'no-op', unexpected: 0, at: 'x' }]
  assert.equal(checkForceFailCoverage(required, ff).length, 1)
})

test('mutation markers must be reverted', () => {
  const dirty = [{ file: 'a.spec.ts', diff: '+  expect(1).toBe(2) // FF-MUTATION' }]
  assert.ok(checkNoMutationMarkers(dirty).length > 0)
  assert.deepEqual(checkNoMutationMarkers([{ file: 'a.spec.ts', diff: '' }]), [])
})

test('branch regex accepts type/issue-NNN-desc only', () => {
  assert.ok(BRANCH_RE.test('test/issue-493-agent-tools'))
  assert.ok(BRANCH_RE.test('fix/issue-520-wiper-cleanup'))
  assert.ok(!BRANCH_RE.test('main'))
  assert.ok(!BRANCH_RE.test('feature/no-issue'))
})

test('PR readiness checks branch, Closes line, roadmap label for wave issues', () => {
  const ok = checkPrReadiness({
    branch: 'test/issue-493-agent-tools',
    prBody: 'Closes #493\n## Validation',
    issue: 493, isWave: true, labels: ['roadmap'],
  })
  assert.deepEqual(ok, [])
  const bad = checkPrReadiness({
    branch: 'main', prBody: 'no closes', issue: 493, isWave: true, labels: [],
  })
  assert.equal(bad.length, 3)
})
