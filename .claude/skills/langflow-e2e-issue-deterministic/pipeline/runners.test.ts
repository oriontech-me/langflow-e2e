import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parsePwJson, enumerateTests, filterScoutSpecs } from './runners.ts'

test('filterScoutSpecs drops throwaway scout/tmp specs, keeps real ones', () => {
  const kept = filterScoutSpecs([
    'tests/tests-automations/regression/core-functionality/model-provider/groq-provider.spec.ts',
    'scout-491b-tmp.spec.ts',
    'tests/scout-canvas.spec.ts',
    'tests/probe-tmp.spec.ts',
    'docs/core-functionality/model-provider/groq-provider.md',
  ])
  assert.deepEqual(kept, [
    'tests/tests-automations/regression/core-functionality/model-provider/groq-provider.spec.ts',
    'docs/core-functionality/model-provider/groq-provider.md',
  ])
})

test('parsePwJson extracts stats and flags backend errors', () => {
  const raw = 'Some preamble\n' + JSON.stringify({
    stats: { expected: 6, unexpected: 1, flaky: 0, skipped: 2, duration: 13500.7 },
  }) + '\n'
  const s = parsePwJson(raw)!
  assert.equal(s.expected, 6)
  assert.equal(s.unexpected, 1)
  assert.equal(s.skipped, 2)
  assert.equal(s.durationMs, 13501)
  assert.equal(s.backendErrors, false)
})

test('parsePwJson detects the backend-error marker anywhere in output', () => {
  const raw = JSON.stringify({ stats: { expected: 1 } }) + '\n🚨 Backend Error: 500'
  assert.equal(parsePwJson(raw)!.backendErrors, true)
})

test('parsePwJson returns null on garbage', () => {
  assert.equal(parsePwJson('no json here'), null)
  assert.equal(parsePwJson('{"notStats": 1}'), null)
})

test('enumerateTests finds test titles, all quote styles', () => {
  const src = `
    test('first case @stable @agents', async ({ page }) => {})
    test("second case", async () => {})
    test(\`third case\`, async () => {})
  `
  assert.deepEqual(enumerateTests(src), [
    'first case @stable @agents', 'second case', 'third case',
  ])
})

test('enumerateTests ignores describe/step/skip and non-test calls', () => {
  const src = `
    test.describe('suite', () => {})
    test.step('a step', async () => {})
    test.skip('skipped one', async () => {})
    mytest('not a test', () => {})
    test.fixme('broken one', async () => {})
  `
  assert.deepEqual(enumerateTests(src), ['broken one'])
})

test('parsePwJson handles the reporter pretty-printed format', () => {
  const raw = '{\n  "config": {},\n  "stats": {\n    "expected": 2,\n    "unexpected": 0,\n    "flaky": 0,\n    "skipped": 0,\n    "duration": 25070.282\n  }\n}\n'
  const s = parsePwJson(raw)!
  assert.equal(s.expected, 2)
  assert.equal(s.unexpected, 0)
  assert.equal(s.durationMs, 25070)
})
