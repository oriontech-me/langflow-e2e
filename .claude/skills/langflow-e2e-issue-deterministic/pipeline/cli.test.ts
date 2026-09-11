import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { parseArgs, sanitizeEvidence, releaseCycleOf, allowedBranchFiles } from './cli.ts'

const CLI_SRC = fs.readFileSync(new URL('./cli.ts', import.meta.url), 'utf8')

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
    'docs/a.md', 'tests/a.spec.ts', 'tests/helpers/h.ts',
    'QA-CHECKLIST.md', 'REGRESSIONS.md',
  ])
})

// Both bookkeeping files are allowed unconditionally because the pipeline's own
// gates REQUIRE edits to them that SPECIFY/IMPLEMENT never list. Dropping
// REGRESSIONS.md puts checkRegressionLedger and checkBranchPurity in direct
// contradiction: one demands the ledger row, the other rejects the file
// carrying it, and a langflow-regression issue could then never close its PR.
test('allowedBranchFiles allows the checklist and the ledger on a bare state', () => {
  assert.deepEqual(
    allowedBranchFiles({ steps: {} } as never), ['QA-CHECKLIST.md', 'REGRESSIONS.md'])
})

// Structural, and it pins an ABSENCE rather than a spelling (#1226's lesson):
// the ledger decision must live in gates.ts and be CALLED from the phase block,
// never re-spelled there. Two ways this gate dies — nobody wires the pure
// function (which is the whole shape of the defect it was added for: the
// REGRESSIONS.md rule existed, documented and mandatory, with no reader), and a
// second copy of the verdict policy drifts from the first (#1045's shape). So:
// the call exists, and the phase block quotes no verdict of its own.
test('the PR gate calls the ledger gate and spells no verdict policy itself', () => {
  assert.match(CLI_SRC, /checkRegressionLedger\(\{/)
  assert.match(CLI_SRC, /ledger: readRepoFile\(LEDGER_FILE\)/)
  for (const quoted of ["'langflow-regression'", '"langflow-regression"']) {
    assert.ok(!CLI_SRC.includes(quoted),
      `cli.ts must not re-spell the verdict (${quoted}) — the policy belongs in gates.ts`)
  }
})
