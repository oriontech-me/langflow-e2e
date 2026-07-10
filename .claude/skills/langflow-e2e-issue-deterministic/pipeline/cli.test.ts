import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseArgs, sanitizeEvidence, releaseCycleOf } from './cli.ts'

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
