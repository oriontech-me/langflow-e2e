import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseArgs, sanitizeEvidence, releaseCycleOf, allowedBranchFiles } from './cli.ts'

test('parseArgs extracts command, issue, and flags', () => {
  const a = parseArgs(['next', '493', '--spec', 'tests/x.spec.ts', '--evidence-json', '{"a":1}'])
  assert.equal(a.command, 'next')
  assert.equal(a.issue, 493)
  assert.equal(a.flags.spec, 'tests/x.spec.ts')
  assert.deepEqual(a.evidence, { a: 1 })
})

test('parseArgs takes step as third positional for complete', () => {
  const a = parseArgs(['complete', '493', 'SPECIFY', '--evidence-json', '{}'])
  assert.equal(a.step, 'SPECIFY')
})

test('sanitizeEvidence strips reserved runner-written keys', () => {
  const out = sanitizeEvidence({ runs: [{ fake: true }], typecheck: 0, specDoc: 'docs/x.md' })
  assert.deepEqual(out, { specDoc: 'docs/x.md' })
})

test('releaseCycleOf extracts major.minor', () => {
  assert.equal(releaseCycleOf('1.11.2.dev3'), '1.11')
  assert.equal(releaseCycleOf('1.5.1'), '1.5')
})

test('sanitizeEvidence also strips the new runner-written keys', () => {
  const out = sanitizeEvidence({
    reproRate: { runs: 99 }, artifactRuns: ['1'], verdict: 'test-defect',
  })
  assert.deepEqual(out, { verdict: 'test-defect' })
})

test('allowedBranchFiles unions what SPECIFY and IMPLEMENT recorded', () => {
  const state = {
    steps: {
      SPECIFY: { evidence: { specDoc: 'docs/a.md', existingSpec: 'tests/a.spec.ts' } },
      IMPLEMENT: { evidence: { files: ['tests/a.spec.ts', 'tests/helpers/h.ts'] } },
    },
  } as never
  assert.deepEqual(allowedBranchFiles(state), [
    'docs/a.md', 'tests/a.spec.ts', 'tests/helpers/h.ts', 'QA-CHECKLIST.md',
  ])
})

test('allowedBranchFiles still allows the checklist bullet on a bare state', () => {
  assert.deepEqual(allowedBranchFiles({ steps: {} } as never), ['QA-CHECKLIST.md'])
})
