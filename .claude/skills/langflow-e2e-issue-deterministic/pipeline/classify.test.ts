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
