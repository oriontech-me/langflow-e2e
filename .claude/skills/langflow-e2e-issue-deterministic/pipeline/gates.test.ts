import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  checkSpecDoc, checkQaDiff, checkForceFailCoverage,
  checkNoMutationMarkers, checkPrReadiness, BRANCH_RE,
  checkQuarantineLifted, extractSymptomRows, checkSymptomCoverage,
  symptomsOwnedElsewhere, checkDebugEvidence, checkBranchPurity, checkCiVerdict,
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
