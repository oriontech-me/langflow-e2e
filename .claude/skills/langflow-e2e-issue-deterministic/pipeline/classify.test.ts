import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classify, detectBodyFormat } from './classify.ts'

const base = { title: '', labels: [] as string[], body: '' }

test('daily-failure + triage wording → triage', () => {
  const r = classify({ ...base, title: 'Daily stable failed — triage', labels: ['daily-failure'] })
  assert.equal(r.type, 'daily-failure-triage')
})

test('daily-failure without triage wording → dedicated fix', () => {
  const r = classify({ ...base, title: 'agent-steps flaky on daily', labels: ['daily-failure'], body: 'Fixes #520' })
  assert.equal(r.type, 'fix')
})

// The real dedicated body ALWAYS carries the word "triage" — it is the first
// line of the mandatory template — so the wording rule alone routed every
// dedicated issue to the triage spine. Regression for #1302.
const DEDICATED_BODY = 'Spun out of daily-failure triage #1296 (run [30997773754](...), 2026-08-05).\n\nThe day\'s triage verdict is that it was not environmental.'

test('dedicated "[Daily #N]" title → fix, even though the body says "triage"', () => {
  const r = classify({
    title: '[Daily #1296] ollama-provider — the flow produces no chat message within 180 s',
    labels: ['daily-failure', 'area:model-providers'],
    body: DEDICATED_BODY,
  })
  assert.equal(r.type, 'fix')
  assert.match(r.reason, /\[Daily #N\]/)
})

test('umbrella "[Daily Failure]" title → triage, even with no "triage" wording', () => {
  const r = classify({
    title: '[Daily Failure] @stable tests failed on 2026-08-05 (langflowai/langflow-nightly:latest)',
    labels: ['daily-failure', 'needs-triage'],
    body: '5 tests failed. See the run.',
  })
  assert.equal(r.type, 'daily-failure-triage')
  assert.match(r.reason, /umbrella/)
})

test('the dedicated title is a PREFIX match, so a mention of one is not one', () => {
  // Anchored on purpose. Unanchor it and this issue — which only REFERS to a
  // dedicated issue — is read as dedicated and routed to `fix`, when the
  // wording fallback is what should decide it.
  const r = classify({
    title: 'Follow-up to [Daily #744] — the helper needs id-scoped cleanup',
    labels: ['daily-failure'],
    body: 'Came out of triage; not a failure of its own.',
  })
  assert.equal(r.type, 'daily-failure-triage')
  assert.match(r.reason, /no title contract match/)
})

test('community label → community', () => {
  assert.equal(classify({ ...base, title: 'Playground crash', labels: ['community', 'high'] }).type, 'community')
})

test('file-watcher wording → file-watcher', () => {
  assert.equal(classify({ ...base, title: 'Upstream changes detected (file-watcher)', labels: [] }).type, 'file-watcher')
})

test('promote wording → validate-promote', () => {
  assert.equal(classify({ ...base, title: 'Validate & promote provider specs to @stable', labels: ['roadmap'] }).type, 'validate-promote')
})

test('test-automation label → new-spec', () => {
  assert.equal(classify({ ...base, title: 'anything', labels: ['test-automation'] }).type, 'new-spec')
})

test('"Create x.spec.ts" title → new-spec', () => {
  assert.equal(classify({ ...base, title: 'Create agent-tools.spec.ts — tool wiring', labels: ['roadmap'] }).type, 'new-spec')
})

test('no signal → null with reason', () => {
  const r = classify({ ...base, title: 'Improve docs', labels: [] })
  assert.equal(r.type, null)
  assert.match(r.reason, /no heuristic/)
})

test('body format B when template headings present', () => {
  assert.equal(detectBodyFormat('## What to test\nshould x when y'), 'B')
})

test('body format A when wave-deliverable fields present', () => {
  assert.equal(detectBodyFormat('**Type**: Create new spec\n**Done when**: merged'), 'A')
})

test('body format unknown otherwise', () => {
  assert.equal(detectBodyFormat('free text'), 'unknown')
})
