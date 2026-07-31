import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { PwStats } from './types.ts'
import { parsePwJson, enumerateTests, enumerateTestEntries, enumerateRunnableTests, classifyRun, filterScoutSpecs } from './runners.ts'

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

// ---------- infra-abort classification (#1082) ----------

function statsWith(over: Partial<PwStats>): PwStats {
  return {
    expected: 0, unexpected: 0, flaky: 0, skipped: 0, durationMs: 1000,
    backendErrors: false, failureMessages: [], ...over,
  }
}

const AUTO_LOGIN_ERR = 'TimeoutError: apiRequestContext.get: Timeout 20000ms exceeded.\nCall log:\n  - → GET http://localhost:7860/api/v1/auto_login\n'

test('classifyRun calls a clean run clean', () => {
  assert.equal(classifyRun(statsWith({ expected: 2 })), 'clean')
})

test('classifyRun voids a run whose only failure is the auto_login timeout', () => {
  const s = statsWith({ unexpected: 1, failureMessages: [AUTO_LOGIN_ERR] })
  assert.equal(classifyRun(s), 'infra-void')
})

test('classifyRun voids socket hang up and connection refused', () => {
  for (const msg of ['Error: apiRequestContext.get: socket hang up', 'net::ERR_CONNECTION_REFUSED at http://localhost:7860']) {
    assert.equal(classifyRun(statsWith({ unexpected: 1, failureMessages: [msg] })), 'infra-void')
  }
})

test('classifyRun keeps a real assertion failure real, even mixed with an infra one', () => {
  const assertion = 'Error: expect(received).toBe(expected) // Object.is equality'
  assert.equal(classifyRun(statsWith({ unexpected: 1, failureMessages: [assertion] })), 'real-failure')
  assert.equal(
    classifyRun(statsWith({ unexpected: 2, failureMessages: [AUTO_LOGIN_ERR, assertion] })),
    'real-failure',
  )
})

test('classifyRun never voids a failure it cannot read', () => {
  assert.equal(classifyRun(statsWith({ unexpected: 1, failureMessages: [] })), 'real-failure')
  assert.equal(classifyRun(statsWith({ backendErrors: true })), 'real-failure')
})

test('parsePwJson collects every non-passing result message', () => {
  const raw = JSON.stringify({
    stats: { expected: 1, unexpected: 1, flaky: 0, skipped: 0, duration: 100 },
    suites: [{
      specs: [{
        title: 'a test',
        tests: [{ results: [
          { status: 'failed', error: { message: AUTO_LOGIN_ERR } },
          { status: 'passed' },
        ] }],
      }],
      suites: [{ specs: [{ title: 'nested', tests: [{ results: [{ status: 'failed', errors: [{ message: 'boom' }] }] }] }] }],
    }],
  })
  const s = parsePwJson(raw)!
  assert.equal(s.failureMessages.length, 2)
  assert.ok(s.failureMessages[0].includes('auto_login'))
  assert.equal(s.failureMessages[1], 'boom')
})

// ---------- test entries: modifier + tags (#1082) ----------

const SPEC_SRC = `
  test(
    "quarantined one",
    { tag: ["@regression", "@agents"] },
    async ({ page }) => {},
  )
  test.fixme(
    "still muted",
    { tag: ["@regression"] },
    async ({ page }) => {},
  )
  test('promoted one', { tag: ['@stable', '@playground'] }, async () => {})
  test('untagged one', async () => {})
`

test('enumerateTestEntries reads modifier and tags per test', () => {
  const e = enumerateTestEntries(SPEC_SRC)
  assert.deepEqual(e.map(x => x.title), ['quarantined one', 'still muted', 'promoted one', 'untagged one'])
  assert.deepEqual(e[0].tags, ['@regression', '@agents'])
  assert.equal(e[0].modifier, '')
  assert.equal(e[1].modifier, '.fixme')
  assert.deepEqual(e[2].tags, ['@stable', '@playground'])
  assert.deepEqual(e[3].tags, [])
})

test('enumerateTestEntries never borrows the next test\'s tags', () => {
  const e = enumerateTestEntries(SPEC_SRC)
  assert.deepEqual(e[3].tags, [])
})

test('enumerateRunnableTests drops fixme/skip — a muted test cannot be force-failed', () => {
  assert.deepEqual(
    enumerateRunnableTests(SPEC_SRC),
    ['quarantined one', 'promoted one', 'untagged one'],
  )
})
