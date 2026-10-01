import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { PwStats } from './types.ts'
import { parsePwJson, pwRunResult, enumerateTests, enumerateTestEntries, enumerateRunnableTests, enumerateUnenumerableTests, classifyRun, classOf, countsAsClean, filterScoutSpecs, describeProviderHealthSkips } from './runners.ts'
import { formatProviderInactiveReason, formatProviderStaleReason } from '../../../../scripts/lib/provider-health-reason.mjs'

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
    backendErrors: false, backendErrorLines: [], failureMessages: [], ...over,
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

// ---------- titles as Playwright reports them (#2043) ----------

// The title the ENGINE produces for a literal — the oracle every case below is
// checked against, so the expectation is never a second hand-written decoder.
const runtimeValueOf = (literal: string): string =>
  new Function(`"use strict"; return ${literal}`)() as string

const specWithTitle = (literal: string) => `test(${literal}, { tag: ["@regression"] }, async () => {})`

test('an escaped title is enumerated as the runtime title, not as its spelling (#2043)', () => {
  // Measured on #2043: the source spelled `\\n` (an escaped backslash, then
  // `n`), Playwright reported ONE backslash, `ff-run` recorded that, and the
  // gate — comparing against the spelling — could never be satisfied.
  const literal = String.raw`"should open Create Knowledge Base with the 1000 / 200 / \\n defaults"`
  const titles = enumerateRunnableTests(specWithTitle(literal))
  assert.deepEqual(titles, ['should open Create Knowledge Base with the 1000 / 200 / \\n defaults'])
  assert.equal(titles[0], runtimeValueOf(literal))
  assert.ok(!titles[0].includes('\\\\'), 'the spelling (two backslashes) must not survive')
})

test('every string-literal escape resolves to what the engine produces', () => {
  const literals = [
    String.raw`"tab\there, newline\nthere, backslash \\ end"`,
    String.raw`'it\'s quoted'`,
    String.raw`"say \"hi\""`,
    String.raw`"\u00e9 \u{1F600} \x41 \0 \v\f\b\r"`,
    '"identity \\a \\d \\$ \\`"',
    '"line \\\ncontinuation"',
    String.raw`'mixed "double" and \'single\''`,
  ]
  for (const literal of literals) {
    assert.deepEqual(
      enumerateRunnableTests(specWithTitle(literal)),
      [runtimeValueOf(literal)],
      `title literal ${literal}`,
    )
  }
})

test('a no-substitution template title resolves too, an escaped ${ included', () => {
  const literals = [
    String.raw`${'`'}tab\t and \\n in a template${'`'}`,
    String.raw`${'`'}escaped \${not a substitution}${'`'}`,
    '`carriage\r\nreturn`',
  ]
  for (const literal of literals) {
    assert.deepEqual(
      enumerateRunnableTests(specWithTitle(literal)),
      [runtimeValueOf(literal)],
      `title literal ${JSON.stringify(literal)}`,
    )
  }
})

test('an escaped quote followed by a comma does not end the title', () => {
  // The lazy capture used to stop at the first quote followed by `\s*,`, so
  // `"say \"hi\", then leave"` was enumerated as `say \"hi\`.
  const literal = String.raw`"say \"hi\", then leave"`
  assert.deepEqual(enumerateRunnableTests(specWithTitle(literal)), ['say "hi", then leave'])
})

test('a title with a ${} substitution is unenumerable, never a required literal', () => {
  const src = [
    'for (const provider of PROVIDERS) {',
    '  test(`answers with ${provider}`, { tag: ["@regression"] }, async () => {})',
    '}',
    'test("literal sibling", async () => {})',
    'test.fixme(`muted ${x}`, async () => {})',
  ].join('\n')
  assert.deepEqual(enumerateRunnableTests(src), ['literal sibling'])
  // Reported in its source spelling, so the refusal names what the author wrote;
  // a muted one is still not in play.
  assert.deepEqual(enumerateUnenumerableTests(src), ['answers with ${provider}'])
  const entries = enumerateTestEntries(src)
  assert.deepEqual(entries.map(e => e.titleResolved), [false, true, false])
})

test('a capture that is not one literal is unenumerable, never a cooked title', () => {
  // The regex runs on to the next quote followed by a comma, so an expression
  // title yields a span with an unescaped delimiter or a line break in it.
  // Cooking that would invent a title nobody declared.
  const expression = 'test("prefix " + name, { tag: ["@a", "@b"] }, async () => {})'
  assert.deepEqual(enumerateRunnableTests(expression), [])
  assert.equal(enumerateUnenumerableTests(expression).length, 1)
})

test('an expression title does not swallow the test declared after it', () => {
  // The span of an unresolvable capture ends at the next quote followed by a
  // comma — here inside the NEXT test's title — so resuming the scan after it
  // made the literal test below silently absent.
  const src = [
    'test("prefix " + name, async () => {})',
    'test("the literal one after it", async () => {})',
  ].join('\n')
  assert.deepEqual(enumerateRunnableTests(src), ['the literal one after it'])
  assert.equal(enumerateUnenumerableTests(src).length, 1)
})

// ---------- only code declares a test (#2068) ----------

test('prose in a comment is not a test (global-variables-crud shape)', () => {
  // The real spec: the comment's "a test (`" opened a capture that ran ~50 lines
  // to the next backtick followed by a comma, inside a template in a helper, and
  // the gate then refused a "test" nobody declared — FORCE_FAIL could not close
  // for any issue touching that spec.
  const src = [
    '// Resolve a waiter, turning a timeout into a verdict of its own. Lives',
    '// outside the test bodies so the branch is not a conditional in',
    '// a test (`playwright/no-conditional-in-test`). The underlying error is kept',
    '// on the message.',
    'async function reveal(page, name) {',
    '  await expect.poll(async () => true, {',
    '    timeout: 15000,',
    '    message: `"${name}" never rendered in the variables table`,',
    '  }).toBe(true)',
    '}',
    'test(',
    '  "create a Generic type global variable",',
    '  { tag: ["@stable", "@release"] },',
    '  async ({ page }) => {},',
    ')',
  ].join('\n')
  const entries = enumerateTestEntries(src)
  assert.deepEqual(entries.map(e => e.title), ['create a Generic type global variable'])
  assert.deepEqual(entries[0].tags, ['@stable', '@release'])
  assert.deepEqual(enumerateUnenumerableTests(src), [])
})

test('a commented-out test is not a test', () => {
  const src = [
    '// test("retired in a line comment", async () => {})',
    '/* test("retired in a block comment", { tag: ["@stable"] }, async () => {}) */',
    '/**',
    ' * test(`retired in a JSDoc`, async () => {})',
    ' */',
    'test("the live one", async () => {})',
  ].join('\n')
  assert.deepEqual(enumerateTestEntries(src).map(e => e.title), ['the live one'])
})

test('a test() spelled inside a string or template literal is not a test', () => {
  const src = [
    'const CASES = [',
    `  { code: 'test("inside single quotes", async () => {})', lang: "ts" },`,
    '  { code: `test("inside a template", async () => {})`, lang: "ts" },',
    ']',
    'test("the live one", async () => {})',
  ].join('\n')
  assert.deepEqual(enumerateTestEntries(src).map(e => e.title), ['the live one'])
})

test('a comment before the title does not hide the test (mcp-client-regression shape)', () => {
  // The real spec is `@stable` and was invisible to every enumeration: the regex
  // expected a quote right after `test(` and met `//`.
  const src = [
    'test(',
    '  // Re-added @stable (#463): the hard failure was cold `npx',
    '  // server-everything` startup, "fixed" upstream.',
    '  "selects get-sum tool, provides numeric inputs, and verifies sum in output",',
    '  { tag: ["@mcp", "@regression", "@stable"] },',
    '  async ({ page }) => {},',
    ')',
  ].join('\n')
  const entries = enumerateTestEntries(src)
  assert.deepEqual(entries.map(e => e.title),
    ['selects get-sum tool, provides numeric inputs, and verifies sum in output'])
  assert.deepEqual(entries[0].tags, ['@mcp', '@regression', '@stable'])
  assert.equal(entries[0].titleResolved, true)
})

test('a comment in the options object does not lend its tags to the test', () => {
  const src = [
    'test(',
    '  "promoted one",',
    '  { /* was: tag: ["@stable"] */ tag: ["@regression"] },',
    '  async () => {},',
    ')',
  ].join('\n')
  assert.deepEqual(enumerateTestEntries(src)[0].tags, ['@regression'])
})

test('URLs, regex literals and divisions are not mistaken for comments or strings', () => {
  // The comment scan must know literals: a `//` inside a title is not a comment,
  // and a quote inside a regex literal must not open a string that would swallow
  // the tests after it — both would silently drop a real test.
  // Each line hides its test if the lexer misjudges it.
  const src = [
    'test("fetches http://example.com/a//b", async () => {})',
    'const FENCE = /```json/; test("after a regex holding backticks", async () => {}); const END = /`/',
    'const r = a / b; test("between two divisions", async () => {}); const s = c / d',
    'function f(s) { return /`/.test(s) }',
    'test("after a regex that follows return", async () => {}) // closing ` ',
  ].join('\n')
  assert.deepEqual(enumerateTestEntries(src).map(e => e.title), [
    'fetches http://example.com/a//b', 'after a regex holding backticks',
    'between two divisions', 'after a regex that follows return',
  ])
})

test('a comma or a template inside a ${} substitution does not end the title', () => {
  // The title is the first argument up to its TOP-LEVEL comma, so a substitution
  // is code with brackets of its own — and may hold a template of its own.
  const src = [
    'test(`answers ${fmt(a, b)} and ${ok ? `yes, ${n}` : "no"}`, { tag: ["@regression"] }, async () => {})',
    'test("the literal one after it", async () => {})',
  ].join('\n')
  assert.deepEqual(enumerateUnenumerableTests(src), ['answers ${fmt(a, b)} and ${ok ? `yes, ${n}` : "no"}'])
  assert.deepEqual(enumerateTestEntries(src)[0].tags, ['@regression'])
  assert.deepEqual(enumerateRunnableTests(src), ['the literal one after it'])
})

test('a regex the lexer misjudges costs at most its own line', () => {
  // After `)` a `/` is read as a division, so this regex's quote opens a string.
  // A string ends at its line break, or it would run on and hide the next test.
  const src = [
    'if (ok) /"/.test(s)',
    'test("after a misjudged regex", async () => {})',
  ].join('\n')
  assert.deepEqual(enumerateTestEntries(src).map(e => e.title), ['after a misjudged regex'])
})

// ---------- a title held in a name (#2068) ----------

test('a title held in a same-file const is enumerated as its value (api-coverage-gate shape)', () => {
  // The real spec keeps the title in a constant so later tests can find the
  // record by it. `TEST_RE` wanted a quote, so the test was absent from every
  // enumeration — the gate never asked for its force-fail and never said so.
  const src = [
    'const UNFULFILLED_TITLE = "a declaration the test never issues fails it";',
    'test(',
    '  UNFULFILLED_TITLE,',
    '  { tag: ["@stable", "@api"] },',
    '  async ({ request, apiCoverage }) => {},',
    ')',
  ].join('\n')
  const entries = enumerateTestEntries(src)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].title, 'a declaration the test never issues fails it')
  assert.equal(entries[0].titleResolved, true)
  assert.deepEqual(entries[0].tags, ['@stable', '@api'])
  assert.deepEqual(enumerateRunnableTests(src), ['a declaration the test never issues fails it'])
})

test('a title held in a name the source cannot resolve is unenumerable, never absent', () => {
  const cases: Array<[string, string]> = [
    ['import { SHARED_TITLE } from "./titles"\ntest(SHARED_TITLE, async () => {})', 'SHARED_TITLE'],
    ['test(CASES.first, { tag: ["@regression"] }, async () => {})', 'CASES.first'],
    ['const T = "a " + suffix;\ntest(T, async () => {})', 'T'],
    ['let T = "reassignable";\ntest(T, async () => {})', 'T'],
    ['const T = "one";\nfunction f() { const T = "two" }\ntest(T, async () => {})', 'T'],
    ['const T = `with ${x}`;\ntest(T, async () => {})', 'T'],
    ['import { T } from "./titles"\nfunction f() { const T = "local"; }\ntest(T, async () => {})', 'T'],
  ]
  for (const [src, spelling] of cases) {
    assert.deepEqual(enumerateRunnableTests(src), [], src)
    assert.deepEqual(enumerateUnenumerableTests(src), [spelling], src)
  }
})

test('a conditional skip/fixme/fail annotation inside a body is not a test', () => {
  // Same `test.<modifier>(name, …)` shape as a declaration; only a declaration
  // passes an options object or a callback after its first argument.
  const src = [
    'test("the only declaration", async () => {',
    '  test.skip(gate.skip, gate.reason)',
    '  test.skip(true, e.message)',
    '  test.fixme(isMac, "flaky on mac")',
    '  test.fail(cond, `known ${bug}`)',
    '  test.skip(!pristine, skipReason)',
    // Both from real specs (api-validation-redaction, assistant-ollama-provider):
    // a parenthesised reason is not a callback, and a condition that starts
    // with a string is not a title.
    '  test.skip(verdict.available === false, (verdict as { skipReason?: string }).skipReason)',
    '  test.skip("skipReason" in setup, "skipReason" in setup ? setup.skipReason : "")',
    '})',
    'test.fixme(MUTED_TITLE, async () => {})',
  ].join('\n')
  const entries = enumerateTestEntries(src)
  assert.deepEqual(entries.map(e => [e.title, e.modifier]),
    [['the only declaration', ''], ['MUTED_TITLE', '.fixme']])
})

// ---------- declared-ambient backend errors (#1422) ----------

const greenWithBackendError = (lines: string[]): PwStats => ({
  expected: 8, unexpected: 0, flaky: 0, skipped: 0, durationMs: 100_000,
  backendErrors: lines.length > 0, backendErrorLines: lines, failureMessages: [],
})

const FLOWS_500 = '🚨 Backend Error: 500 Internal Server Error - http://localhost:7860/api/v1/flows/'

test('a green run whose only backend error is declared ambient counts as clean', () => {
  // #1422: 8 of 8 tests passed on 1.12.0.dev25 while the UI's bulk
  // DELETE /api/v1/flows/ answered 500 (`OperationalError: database is locked`,
  // flows.py:993). Without this the burst could never close on this file, and
  // the alternatives were worse: `allowHttpErrors()` on the spec blinds the
  // monitor #1084 exists for, and a mute with no written reason is how an
  // exemption outlives its justification.
  const cls = classifyRun(greenWithBackendError([FLOWS_500]), {
    patterns: ['500 Internal Server Error - http://localhost:7860/api/v1/flows/'],
    reason: 'SQLite lock on the UI bulk delete; 8/8 tests pass',
  })
  assert.equal(cls, 'clean-ambient')
})

test('one UNDECLARED backend error keeps the run a real failure', () => {
  // The load-bearing half: a declaration excuses what it names and nothing
  // else, so it cannot become a blanket `allowHttpErrors()` for the burst.
  const cls = classifyRun(
    greenWithBackendError([FLOWS_500, '🚨 Backend Error: 500 - http://localhost:7860/api/v2/mcp/servers/x']),
    { patterns: ['/api/v1/flows/'], reason: 'ambient SQLite lock' },
  )
  assert.equal(cls, 'real-failure')
})

test('a declaration without a reason is not honoured', () => {
  // The CLI refuses this pair up front; the classifier refuses it too, so the
  // guarantee does not depend on which entry point wrote the evidence.
  const cls = classifyRun(greenWithBackendError([FLOWS_500]), {
    patterns: ['/api/v1/flows/'], reason: '   ',
  })
  assert.equal(cls, 'real-failure')
})

test('a declaration cannot excuse a FAILING test', () => {
  // Only the backend-error half is excusable: an actual red stays red, however
  // ambient the accompanying HTTP noise is.
  const stats: PwStats = {
    expected: 7, unexpected: 1, flaky: 0, skipped: 0, durationMs: 100_000,
    backendErrors: true, backendErrorLines: [FLOWS_500],
    failureMessages: ['Error: expect(locator).toBeVisible() failed'],
  }
  assert.equal(
    classifyRun(stats, { patterns: ['/api/v1/flows/'], reason: 'ambient' }),
    'real-failure',
  )
})

test('parsePwJson keeps every backend-error line, not just a boolean', () => {
  // The boolean can only be obeyed; the lines are what a declaration is matched
  // against, and what the PR body has to quote.
  const raw = [
    FLOWS_500,
    '🚨 Backend Error: 422 Unprocessable Content - http://localhost:7860/api/v2/mcp/servers/x',
    '{"stats":{"expected":8,"unexpected":0,"flaky":0,"skipped":0,"duration":1000}}',
  ].join('\n')
  const stats = parsePwJson(raw)
  assert.ok(stats)
  assert.equal(stats!.backendErrors, true)
  assert.equal(stats!.backendErrorLines.length, 2)
  assert.match(stats!.backendErrorLines[0], /api\/v1\/flows/)
})

// ---------- stdout vs stderr (#1837) ----------

// A real pair of streams: the JSON reporter writes the payload to stdout, and
// globalSetup writes its API-drift warning — route templates and all — to
// stderr. The brace in "{connection_id}" is the whole defect.
const REPORT_STDOUT = [
  '[preflight] backend healthy at http://localhost:7892 — Langflow Nightly 1.13.0.dev12',
  '{\n  "config": { "rootDir": "/repo/tests" },\n  "stats": { "expected": 3, "unexpected": 0, "flaky": 0, "skipped": 0, "duration": 41900 }\n}',
].join('\n')
const DRIFT_STDERR = [
  '[lane] @destructive tests are excluded from this run',
  '[preflight] WARNING: the API surface DRIFTED from the baseline (#1692):',
  '  ADDED   PATCH /api/v1/connections/{connection_id}',
].join('\n')

test('parsePwJson reads the payload from stdout even when stderr carries a brace', () => {
  // The regression: one concatenated string put "{connection_id}" after the
  // payload, lastIndexOf('}') landed inside the warning and every run in every
  // phase came back "could not parse playwright JSON" — on runs that passed.
  assert.equal(parsePwJson(REPORT_STDOUT + '\n' + DRIFT_STDERR), null,
    'precondition: the concatenated form is what fails')
  const s = parsePwJson(REPORT_STDOUT, REPORT_STDOUT + '\n' + DRIFT_STDERR)
  assert.ok(s, 'stdout alone must parse')
  assert.equal(s!.expected, 3)
  assert.equal(s!.durationMs, 41900)
})

test('parsePwJson still scans BOTH streams for the backend-error marker', () => {
  // What this pins is the WIDTH of the scan, and the layout below is
  // deliberately synthetic — the first version of this test claimed the fixture
  // writes the marker to stderr, which it does not. Measured on 1.58.2 under
  // `--reporter=json`: `fixtures.ts` prints it with `console.log`, and nothing a
  // worker prints reaches the process streams at all — it is captured into the
  // payload as `results[].stdout` / `.stderr` (process stderr: 0 bytes), so a
  // stdout-only scan finds it on a real report. The width is resilience to that
  // changing (a reporter that forwards worker output, a marker from a global
  // hook), not a live gate — see the note on `parsePwJson`.
  const stderr = DRIFT_STDERR + '\n🚨 Backend Error: 500 - http://localhost:7860/api/v1/flows/'
  const s = parsePwJson(REPORT_STDOUT, REPORT_STDOUT + '\n' + stderr)
  assert.ok(s)
  assert.equal(s!.backendErrors, true)
  assert.equal(s!.backendErrorLines.length, 1)
  assert.match(s!.backendErrorLines[0], /api\/v1\/flows/)
})

test('pwRunResult reads the report from stdout and keeps both streams in raw', () => {
  // The call site is the half that actually broke, and runPlaywright is a
  // subprocess wrapper no test can reach — so the stream routing lives here.
  const stderr = DRIFT_STDERR + '\n🚨 Backend Error: 500 - http://localhost:7860/api/v1/flows/'
  const { stats, raw } = pwRunResult(REPORT_STDOUT, stderr)
  assert.ok(stats, 'a brace in stderr must not make the run unreadable')
  assert.equal(stats!.expected, 3)
  assert.equal(stats!.backendErrors, true)
  assert.ok(raw.includes('{connection_id}'), 'raw keeps stderr for every other reader')
  assert.ok(raw.includes('"stats"'), 'raw keeps stdout too')
})

test('parsePwJson defaults the scan source to the payload source', () => {
  // One-argument callers (and every test above) keep reading the marker out of
  // the single string they hold.
  const raw = '{"stats":{"expected":1}}\n🚨 Backend Error: 503'
  assert.equal(parsePwJson(raw)!.backendErrors, true)
})

// ---------- zero-evidence runs (#1593) ----------

const noRun: PwStats = {
  expected: 0, unexpected: 0, flaky: 0, skipped: 0, durationMs: 120,
  backendErrors: false, backendErrorLines: [], failureMessages: [],
}

test('classifyRun refuses a run that executed nothing — zero tests selected', () => {
  // THE trap #1593 names: run a lane-selected spec without its lane flag and
  // grepInvert correctly selects zero tests. Every green predicate holds
  // (unexpected=0, flaky=0, no backend error), so the old classifier said
  // `clean` and a gate could close having executed nothing.
  assert.equal(classifyRun(noRun), 'no-evidence')
})

test('classifyRun refuses a run whose every test skipped', () => {
  // Same absence of evidence by the other route: a runtime test.skip(cond) —
  // a missing provider key, an unmet lane gate. Tests exist, none answered.
  assert.equal(classifyRun({ ...noRun, skipped: 4 }), 'no-evidence')
})

test('classifyRun still calls a single passing test clean', () => {
  assert.equal(classifyRun({ ...noRun, expected: 1 }), 'clean')
})

test('an empty run is never laundered clean by an ambient declaration', () => {
  const declared = { patterns: ['500 /api/v1/flows/'], reason: 'known' }
  // Truly empty — nothing ran, nothing fired. The declaration has nothing to
  // excuse, and cannot supply a result that was never produced.
  assert.equal(classifyRun(noRun, declared), 'no-evidence')
  // Nothing ran but the monitor DID fire: something broke before any test could
  // start (globalSetup, a fixture). That is a positive signal, so it outranks
  // the absence of one and stays a real failure — which is also what keeps it
  // out of `clean-ambient`, the class an empty green-looking run would land in.
  const empty = {
    ...noRun, backendErrors: true,
    backendErrorLines: ['🚨 Backend Error: 500 /api/v1/flows/'],
  }
  assert.equal(classifyRun(empty, declared), 'real-failure')
})

test('countsAsClean rejects a no-evidence record, and classOf derives it for legacy state', () => {
  assert.equal(countsAsClean({ target: 'a.spec.ts', stats: noRun, class: 'no-evidence' }), false)
  // Records written before this class existed carry no `class`. Deriving
  // `clean` for them is the same false verdict from the state file instead of
  // the run, so the derivation refuses an empty record too — a phase needs one
  // more run, never one fewer.
  assert.equal(classOf({ target: 'a.spec.ts', stats: noRun }), 'no-evidence')
  assert.equal(classOf({ target: 'a.spec.ts', stats: { ...noRun, expected: 2 } }), 'clean')
})

// ---------- provider-health skips in a mixed spec (#2034) ----------

// The descriptions come from the PRODUCER's own formatter, so a change to the
// wording fails here instead of silently turning these into ordinary skips.
const STALE_DESC = formatProviderStaleReason('openai', '2026-09-24T10:00:00.000Z', 12)
const INACTIVE_DESC = formatProviderInactiveReason('anthropic', 'credit balance is too low')

function mixedReport(): string {
  return JSON.stringify({
    stats: { expected: 2, unexpected: 0, flaky: 0, skipped: 3, duration: 100 },
    suites: [{
      title: 'core-functionality/model-provider/x.spec.ts',
      file: 'core-functionality/model-provider/x.spec.ts',
      specs: [{ title: 'renders the panel without a provider', file: 'core-functionality/model-provider/x.spec.ts',
        tests: [{ status: 'expected', annotations: [], results: [{ status: 'passed' }] }] }],
      suites: [{
        title: 'Agent [openai / gpt-4o-mini]',
        file: 'core-functionality/model-provider/x.spec.ts',
        specs: [
          { title: 'answers through the agent', file: 'core-functionality/model-provider/x.spec.ts',
            tests: [{ status: 'skipped', annotations: [{ type: 'skip', description: STALE_DESC }], results: [{ status: 'skipped' }] }] },
          { title: 'is parked', file: 'core-functionality/model-provider/x.spec.ts',
            tests: [{ status: 'skipped', annotations: [{ type: 'fixme', description: 'LE-1234' }], results: [{ status: 'skipped' }] }] },
          { title: 'stores the key', file: 'core-functionality/model-provider/x.spec.ts',
            tests: [{ status: 'expected', annotations: [], results: [{ status: 'passed' }] }] },
        ],
      }, {
        title: 'Agent [anthropic / claude-haiku-4-5]',
        file: 'core-functionality/model-provider/x.spec.ts',
        specs: [{ title: 'answers through the agent', file: 'core-functionality/model-provider/x.spec.ts',
          tests: [{ status: 'skipped', annotations: [{ type: 'skip', description: INACTIVE_DESC }], results: [{ status: 'skipped' }] }] }],
      }],
    }],
  })
}

test('parsePwJson names each provider-health skip, with its describe chain, and ignores other skips', () => {
  const s = parsePwJson(mixedReport())!
  assert.deepEqual(s.providerHealthSkips, [
    {
      file: 'core-functionality/model-provider/x.spec.ts',
      title: 'Agent [openai / gpt-4o-mini] › answers through the agent',
      provider: 'openai',
      reason: STALE_DESC.split(' — ').slice(1).join(' — '),
      stale: true,
    },
    {
      file: 'core-functionality/model-provider/x.spec.ts',
      title: 'Agent [anthropic / claude-haiku-4-5] › answers through the agent',
      provider: 'anthropic',
      reason: 'credit balance is too low',
      stale: false,
    },
  ])
})

test('a mixed spec whose provider tests skipped on a stale record is NOT a clean run (#2034)', () => {
  const s = parsePwJson(mixedReport())!
  assert.equal(s.expected, 2, 'precondition: other tests did execute, so this is not no-evidence')
  assert.equal(classifyRun(s), 'provider-unevaluated')
  assert.equal(countsAsClean({ target: 'x.spec.ts', stats: s, class: classifyRun(s) }), false)
})

test('an ambient-excused green run with a provider-health skip is still unevaluated', () => {
  const line = '🚨 Backend Error: 500 /api/v1/flows/'
  const s = statsWith({
    expected: 3, backendErrors: true, backendErrorLines: [line],
    providerHealthSkips: [{ file: 'f', title: 't', provider: 'openai', reason: 'r', stale: true }],
  })
  assert.equal(classifyRun(s, { patterns: ['/api/v1/flows/'], reason: 'ambient' }), 'provider-unevaluated')
})

test('a provider-health skip never downgrades a real failure or an infra void', () => {
  const skip = [{ file: 'f', title: 't', provider: 'openai', reason: 'r', stale: true }]
  assert.equal(
    classifyRun(statsWith({ expected: 1, unexpected: 1, failureMessages: ['Error: expect(x).toBe(y)'], providerHealthSkips: skip })),
    'real-failure')
  assert.equal(
    classifyRun(statsWith({ unexpected: 1, failureMessages: [AUTO_LOGIN_ERR], providerHealthSkips: skip })),
    'infra-void')
})

test('a run where EVERY test skipped on provider health stays no-evidence', () => {
  const s = statsWith({ skipped: 2, providerHealthSkips: [{ file: 'f', title: 't', provider: 'openai', reason: 'r', stale: false }] })
  assert.equal(classifyRun(s), 'no-evidence')
})

test('a run with no provider-health skip, or a pre-#2034 record without the field, is unchanged', () => {
  assert.equal(classifyRun(statsWith({ expected: 2, skipped: 1, providerHealthSkips: [] })), 'clean')
  assert.equal(classifyRun(statsWith({ expected: 2, skipped: 1 })), 'clean')
})

test('describeProviderHealthSkips names the test, the provider state and the matching remedy', () => {
  const lines = describeProviderHealthSkips(parsePwJson(mixedReport())!)
  assert.match(lines[0], /Agent \[openai \/ gpt-4o-mini\] › answers through the agent — provider "openai" stale: checked 2026-09-24/)
  assert.match(lines[1], /provider "anthropic" inactive: credit balance is too low/)
  assert.match(lines.at(-1)!, /collect-models\.spec\.ts/)
  assert.match(lines.at(-1)!, /IGNORE_PROVIDER_HEALTH=1/)
  assert.deepEqual(describeProviderHealthSkips(statsWith({ expected: 1 })), [])
})
