import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { initState, saveState, loadState, statePath, ensureStep } from './state.ts'
import { makeTempDir } from '../../../../scripts/lib/tmp-dir.mjs'

beforeEach(() => {
  process.env.PIPELINE_STATE_DIR = makeTempDir('pipe-')
})

test('initState starts at INTAKE with version 1', () => {
  const s = initState(493, 'oriontech-me/langflow-e2e')
  assert.equal(s.phase, 'INTAKE')
  assert.equal(s.version, 1)
  assert.equal(s.issue, 493)
  assert.ok(s.startedAt)
})

test('save/load round-trips', () => {
  const s = initState(493, 'oriontech-me/langflow-e2e')
  saveState(s)
  const loaded = loadState(493)
  assert.deepEqual(loaded, s)
})

test('loadState returns null when missing', () => {
  assert.equal(loadState(999), null)
})

test('loadState rejects unknown version', () => {
  const s = initState(493, 'r')
  saveState(s)
  const p = statePath(493)
  fs.writeFileSync(p, JSON.stringify({ ...s, version: 99 }))
  assert.throws(() => loadState(493), /version/)
})

test('ensureStep creates once and increments nothing', () => {
  const s = initState(1, 'r')
  const rec = ensureStep(s, 'INTAKE')
  rec.attempts++
  assert.equal(ensureStep(s, 'INTAKE').attempts, 1)
})

import {
  spineFor, completeStep, escalateToDebug, setType, abortState, metricsOf,
} from './state.ts'

test('spine for new-spec is the full base spine', () => {
  assert.deepEqual(spineFor('new-spec'), [
    'INTAKE', 'CLASSIFY', 'SPECIFY', 'PLAN', 'IMPLEMENT', 'VALIDATE',
    'FORCE_FAIL', 'REPORT', 'AWAIT_PR_AUTH', 'PR', 'DONE',
  ])
})

test('fix spine inserts DEBUG before IMPLEMENT', () => {
  const spine = spineFor('fix')
  assert.equal(spine[spine.indexOf('IMPLEMENT') - 1], 'DEBUG')
})

test('triage spine ends at DISPATCHED', () => {
  assert.deepEqual(spineFor('daily-failure-triage'),
    ['INTAKE', 'CLASSIFY', 'DISPATCH', 'DISPATCHED'])
})

test('unknown type only knows INTAKE→CLASSIFY', () => {
  assert.deepEqual(spineFor(undefined), ['INTAKE', 'CLASSIFY'])
})

test('completeStep advances along the spine', () => {
  const s = initState(1, 'r')
  completeStep(s, 'INTAKE', { ack: true })
  assert.equal(s.phase, 'CLASSIFY')
  setType(s, 'new-spec', 'heuristic', 'label test-automation')
  completeStep(s, 'CLASSIFY', {})
  assert.equal(s.phase, 'SPECIFY')
})

test('advance starts the next phase clock immediately (metrics undercount fix)', () => {
  const s = initState(1, 'r')
  completeStep(s, 'INTAKE', { ack: true })
  // Back-to-back completes with NO intervening `next`: the CLASSIFY record
  // must already exist, with startedAt == INTAKE's completedAt — otherwise
  // per-phase ms read ~0 (benchmark rows 3 and 9).
  const rec = s.steps.CLASSIFY
  assert.ok(rec, 'CLASSIFY record created at INTAKE completion')
  assert.equal(rec!.startedAt, s.steps.INTAKE!.completedAt)
})

test('completeStep rejects wrong step, names expected', () => {
  const s = initState(1, 'r')
  assert.throws(() => completeStep(s, 'VALIDATE', {}), /expected "INTAKE"/)
})

test('DEBUG completion requires verdict; non-test-defect requires decision', () => {
  const s = initState(1, 'r')
  setType(s, 'fix', 'heuristic', 'x')
  s.phase = 'DEBUG'
  assert.throws(() => completeStep(s, 'DEBUG', {}), /verdict/)
  assert.throws(
    () => completeStep(s, 'DEBUG', { verdict: 'langflow-regression' }),
    /decision/)
  completeStep(s, 'DEBUG', { verdict: 'test-defect' })
  assert.equal(s.phase, 'IMPLEMENT')
})

test('escalate parks and resumes', () => {
  const s = initState(1, 'r')
  setType(s, 'new-spec', 'heuristic', 'x')
  s.phase = 'VALIDATE'
  escalateToDebug(s, 'previously-green spec failing')
  assert.equal(s.phase, 'DEBUG')
  assert.equal(s.parkedPhase, 'VALIDATE')
  completeStep(s, 'DEBUG', { verdict: 'test-defect' })
  assert.equal(s.phase, 'VALIDATE')
  assert.equal(s.parkedPhase, undefined)
})

test('terminal phase sets finishedAt', () => {
  const s = initState(1, 'r')
  setType(s, 'daily-failure-triage', 'heuristic', 'x')
  s.phase = 'DISPATCH'
  completeStep(s, 'DISPATCH', { createdIssues: ['#601'] })
  assert.equal(s.phase, 'DISPATCHED')
  assert.ok(s.finishedAt)
})

test('abortState is terminal with reason', () => {
  const s = initState(1, 'r')
  abortState(s, 'nightly broken')
  assert.equal(s.phase, 'ABORTED')
  assert.equal(s.abortReason, 'nightly broken')
  assert.ok(s.finishedAt)
})

test('abortState throws when the pipeline is already terminal (DONE)', () => {
  const s = initState(1, 'r')
  s.phase = 'DONE'
  s.finishedAt = '2020-01-01T00:00:00.000Z'
  assert.throws(() => abortState(s, 'too late'), /already DONE/)
  assert.equal(s.abortReason, undefined)
  assert.equal(s.finishedAt, '2020-01-01T00:00:00.000Z')
})

test('escalateToDebug on a re-entry after a completed DEBUG archives the old evidence', () => {
  const s = initState(1, 'r')
  setType(s, 'fix', 'heuristic', 'x')
  s.phase = 'VALIDATE'
  escalateToDebug(s, 'first look')
  completeStep(s, 'DEBUG', { verdict: 'test-defect' })
  assert.equal(s.phase, 'VALIDATE')
  const firstStartedAt = s.steps.DEBUG!.startedAt
  escalateToDebug(s, 'second look')
  const rec = s.steps.DEBUG!
  assert.equal(rec.completedAt, undefined)
  assert.ok(Array.isArray(rec.evidence.previousEpisodes))
  assert.equal((rec.evidence.previousEpisodes as unknown[]).length, 1)
  assert.ok(Date.parse(rec.startedAt) >= Date.parse(firstStartedAt))
  assert.equal(rec.evidence.reason, 'second look')
})

test('metricsOf reports per-step durations and attempts', () => {
  const s = initState(1, 'r')
  const rec = ensureStep(s, 'INTAKE')
  rec.attempts = 2
  rec.completedAt = new Date(Date.parse(rec.startedAt) + 5000).toISOString()
  const m = metricsOf(s)
  assert.equal(m.steps[0].phase, 'INTAKE')
  assert.equal(m.steps[0].ms, 5000)
  assert.equal(m.steps[0].attempts, 2)
})
