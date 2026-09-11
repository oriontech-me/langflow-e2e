import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  checkSpecDoc, checkQaDiff, checkForceFailCoverage,
  checkNoMutationMarkers, checkPrReadiness, BRANCH_RE,
  checkQuarantineLifted, extractSymptomRows, checkSymptomCoverage,
  symptomsOwnedElsewhere, checkDebugEvidence, checkBranchPurity, checkCiVerdict,
  checkFinalGreenCoverage, finalGreenTargets, resolveClassification,
  checkRegressionLedger, normalizeUpstreamTicket, LEDGER_FILE,
} from './gates.ts'
import type { RunRecord } from './types.ts'

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

test('checkQaDiff allows the structural lines a new Part II area needs', () => {
  const diff = [
    '--- a/QA-CHECKLIST.md', '+++ b/QA-CHECKLIST.md',
    '+---',
    '+### core-functionality/a2a/ — Agent-to-Agent Protocol (1.11.0)',
    '+> ⚠️ Needs LANGFLOW_A2A_ENABLED=true; surface map in docs/.',
    '+#### 16.1 A2A Server',
    '+- [ ] Agent card served for a published flow — protocolVersion="0.3.0"',
  ].join('\n')
  assert.deepEqual(checkQaDiff(diff), [])
})

test('checkQaDiff still rejects a generated line that looks structural', () => {
  // The generated-block branches run first, so heading/blockquote tolerance
  // cannot be used to smuggle a table row or a Phase 0 edit past the gate.
  assert.ok(checkQaDiff('+#### Phase 0 — Validated (12)').length > 0)
  assert.ok(checkQaDiff('+| `core-functionality/a2a/` | 18 | 0 | 0 | 0 | 18 |').length > 0)
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

// A `langflow-regression` issue must SURVIVE its own fix PR (#1759). Its
// deliverable says so: "this issue stays open until the upstream fix lands in
// langflowai/langflow-nightly:latest, is re-validated there, and @stable is
// restored". `Closes #NNN` would close it at merge and drop the tracking of an
// upstream ticket that is still open — so under that verdict the gate INVERTS:
// a non-closing reference is required and `Closes` is the defect. The house
// convention already does this by hand (PR #1761: "Tracked by #1759 — this PR
// does not fix it, and does not close that issue").

const REGRESSION = 'langflow-regression'

test('a langflow-regression PR may reference the issue without closing it (#1759)', () => {
  for (const ref of ['Refs #1759', 'Tracked by #1759', 'Part of #1759']) {
    const problems = checkPrReadiness({
      branch: 'fix/issue-1759-flows-crud', prBody: `${ref}\n## Problem`,
      issue: 1759, isWave: false, labels: [], verdict: REGRESSION,
    })
    assert.deepEqual(problems, [], `"${ref}" should satisfy the gate under a product verdict`)
  }
})

test('a langflow-regression PR is REFUSED for saying Closes (#1759)', () => {
  // The load-bearing half. Merely accepting both forms would let the wrong one
  // through silently, and the wrong one closes an issue tracking a live
  // upstream defect.
  const problems = checkPrReadiness({
    branch: 'fix/issue-1759-flows-crud', prBody: 'Closes #1759\n## Problem',
    issue: 1759, isWave: false, labels: [], verdict: REGRESSION,
  })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /Closes #1759/)
  assert.match(problems[0], /stay open|must not close|Refs/i)
})

test('a langflow-regression PR still needs SOME reference to its issue (#1759)', () => {
  const problems = checkPrReadiness({
    branch: 'fix/issue-1759-flows-crud', prBody: '## Problem\nno reference at all',
    issue: 1759, isWave: false, labels: [], verdict: REGRESSION,
  })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /1759/)
})

test('every other verdict still requires Closes (#1759)', () => {
  for (const verdict of [undefined, 'test-defect', 'transient-saturation', 'product-changed']) {
    const problems = checkPrReadiness({
      branch: 'fix/issue-1759-flows-crud', prBody: 'Refs #1759\n## Problem',
      issue: 1759, isWave: false, labels: [], verdict,
    })
    assert.equal(problems.length, 1, `verdict ${verdict} must still require Closes`)
    assert.match(problems[0], /missing "Closes #1759"/)
  }
})

// ---------- quarantine lift (#1082) ----------

const QUARANTINE_BODY = `
## Flake signal
As prevention it was **quarantined** at triage in PR #1064 — \`@stable\` removed **and** \`test.fixme\` added.
Lifting the quarantine after the fix (remove \`test.fixme\` + restore \`@stable\`) is a deliverable of this issue.
The test is "switching the agent's context_id re-tags new turns".
`

test('checkQuarantineLifted is inert for an issue that never quarantined anything', () => {
  const files = [{ file: 'a.spec.ts', entries: [{ title: 't', modifier: '.fixme', tags: [] }] }]
  assert.deepEqual(checkQuarantineLifted('a plain new-spec issue', files), [])
})

test('checkQuarantineLifted flags a surviving test.fixme', () => {
  const files = [{
    file: 'a.spec.ts',
    entries: [{ title: "switching the agent's context_id re-tags new turns", modifier: '.fixme', tags: ['@stable'] }],
  }]
  const problems = checkQuarantineLifted(QUARANTINE_BODY, files)
  assert.equal(problems.length, 1)
  assert.match(problems[0], /test\.fixme still on/)
})

test('checkQuarantineLifted ignores a test.fixme the issue does not name (#1422)', () => {
  // The touched file carries two quarantines: the one this issue owns and one
  // another issue is still investigating. Demanding both would make this PR
  // close someone else's flake — and #1422's body arms the gate only through
  // the template's "Quarantine lifted" line, having quarantined nothing.
  const files = [{
    file: 'a.spec.ts',
    entries: [
      { title: "switching the agent's context_id re-tags new turns", modifier: '', tags: ['@stable'] },
      { title: 'user must be able to change mode of MCP tools', modifier: '.fixme', tags: ['@release'] },
    ],
  }]
  assert.deepEqual(checkQuarantineLifted(QUARANTINE_BODY, files), [])
})

test('checkQuarantineLifted stays strict when the body names no touched test', () => {
  // Cannot attribute ⇒ cannot excuse: an issue whose body arms the gate but
  // names none of the touched titles still gets every surviving `.fixme`
  // flagged, so the precise path above can never become a way through.
  const files = [{
    file: 'a.spec.ts',
    entries: [{ title: 'some other muted test', modifier: '.fixme', tags: [] }],
  }]
  const problems = checkQuarantineLifted(QUARANTINE_BODY, files)
  assert.equal(problems.length, 1)
  assert.match(problems[0], /test\.fixme still on "some other muted test"/)
})

test('checkQuarantineLifted flags a missing @stable when the issue asks for it', () => {
  const files = [{
    file: 'a.spec.ts',
    entries: [{ title: "switching the agent's context_id re-tags new turns", modifier: '', tags: ['@regression'] }],
  }]
  const problems = checkQuarantineLifted(QUARANTINE_BODY, files)
  assert.equal(problems.length, 1)
  assert.match(problems[0], /@stable not restored/)
})

test('checkQuarantineLifted passes once fixme is gone and @stable is back', () => {
  const files = [{
    file: 'a.spec.ts',
    entries: [
      { title: "switching the agent's context_id re-tags new turns", modifier: '', tags: ['@stable', '@agents'] },
      { title: 'an unrelated sibling the issue never names', modifier: '', tags: ['@regression'] },
    ],
  }]
  assert.deepEqual(checkQuarantineLifted(QUARANTINE_BODY, files), [])
})

// A product verdict makes the `@stable` half of the deliverable UNREACHABLE, and
// the issue template says so itself — two of its own checkboxes contradict each
// other (#1759, measured on the real body):
//
//   "Quarantine lifted in the fix PR — remove `test.fixme` **and** restore `@stable`"
//   "If the root cause is a **product (Langflow) regression**: ... `@stable` is
//    restored — not on a test-side mute."
//
// The second is a condition on the first, and the gate read only the first. Under
// `langflow-regression` the tag goes back when the UPSTREAM fix lands and is
// re-validated, so demanding it in the fix PR asks for exactly the test-side mute
// the body forbids — and would return a test that fails on a live product defect
// to the daily.
//
// The exemption is SCOPED TO THE TAG. `test.fixme` still has to come off: a muted
// test gives no signal in any context, and while the defect is live that signal is
// the only thing saying it is still there. An exemption that silenced the whole
// gate would let a product verdict ship a permanently muted test — strictly worse
// than the bug this gate exists to prevent.

test('checkQuarantineLifted does not demand @stable under a langflow-regression verdict (#1759)', () => {
  const files = [{
    file: 'a.spec.ts',
    entries: [{ title: "switching the agent's context_id re-tags new turns", modifier: '', tags: ['@regression'] }],
  }]
  assert.deepEqual(checkQuarantineLifted(QUARANTINE_BODY, files, 'langflow-regression'), [])
})

test('a langflow-regression verdict still demands the test.fixme comes off (#1759)', () => {
  // The load-bearing half. If the verdict silenced the whole gate instead of just
  // the tag, a product regression could ship a test muted in every context.
  const files = [{
    file: 'a.spec.ts',
    entries: [{ title: "switching the agent's context_id re-tags new turns", modifier: '.fixme', tags: ['@regression'] }],
  }]
  const problems = checkQuarantineLifted(QUARANTINE_BODY, files, 'langflow-regression')
  assert.equal(problems.length, 1)
  assert.match(problems[0], /test\.fixme still on/)
  assert.doesNotMatch(problems[0], /@stable/)
})

test('only a product verdict exempts the tag — every other verdict still demands it (#1759)', () => {
  const files = [{
    file: 'a.spec.ts',
    entries: [{ title: "switching the agent's context_id re-tags new turns", modifier: '', tags: ['@regression'] }],
  }]
  for (const verdict of ['test-defect', 'transient-saturation', 'cross-worker-wiper', 'product-changed', 'stale-confirmed-bug']) {
    const problems = checkQuarantineLifted(QUARANTINE_BODY, files, verdict)
    assert.equal(problems.length, 1, `verdict ${verdict} must still demand @stable`)
    assert.match(problems[0], /@stable not restored/)
  }
})

test('an absent verdict keeps the pre-#1759 behaviour', () => {
  // Callers that pass nothing (and every phase other than VALIDATE) must be
  // unaffected: no verdict is not a product verdict.
  const files = [{
    file: 'a.spec.ts',
    entries: [{ title: "switching the agent's context_id re-tags new turns", modifier: '', tags: ['@regression'] }],
  }]
  const problems = checkQuarantineLifted(QUARANTINE_BODY, files, undefined)
  assert.equal(problems.length, 1)
  assert.match(problems[0], /@stable not restored/)
})

// ---------- symptom rows (#1082) ----------

const TWO_ROW_BODY = `
| Spec (line) | Waits for | Signature |
|---|---|---|
| \`tests-automations/regression/core-functionality/llm-agents/agent-context-id-isolation.spec.ts:570\` ("switching…") | the context_id | \`Object.is equality\` |
| \`tests-automations/regression/core-functionality/llm-agents/agent-context-id-isolation.spec.ts:570\` ("… google / gemini") | the context_id | \`unknown\` |
`

test('extractSymptomRows pulls spec:line cells out of the issue table', () => {
  assert.deepEqual(extractSymptomRows(TWO_ROW_BODY), [
    'tests-automations/regression/core-functionality/llm-agents/agent-context-id-isolation.spec.ts:570',
  ])
  assert.deepEqual(extractSymptomRows('no table here'), [])
})

test('checkSymptomCoverage demands a verdict for every row', () => {
  const rows = ['a.spec.ts:10', 'b.spec.ts:20']
  const problems = checkSymptomCoverage(rows, [{ row: 'a.spec.ts:10', verdict: 'test-defect' }])
  assert.equal(problems.length, 1)
  assert.match(problems[0], /b\.spec\.ts:20/)
})

test('checkSymptomCoverage rejects an unknown verdict and a malformed ownedBy', () => {
  const problems = checkSymptomCoverage(['a.spec.ts:10'], [
    { row: 'a.spec.ts:10', verdict: 'vibes', ownedBy: '1030' },
  ])
  assert.equal(problems.length, 2)
})

test('checkSymptomCoverage accepts a row owned by another issue', () => {
  assert.deepEqual(
    checkSymptomCoverage(['a.spec.ts:10'], [{ row: 'a.spec.ts:10', verdict: 'transient-saturation', ownedBy: '#1030' }]),
    [],
  )
  assert.deepEqual(symptomsOwnedElsewhere([{ ownedBy: '#1030' }, { verdict: 'test-defect' }]), ['#1030'])
})

// ---------- DEBUG evidence (#1082) ----------

const BASE_DEBUG = {
  issueBody: 'a plain fix issue', labels: [] as string[],
  verdict: 'test-defect', summary: 'the editor autosave reverts the PATCH',
  decision: undefined as unknown, symptoms: undefined as unknown,
  mechanismProof: undefined as unknown,
}

test('checkDebugEvidence accepts a plain test-defect verdict', () => {
  assert.deepEqual(checkDebugEvidence(BASE_DEBUG), [])
})

test('checkDebugEvidence requires the user decision for a non-test-defect verdict', () => {
  const p = checkDebugEvidence({ ...BASE_DEBUG, verdict: 'langflow-regression' })
  assert.equal(p.length, 1)
  assert.match(p[0], /evidence\.decision/)
})

test('checkDebugEvidence demands a pre-fix rate on a flake issue', () => {
  const p = checkDebugEvidence({ ...BASE_DEBUG, issueBody: 'recurrent flake, 3x same signature' })
  assert.equal(p.length, 1)
  assert.match(p[0], /repro-run/)
})

test('checkDebugEvidence accepts a measured flake baseline', () => {
  const reproRate = { spec: 'a.spec.ts', runs: 12, failures: 1, voids: 2, signatures: ['x'], at: 'now' }
  assert.deepEqual(checkDebugEvidence({ ...BASE_DEBUG, issueBody: 'flaky', reproRate }), [])
})

test('checkDebugEvidence wants a mechanism proof when the baseline never reproduced', () => {
  const reproRate = { spec: 'a.spec.ts', runs: 10, failures: 0, voids: 0, signatures: [], at: 'now' }
  const p = checkDebugEvidence({ ...BASE_DEBUG, issueBody: 'flaky', reproRate })
  assert.equal(p.length, 1)
  assert.match(p[0], /mechanismProof/)
  assert.deepEqual(
    checkDebugEvidence({ ...BASE_DEBUG, issueBody: 'flaky', reproRate, mechanismProof: 'request timeline shows the clobber' }),
    [],
  )
})

test('checkDebugEvidence rejects too small a baseline', () => {
  const reproRate = { spec: 'a.spec.ts', runs: 2, failures: 1, voids: 0, signatures: [], at: 'now' }
  const p = checkDebugEvidence({ ...BASE_DEBUG, issueBody: 'flaky', reproRate })
  assert.match(p[0], /at least 5/)
})

// ---------- branch purity + CI verdict (#1082) ----------

test('checkBranchPurity flags a file the pipeline never touched', () => {
  const p = checkBranchPurity(
    ['tests/a.spec.ts', 'scripts/start-langflow-docker.sh'],
    ['tests/a.spec.ts', 'docs/a.md', 'QA-CHECKLIST.md'],
  )
  assert.equal(p.length, 1)
  assert.match(p[0], /start-langflow-docker\.sh/)
})

test('checkBranchPurity fails closed when the base ref is unresolvable', () => {
  assert.equal(checkBranchPurity(null, ['tests/a.spec.ts']).length, 1)
})

test('checkCiVerdict requires a real verdict', () => {
  assert.match(checkCiVerdict({}, [])[0], /ciVerdict/)
  assert.deepEqual(checkCiVerdict({ ciVerdict: 'green' }, []), [])
})

test('checkCiVerdict makes ambient-red carry a justification comment that exists', () => {
  assert.match(checkCiVerdict({ ciVerdict: 'ambient-red' }, [])[0], /justificationCommentUrl/)
  const url = 'https://github.com/o/r/pull/1080#issuecomment-1'
  assert.match(checkCiVerdict({ ciVerdict: 'ambient-red', justificationCommentUrl: url }, [])[0], /not a comment/)
  assert.deepEqual(checkCiVerdict({ ciVerdict: 'ambient-red', justificationCommentUrl: url }, [url]), [])
})

// ---------- branch purity: reasoned additions (#1422) ----------

test('checkBranchPurity excuses declared extra files when a reason is given', () => {
  // A PR grows after IMPLEMENT: the whole-file burst and the force-fails surface
  // defects in surfaces the plan never named, and the IMPLEMENT list cannot be
  // re-declared once the step is complete. #1422 grew a sidebar-click repair and
  // two pipeline fixes that way, both on the user's explicit decision.
  const problems = checkBranchPurity(
    ['tests/a.spec.ts', 'tests/helpers/b.ts'],
    ['tests/a.spec.ts'],
    { extraFiles: ['tests/helpers/b.ts'], extraFilesReason: 'repair surfaced by the burst' },
  )
  assert.deepEqual(problems, [])
})

test('checkBranchPurity still fails an UNDECLARED foreign file', () => {
  // #1060's guard intact: the danger is a file nobody accounts for.
  const problems = checkBranchPurity(
    ['tests/a.spec.ts', 'scripts/someone-elses.mjs'],
    ['tests/a.spec.ts'],
    { extraFiles: ['tests/helpers/b.ts'], extraFilesReason: 'unrelated' },
  )
  assert.equal(problems.length, 2)
  assert.ok(problems.some(p => /someone-elses\.mjs/.test(p)))
  // …and the stale half of the declaration is reported too.
  assert.ok(problems.some(p => /does not change — drop it/.test(p)))
})

test('checkBranchPurity refuses extraFiles with no reason', () => {
  const problems = checkBranchPurity(
    ['tests/a.spec.ts', 'tests/helpers/b.ts'],
    ['tests/a.spec.ts'],
    { extraFiles: ['tests/helpers/b.ts'] },
  )
  assert.ok(problems.some(p => /needs evidence\.extraFilesReason/.test(p)))
  assert.ok(problems.some(p => /never touched: tests\/helpers\/b\.ts/.test(p)))
})

// ---------- final-green coverage, one file at a time (#1593) ----------

const green = (target: string): RunRecord => ({
  target,
  stats: {
    expected: 4, unexpected: 0, flaky: 0, skipped: 0, durationMs: 9000,
    backendErrors: false, backendErrorLines: [], failureMessages: [],
  },
  class: 'clean',
})

const empty = (target: string): RunRecord => ({
  target,
  stats: {
    expected: 0, unexpected: 0, flaky: 0, skipped: 0, durationMs: 120,
    backendErrors: false, backendErrorLines: [], failureMessages: [],
  },
  class: 'no-evidence',
})

test('checkFinalGreenCoverage names every file with no post-revert green run', () => {
  const problems = checkFinalGreenCoverage(
    ['a.spec.ts', 'b.spec.ts', 'c.spec.ts'], [green('a.spec.ts')])
  assert.equal(problems.length, 2)
  assert.match(problems[0], /b\.spec\.ts/)
  assert.match(problems[1], /c\.spec\.ts/)
  // The message has to carry the way out, or a multi-instance issue reads it
  // as "the spec is broken" — which is what forced #1583 off the pipeline.
  assert.match(problems[0], /--spec/)
})

test('checkFinalGreenCoverage closes when every file has its own green run', () => {
  assert.deepEqual(
    checkFinalGreenCoverage(['a.spec.ts', 'b.spec.ts'],
      [green('a.spec.ts'), green('b.spec.ts')]),
    [])
})

test('checkFinalGreenCoverage accumulates across invocations, in any order', () => {
  // The whole point: run A on container 1, run B on container 2, and the
  // records from both invocations close the phase together.
  assert.deepEqual(
    checkFinalGreenCoverage(['a.spec.ts', 'b.spec.ts'],
      [green('b.spec.ts'), empty('a.spec.ts'), green('a.spec.ts')]),
    [])
})

test('checkFinalGreenCoverage refuses a file whose only run executed nothing', () => {
  // The trap: running the @serving specs with PW_SERVING_IDENTITY unset makes
  // the run green and empty. It must not close the phase.
  const problems = checkFinalGreenCoverage(['a.spec.ts'], [empty('a.spec.ts')])
  assert.equal(problems.length, 1)
  assert.match(problems[0], /a\.spec\.ts/)
})

test('checkFinalGreenCoverage is silent on a diff with no spec files', () => {
  assert.deepEqual(checkFinalGreenCoverage([], []), [])
})

test('finalGreenTargets runs only what is still missing a green run', () => {
  const targets = finalGreenTargets(
    ['a.spec.ts', 'b.spec.ts', 'c.spec.ts'], [green('a.spec.ts')])
  assert.deepEqual(targets.targets, ['b.spec.ts', 'c.spec.ts'])
  assert.equal(targets.problem, undefined)
})

test('finalGreenTargets narrows to the one file --spec names', () => {
  // The multi-instance route: point PLAYWRIGHT_BASE_URL at the container this
  // file needs, run just this file, bank it, repeat. Without the narrowing the
  // phase drags every other touched spec onto the wrong instance (#1583).
  const targets = finalGreenTargets(
    ['a.spec.ts', 'b.spec.ts', 'c.spec.ts'], [], 'b.spec.ts')
  assert.deepEqual(targets.targets, ['b.spec.ts'])
})

test('finalGreenTargets refuses a --spec outside the touched files, naming them', () => {
  const targets = finalGreenTargets(['a.spec.ts'], [], 'tests/elsewhere.spec.ts')
  assert.deepEqual(targets.targets, [])
  assert.match(targets.problem!, /tests\/elsewhere\.spec\.ts/)
  assert.match(targets.problem!, /a\.spec\.ts/)
})

test('finalGreenTargets is empty once every file is banked — the phase is done', () => {
  assert.deepEqual(
    finalGreenTargets(['a.spec.ts', 'b.spec.ts'],
      [green('a.spec.ts'), green('b.spec.ts')]).targets,
    [])
})

test('finalGreenTargets re-runs a file whose only record executed nothing', () => {
  // The trap, at the selection layer this time: an empty run must not retire a
  // file from the outstanding list.
  assert.deepEqual(
    finalGreenTargets(['a.spec.ts'], [empty('a.spec.ts')]).targets,
    ['a.spec.ts'])
})

// ---------------------------------------------------------------------------
// resolveClassification — CLASSIFY gate decision (#1302)
// ---------------------------------------------------------------------------

test('resolveClassification records Claude\'s type when the heuristic found none', () => {
  const d = resolveClassification(undefined, { type: 'fix', justification: 'dedicated daily issue' })
  assert.deepEqual(d.problems, [])
  assert.deepEqual(d.set, { type: 'fix', justification: 'dedicated daily issue' })
})

test('resolveClassification OVERRIDES a wrong heuristic and names what it replaced', () => {
  const d = resolveClassification('daily-failure-triage', {
    type: 'fix', justification: '[Daily #1296] is the dedicated title, not the umbrella',
  })
  assert.deepEqual(d.problems, [])
  assert.equal(d.set?.type, 'fix')
  assert.match(d.set!.justification, /overrides heuristic "daily-failure-triage"/)
  assert.match(d.set!.justification, /dedicated title/)
})

test('resolveClassification treats a matching type as a confirmation, rewriting nothing', () => {
  const d = resolveClassification('fix', { type: 'fix', justification: 'agreed' })
  assert.deepEqual(d.problems, [])
  assert.equal(d.set, undefined)
})

test('resolveClassification refuses an unknown type instead of casting it', () => {
  const d = resolveClassification('fix', { type: 'flake-fix', justification: 'typo' })
  assert.equal(d.set, undefined)
  assert.equal(d.problems.length, 1)
  assert.match(d.problems[0], /not a known issue type/)
  assert.match(d.problems[0], /validate-promote/)
})

test('resolveClassification refuses a non-string type', () => {
  const d = resolveClassification(undefined, { type: 7, justification: 'x' })
  assert.equal(d.set, undefined)
  assert.match(d.problems[0], /not a known issue type/)
})

test('resolveClassification requires a non-empty justification, override included', () => {
  for (const justification of [undefined, '', '   ']) {
    const d = resolveClassification('daily-failure-triage', { type: 'fix', justification })
    assert.equal(d.set, undefined, `justification ${JSON.stringify(justification)} must not set a type`)
    assert.deepEqual(d.problems, ['claude classification needs justification'])
  }
})

test('resolveClassification passes a plain confirmation through untouched', () => {
  const d = resolveClassification('new-spec', { confirmed: true } as Record<string, unknown>)
  assert.deepEqual(d.problems, [])
  assert.equal(d.set, undefined)
})

test('resolveClassification still fails when no heuristic ran and nothing was supplied', () => {
  const d = resolveClassification(undefined, {})
  assert.equal(d.set, undefined)
  assert.deepEqual(d.problems, ['no type: heuristic failed and none supplied'])
})

// ---------- Regression Ledger ----------
//
// `REGRESSIONS.md` calls the row "a mandatory step" and names the pipeline
// REPORT phase as one of its two owners, but nothing read the DEBUG verdict for
// it. The gap cost two rows: #1777/LE-2598 reached a PR without one, and
// #1759/LE-2552 still has none.

const LEDGER_MD = `# Regression Ledger

<!-- REGRESSIONS:START -->
**Regressions caught:** 2
<!-- REGRESSIONS:END -->

## Ledger

| Found | Area / Test | Regression | Severity | Detected by | Upstream | Status | Fixed in | Report |
|-------|-------------|------------|----------|-------------|----------|--------|----------|--------|
| 2026-09-09 | api · api-flows-versions.spec.ts | The 2xx precedes the commit. Route-agnostic: DELETE /flows/{id} answers 404 (#1759, \`LE-2552\`'s sibling symptom) | Medium | daily 09-09 · #1776 → #1777 | [LE-2598](https://datastax.jira.com/browse/LE-2598) | Open | — | #1777 |
| 2026-07-24 | mcp · mcp-server-resources.spec.ts | resources/read crashes | Medium | #948 spec validation | [langflow#14253](https://github.com/langflow-ai/langflow/pull/14253) | Fixed | — | #948 |

## Candidates — pending upstream ticket

| Found | Area / Test | Regression | Severity | Report |
|-------|-------------|------------|----------|--------|
| 2026-08-21 | security · credential-secret-exposure.spec.ts | export nulls load_from_db bindings | Medium | [#1546](https://github.com/oriontech-me/langflow-e2e/issues/1546) |

## Not listed — validated non-regression

- nothing to see here
`

test('the ledger gate is silent for every verdict that is not a product defect', () => {
  for (const verdict of [
    'test-defect', 'product-changed', 'transient-saturation',
    'cross-worker-wiper', 'stale-confirmed-bug', undefined,
  ]) {
    // No ledger row anywhere, no ticket: still silent — the gate keys on the
    // verdict alone, so it cannot redden an issue that found no regression.
    assert.deepEqual(
      checkRegressionLedger({ verdict, issue: 1759, ledger: LEDGER_MD }), [],
      `verdict ${String(verdict)} must not arm the ledger gate`)
  }
})

test('a product defect whose ticket has a Ledger row passes', () => {
  assert.deepEqual(checkRegressionLedger({
    verdict: REGRESSION, issue: 1777, upstreamTicket: 'LE-2598', ledger: LEDGER_MD,
  }), [])
})

test('a product defect with NO row fails, naming the file and the ticket (#1759)', () => {
  const problems = checkRegressionLedger({
    verdict: REGRESSION, issue: 1759, upstreamTicket: 'LE-2552', ledger: LEDGER_MD,
  })
  assert.equal(problems.length, 1)
  assert.match(problems[0], new RegExp(LEDGER_FILE))
  assert.match(problems[0], /LE-2552/)
  assert.match(problems[0], /#1759/)
  assert.match(problems[0], /regressions:summary/)
})

// The trap that makes cell-scoping load-bearing rather than tidy: LE-2552 IS a
// substring of the real ledger — quoted in the #1777 row's PROSE as "LE-2552's
// sibling symptom". A whole-row search reports #1759's missing row as present,
// i.e. it passes the one case the gate exists for.
test('a ticket named only in a description cell does NOT count as a row', () => {
  assert.match(LEDGER_MD, /LE-2552/, 'fixture must quote the ticket in prose')
  const problems = checkRegressionLedger({
    verdict: REGRESSION, issue: 1759, upstreamTicket: 'LE-2552', ledger: LEDGER_MD,
  })
  assert.equal(problems.length, 1)
})

test('a product defect whose row carries a DIFFERENT ticket fails', () => {
  const problems = checkRegressionLedger({
    verdict: REGRESSION, issue: 1780, upstreamTicket: 'LE-9999', ledger: LEDGER_MD,
  })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /LE-9999/)
  assert.doesNotMatch(problems[0], /LE-2598/)
})

test('an upstream GitHub ticket matches its Ledger row, and a bare number does not', () => {
  for (const ticket of [
    'langflow#14253',
    'langflow-ai/langflow#14253',
    'https://github.com/langflow-ai/langflow/pull/14253',
    'https://github.com/langflow-ai/langflow/issues/14253',
  ]) {
    assert.deepEqual(checkRegressionLedger({
      verdict: REGRESSION, issue: 948, upstreamTicket: ticket, ledger: LEDGER_MD,
    }), [], `${ticket} should resolve to the langflow#14253 row`)
  }
  // A bare "#14253" is ambiguous — this repo writes that spelling for its own
  // issues — so it is refused rather than resolved.
  const problems = checkRegressionLedger({
    verdict: REGRESSION, issue: 948, upstreamTicket: '#14253', ledger: LEDGER_MD,
  })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /ambiguous/i)
})

test('no ticket yet: a Candidates entry naming the issue satisfies the gate', () => {
  assert.deepEqual(checkRegressionLedger({
    verdict: REGRESSION, issue: 1546, ledger: LEDGER_MD,
  }), [])
})

test('no ticket and no Candidates entry fails, pointing at both routes', () => {
  const problems = checkRegressionLedger({
    verdict: REGRESSION, issue: 1759, ledger: LEDGER_MD,
  })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /Candidates/)
  assert.match(problems[0], /#1759/)
  assert.match(problems[0], /upstreamTicket/)
})

test('a filed ticket does not stay a candidate — the gate asks for a promotion', () => {
  const problems = checkRegressionLedger({
    verdict: REGRESSION, issue: 1546, upstreamTicket: 'LE-2300', ledger: LEDGER_MD,
  })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /PROMOTED|promote/i)
  assert.match(problems[0], /LE-2300/)
})

test('the ledger gate fails closed on inputs it cannot read', () => {
  const unreadable = checkRegressionLedger({
    verdict: REGRESSION, issue: 1759, upstreamTicket: 'LE-2552', ledger: null,
  })
  assert.equal(unreadable.length, 1)
  assert.match(unreadable[0], /could not read/)

  // A file with no `## Ledger` section must not read as "no rows, nothing owed".
  const noSection = checkRegressionLedger({
    verdict: REGRESSION, issue: 1759, upstreamTicket: 'LE-2552',
    ledger: '# Regression Ledger\n\nprose only\n',
  })
  assert.equal(noSection.length, 1)
  assert.match(noSection[0], /## Ledger/)

  // A typo must not silently degrade to the weaker Candidates branch.
  for (const bad of ['LE2552', 'the jira one', '', 42, { id: 'LE-2552' }]) {
    const problems = checkRegressionLedger({
      verdict: REGRESSION, issue: 1546, upstreamTicket: bad, ledger: LEDGER_MD,
    })
    assert.equal(problems.length, 1, `${JSON.stringify(bad)} must be refused`)
    assert.match(problems[0], /upstreamTicket/)
  }
})

test('normalizeUpstreamTicket accepts both ticket families and only those', () => {
  assert.deepEqual(normalizeUpstreamTicket(undefined), {})
  assert.deepEqual(normalizeUpstreamTicket(null), {})
  assert.equal(normalizeUpstreamTicket('le-2552').ref?.id, 'LE-2552')
  assert.equal(
    normalizeUpstreamTicket('https://datastax.jira.com/browse/LE-2552').ref?.id, 'LE-2552')
  assert.equal(normalizeUpstreamTicket('langflow#14741').ref?.label, 'langflow#14741')
  assert.equal(normalizeUpstreamTicket('nonsense').ref, undefined)
  assert.match(String(normalizeUpstreamTicket('nonsense').problem), /LE-2552|langflow#/)
})
