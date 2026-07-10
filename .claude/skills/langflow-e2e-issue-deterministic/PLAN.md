# langflow-e2e-issue-deterministic Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the deterministic TypeScript state-machine CLI + thin SKILL.md driver specified in `DESIGN.md` (same directory), so issue resolution order/gates/evidence are enforced by code.

**Architecture:** A `pipeline/` CLI (run via `npx tsx`) persists one JSON state file per issue under `.claude/issue-pipeline/`. `next` validates state, runs mechanical work, emits the exact next instruction; `complete` verifies evidence through gates and advances the phase. Claude (driven by SKILL.md) only does judgment work inside steps.

**Tech Stack:** TypeScript executed by `npx tsx` (no build), `node:test` for unit tests, `spawnSync` wrappers over `gh` / `npx playwright` / `npm run` / `git`, global `fetch` for version checks.

## Global Constraints

- Everything lives under `/Users/rafael/Documents/langflow-e2e/.claude/skills/langflow-e2e-issue-deterministic/` (plus run state in `.claude/issue-pipeline/`). **Git-ignored: NO git commits in this plan** — each task ends with tests/verification instead.
- All file content in English (repo rule). SKILL.md instructs PT-BR only for talking to the user.
- Never reference these files from any tracked file.
- Repo: `oriontech-me/langflow-e2e`. CLI assumes cwd = repo root.
- State schema `version: 1`; additive changes need no bump (repo `reports/README.md` convention).
- Tests: `npx tsx --test .claude/skills/langflow-e2e-issue-deterministic/pipeline/*.test.ts` (run from repo root).
- Evidence keys written by runners (`runs`, `typecheck`, `lint`, `nightly`, `qaDiff`, `ff`) are RESERVED: `complete --evidence-json` must ignore them if user-supplied (anti-fabrication).
- Force-fail mutations must carry the marker comment `// FF-MUTATION` (detection convention).

## File Structure

```
.claude/skills/langflow-e2e-issue-deterministic/
├── SKILL.md                  # Task 8
├── DESIGN.md                 # exists
├── PLAN.md                   # this file
└── pipeline/
    ├── tsconfig.json         # Task 1
    ├── types.ts              # Task 1 — shared types
    ├── state.ts              # Task 1 (persistence) + Task 2 (transitions)
    ├── state.test.ts         # Tasks 1–2
    ├── classify.ts           # Task 3
    ├── classify.test.ts      # Task 3
    ├── runners.ts            # Task 4 — sh/gh/git/npm/playwright/fetch wrappers + pure parsers
    ├── runners.test.ts       # Task 4 (pure parts only)
    ├── gates.ts              # Task 5
    ├── gates.test.ts         # Task 5
    ├── instructions.ts       # Task 6 — per-phase instruction text
    ├── instructions.test.ts  # Task 6
    ├── cli.ts                # Task 7 — command dispatch
    └── cli.test.ts           # Task 7 (pure helpers)
```

---

### Task 1: Scaffold, types, state persistence

**Files:**
- Create: `pipeline/tsconfig.json`, `pipeline/types.ts`, `pipeline/state.ts`, `pipeline/state.test.ts`

**Interfaces:**
- Produces: `types.ts` exports `Phase`, `IssueType`, `StepRecord`, `PipelineState`, `IssueData`, `FFEntry`, `PwStats`. `state.ts` exports `stateDir()`, `statePath(issue)`, `loadState(issue)`, `saveState(state)`, `initState(issue, repo)`, `ensureStep(state, phase)`, `now()`.
- Consumes: nothing.

- [ ] **Step 1: Write `pipeline/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "strict": true,
    "types": ["node"]
  },
  "include": ["*.ts"]
}
```

- [ ] **Step 2: Write `pipeline/types.ts`**

```ts
export type IssueType =
  | 'new-spec'
  | 'validate-promote'
  | 'daily-failure-triage'
  | 'fix'
  | 'community'
  | 'file-watcher'

export type Phase =
  | 'INTAKE' | 'CLASSIFY' | 'SPECIFY' | 'PLAN' | 'DEBUG' | 'IMPLEMENT'
  | 'VALIDATE' | 'FORCE_FAIL' | 'REPORT' | 'AWAIT_PR_AUTH' | 'PR'
  | 'DISPATCH' | 'DISPATCHED' | 'DONE' | 'ABORTED'

export interface StepRecord {
  startedAt: string
  completedAt?: string
  attempts: number
  evidence: Record<string, unknown>
}

export interface IssueData {
  title: string
  body: string
  labels: string[]
  milestone: string | null
  state: string
  bodyFormat: 'A' | 'B' | 'unknown'
}

export interface FFEntry {
  file: string
  test: string
  mutation: string
  unexpected: number
  at: string
}

export interface PwStats {
  expected: number
  unexpected: number
  flaky: number
  skipped: number
  durationMs: number
  backendErrors: boolean
}

export interface PipelineState {
  version: 1
  issue: number
  repo: string
  phase: Phase
  parkedPhase?: Phase
  type?: IssueType
  branch?: string
  startedAt: string
  finishedAt?: string
  steps: Partial<Record<Phase, StepRecord>>
  classification?: { by: 'heuristic' | 'claude'; justification: string }
  issueData?: IssueData
  prAuth?: { quote: string; at: string }
  abortReason?: string
}
```

- [ ] **Step 3: Write the failing tests in `pipeline/state.test.ts`**

```ts
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { initState, saveState, loadState, statePath, ensureStep } from './state.ts'

beforeEach(() => {
  process.env.PIPELINE_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pipe-'))
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
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `npx tsx --test .claude/skills/langflow-e2e-issue-deterministic/pipeline/state.test.ts`
Expected: FAIL — cannot find module `./state.ts`.

- [ ] **Step 5: Write `pipeline/state.ts` (persistence half)**

```ts
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Phase, PipelineState, StepRecord } from './types.ts'

export function now(): string {
  return new Date().toISOString()
}

export function stateDir(): string {
  return process.env.PIPELINE_STATE_DIR
    ?? path.join(process.cwd(), '.claude', 'issue-pipeline')
}

export function statePath(issue: number): string {
  return path.join(stateDir(), `issue-${issue}.json`)
}

export function loadState(issue: number): PipelineState | null {
  const p = statePath(issue)
  if (!fs.existsSync(p)) return null
  const s = JSON.parse(fs.readFileSync(p, 'utf8')) as PipelineState
  if (s.version !== 1) throw new Error(`unsupported state version ${s.version} in ${p}`)
  return s
}

export function saveState(s: PipelineState): void {
  fs.mkdirSync(stateDir(), { recursive: true })
  fs.writeFileSync(statePath(s.issue), JSON.stringify(s, null, 2) + '\n')
}

export function initState(issue: number, repo: string): PipelineState {
  return { version: 1, issue, repo, phase: 'INTAKE', startedAt: now(), steps: {} }
}

export function ensureStep(s: PipelineState, phase: Phase): StepRecord {
  const rec = s.steps[phase] ?? { startedAt: now(), attempts: 0, evidence: {} }
  s.steps[phase] = rec
  return rec
}

export function listStates(): PipelineState[] {
  if (!fs.existsSync(stateDir())) return []
  return fs.readdirSync(stateDir())
    .filter(f => /^issue-\d+\.json$/.test(f))
    .map(f => JSON.parse(fs.readFileSync(path.join(stateDir(), f), 'utf8')) as PipelineState)
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx tsx --test .claude/skills/langflow-e2e-issue-deterministic/pipeline/state.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 7: Typecheck**

Run: `npx tsc --noEmit -p .claude/skills/langflow-e2e-issue-deterministic/pipeline/tsconfig.json`
Expected: exit 0. (If `types: ["node"]` errors because `@types/node` isn't in scope, remove that line — repo devDeps usually provide it.)

---

### Task 2: State machine — spines, completion, escalation, metrics

**Files:**
- Modify: `pipeline/state.ts`
- Test: `pipeline/state.test.ts` (append)

**Interfaces:**
- Consumes: Task 1 types and helpers.
- Produces: `spineFor(type?: IssueType): Phase[]`, `completeStep(s, step, evidence): void`, `escalateToDebug(s, reason): void`, `setType(s, type, by, justification): void`, `abortState(s, reason): void`, `metricsOf(s): { issue: number; type?: string; finished: boolean; totalMs: number | null; steps: Array<{ phase: string; ms: number | null; attempts: number }> }`.
- Behavior contracts: `completeStep` throws on wrong step naming the expected one; DEBUG completion requires `evidence.verdict`, and any verdict other than `'test-defect'` also requires `evidence.decision`; escalated DEBUG resumes `parkedPhase`; terminal phases are `DONE`, `DISPATCHED`, `ABORTED`.

- [ ] **Step 1: Append failing tests to `pipeline/state.test.ts`**

```ts
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
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npx tsx --test .claude/skills/langflow-e2e-issue-deterministic/pipeline/state.test.ts`
Expected: FAIL — `spineFor` etc. not exported.

- [ ] **Step 3: Append the state-machine half to `pipeline/state.ts`**

```ts
import type { IssueType } from './types.ts'

const BASE: Phase[] = [
  'INTAKE', 'CLASSIFY', 'SPECIFY', 'PLAN', 'IMPLEMENT', 'VALIDATE',
  'FORCE_FAIL', 'REPORT', 'AWAIT_PR_AUTH', 'PR', 'DONE',
]

export function spineFor(type?: IssueType): Phase[] {
  if (!type) return ['INTAKE', 'CLASSIFY']
  if (type === 'daily-failure-triage') return ['INTAKE', 'CLASSIFY', 'DISPATCH', 'DISPATCHED']
  if (type === 'fix') {
    const spine = [...BASE]
    spine.splice(spine.indexOf('IMPLEMENT'), 0, 'DEBUG')
    return spine
  }
  return BASE
}

export const TERMINAL: Phase[] = ['DONE', 'DISPATCHED', 'ABORTED']

function advance(s: PipelineState): void {
  const spine = spineFor(s.type)
  const i = spine.indexOf(s.phase)
  if (i < 0) throw new Error(`phase ${s.phase} not in spine for type ${s.type}`)
  s.phase = spine[Math.min(i + 1, spine.length - 1)]
  if (TERMINAL.includes(s.phase)) s.finishedAt = now()
}

export function setType(
  s: PipelineState, type: IssueType,
  by: 'heuristic' | 'claude', justification: string,
): void {
  s.type = type
  s.classification = { by, justification }
}

export function completeStep(
  s: PipelineState, step: Phase, evidence: Record<string, unknown>,
): void {
  if (TERMINAL.includes(s.phase)) throw new Error(`pipeline already ${s.phase}`)
  if (step !== s.phase) throw new Error(`expected "${s.phase}", got "${step}"`)
  if (step === 'DEBUG') {
    const v = evidence.verdict
    if (typeof v !== 'string') throw new Error('DEBUG completion requires evidence.verdict')
    if (v !== 'test-defect' && typeof evidence.decision !== 'string') {
      throw new Error(`verdict "${v}" requires evidence.decision — the user's explicit call`)
    }
  }
  const rec = ensureStep(s, step)
  Object.assign(rec.evidence, evidence)
  rec.completedAt = now()
  if (step === 'DEBUG' && s.parkedPhase) {
    s.phase = s.parkedPhase
    delete s.parkedPhase
    return
  }
  advance(s)
}

export function escalateToDebug(s: PipelineState, reason: string): void {
  if (s.phase === 'DEBUG') throw new Error('already in DEBUG')
  if (TERMINAL.includes(s.phase)) throw new Error(`pipeline already ${s.phase}`)
  s.parkedPhase = s.phase
  s.phase = 'DEBUG'
  const rec = ensureStep(s, 'DEBUG')
  rec.evidence.reason = reason
}

export function abortState(s: PipelineState, reason: string): void {
  s.phase = 'ABORTED'
  s.abortReason = reason
  s.finishedAt = now()
}

export function metricsOf(s: PipelineState) {
  const steps = (Object.keys(s.steps) as Phase[]).map(phase => {
    const r = s.steps[phase]!
    const ms = r.completedAt ? Date.parse(r.completedAt) - Date.parse(r.startedAt) : null
    return { phase: phase as string, ms, attempts: r.attempts }
  })
  const totalMs = s.finishedAt ? Date.parse(s.finishedAt) - Date.parse(s.startedAt) : null
  return { issue: s.issue, type: s.type as string | undefined, finished: !!s.finishedAt, totalMs, steps }
}
```

Note: `DEBUG` inside the fix spine has no `parkedPhase`, so `advance` runs and moves to `IMPLEMENT` — exactly what the fix-spine test expects.

- [ ] **Step 4: Run tests to verify all pass**

Run: `npx tsx --test .claude/skills/langflow-e2e-issue-deterministic/pipeline/state.test.ts`
Expected: PASS (16 tests).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit -p .claude/skills/langflow-e2e-issue-deterministic/pipeline/tsconfig.json`
Expected: exit 0.

---

### Task 3: Deterministic classification

**Files:**
- Create: `pipeline/classify.ts`, `pipeline/classify.test.ts`

**Interfaces:**
- Consumes: `IssueType` from `types.ts`.
- Produces: `classify(i: { title: string; labels: string[]; body: string }): { type: IssueType | null; reason: string }` and `detectBodyFormat(body: string): 'A' | 'B' | 'unknown'`.

- [ ] **Step 1: Write failing tests in `pipeline/classify.test.ts`**

```ts
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
```

- [ ] **Step 2: Run to verify failure**

Run: `npx tsx --test .claude/skills/langflow-e2e-issue-deterministic/pipeline/classify.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `pipeline/classify.ts`**

```ts
import type { IssueType } from './types.ts'

export interface ClassifyInput { title: string; labels: string[]; body: string }

export function classify(i: ClassifyInput): { type: IssueType | null; reason: string } {
  const hay = (i.title + '\n' + i.body).toLowerCase()
  const title = i.title.toLowerCase()
  const labels = i.labels.map(l => l.toLowerCase())

  if (labels.includes('daily-failure')) {
    if (/triage/.test(hay)) {
      return { type: 'daily-failure-triage', reason: 'label daily-failure + "triage" wording' }
    }
    return { type: 'fix', reason: 'label daily-failure, dedicated issue (no "triage" wording)' }
  }
  if (labels.includes('community')) {
    return { type: 'community', reason: 'label community' }
  }
  if (/file[- ]?watcher/.test(hay)) {
    return { type: 'file-watcher', reason: '"file-watcher" in title/body' }
  }
  if (/validate\s*&\s*promote/.test(title) || /promote\b.*stable/.test(title)) {
    return { type: 'validate-promote', reason: 'promote wording in title' }
  }
  if (labels.includes('test-automation') || /create\b.*\.spec\.ts/.test(title)) {
    return { type: 'new-spec', reason: 'test-automation label or "Create *.spec.ts" title' }
  }
  return { type: null, reason: 'no heuristic matched — Claude must classify with justification' }
}

export function detectBodyFormat(body: string): 'A' | 'B' | 'unknown' {
  if (/what to test/i.test(body)) return 'B'
  if (/done when/i.test(body) || /spec file/i.test(body)) return 'A'
  return 'unknown'
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx tsx --test .claude/skills/langflow-e2e-issue-deterministic/pipeline/classify.test.ts`
Expected: PASS (11 tests).

---

### Task 4: Runners — pure parsers (tested) + subprocess/fetch wrappers (thin)

**Files:**
- Create: `pipeline/runners.ts`, `pipeline/runners.test.ts`

**Interfaces:**
- Consumes: `PwStats` from `types.ts`.
- Produces (pure, tested): `parsePwJson(raw: string): PwStats | null`, `enumerateTests(source: string): string[]`.
- Produces (wrappers, untested — failures surface as recorded attempts):
  `sh(cmd: string, args: string[]): { code: number; stdout: string; stderr: string }`,
  `ghIssueView(repo: string, issue: number): { title: string; body: string; labels: string[]; milestone: string | null; state: string }`,
  `ghAssignSelf(repo: string, issue: number): void`,
  `runPlaywright(args: string[]): { stats: PwStats | null; code: number; raw: string }`,
  `npmRun(script: 'typecheck' | 'lint'): { code: number; tail: string }`,
  `gitCurrentBranch(): string`, `gitDiffNames(): string[]`, `gitDiffOf(path: string): string`,
  `getInstanceVersion(baseUrl: string): Promise<string | null>`,
  `getLatestNightlyTag(): Promise<string | null>`.

- [ ] **Step 1: Write failing tests in `pipeline/runners.test.ts`**

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parsePwJson, enumerateTests } from './runners.ts'

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
```

Note: `test.skip(...)` is excluded on purpose — skipped tests need no force-fail. `test.fixme`/`test.fail`/`test.only` count.

- [ ] **Step 2: Run to verify failure**

Run: `npx tsx --test .claude/skills/langflow-e2e-issue-deterministic/pipeline/runners.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `pipeline/runners.ts`**

```ts
import { spawnSync } from 'node:child_process'
import type { PwStats } from './types.ts'

// ---------- pure, unit-tested ----------

export function parsePwJson(raw: string): PwStats | null {
  const start = raw.indexOf('{"')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let data: { stats?: Record<string, number> }
  try { data = JSON.parse(raw.slice(start, end + 1)) } catch { return null }
  const s = data.stats
  if (!s) return null
  return {
    expected: s.expected ?? 0,
    unexpected: s.unexpected ?? 0,
    flaky: s.flaky ?? 0,
    skipped: s.skipped ?? 0,
    durationMs: Math.round(s.duration ?? 0),
    backendErrors: raw.includes('🚨 Backend Error'),
  }
}

const TEST_RE = /(?<![\w.$])test(?:\.only|\.fixme|\.fail)?\s*\(\s*(['"`])([\s\S]*?)\1\s*,/g

export function enumerateTests(source: string): string[] {
  return [...source.matchAll(TEST_RE)].map(m => m[2])
}

// ---------- subprocess wrappers (thin; not unit-tested) ----------

export function sh(cmd: string, args: string[]): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

export function ghIssueView(repo: string, issue: number) {
  const r = sh('gh', ['issue', 'view', String(issue), '--repo', repo,
    '--json', 'title,body,labels,milestone,state'])
  if (r.code !== 0) throw new Error(`gh issue view failed: ${r.stderr}`)
  const j = JSON.parse(r.stdout)
  return {
    title: j.title as string,
    body: (j.body ?? '') as string,
    labels: (j.labels ?? []).map((l: { name: string }) => l.name) as string[],
    milestone: (j.milestone?.title ?? null) as string | null,
    state: j.state as string,
  }
}

export function ghAssignSelf(repo: string, issue: number): void {
  const r = sh('gh', ['issue', 'edit', String(issue), '--repo', repo, '--add-assignee', '@me'])
  if (r.code !== 0) throw new Error(`gh assign failed: ${r.stderr}`)
}

export function runPlaywright(args: string[]): { stats: PwStats | null; code: number; raw: string } {
  const r = sh('npx', ['playwright', 'test', ...args, '--reporter=json'])
  const raw = r.stdout + '\n' + r.stderr
  return { stats: parsePwJson(raw), code: r.code, raw }
}

export function npmRun(script: 'typecheck' | 'lint'): { code: number; tail: string } {
  const r = sh('npm', ['run', script])
  const out = (r.stdout + r.stderr).split('\n')
  return { code: r.code, tail: out.slice(-15).join('\n') }
}

export function gitCurrentBranch(): string {
  return sh('git', ['branch', '--show-current']).stdout.trim()
}

export function gitDiffNames(): string[] {
  const r = sh('git', ['diff', '--name-only', 'HEAD'])
  return r.stdout.split('\n').filter(Boolean)
}

export function gitDiffOf(path: string): string {
  return sh('git', ['diff', 'HEAD', '--', path]).stdout
}

// ---------- fetch-based version checks ----------

export async function getInstanceVersion(baseUrl: string): Promise<string | null> {
  try {
    const res = await fetch(new URL('/api/v1/version', baseUrl))
    if (!res.ok) return null
    const j = await res.json() as { version?: string }
    return j.version ?? null
  } catch { return null }
}

export async function getLatestNightlyTag(): Promise<string | null> {
  try {
    const res = await fetch(
      'https://hub.docker.com/v2/repositories/langflowai/langflow-nightly/tags?page_size=5&ordering=last_updated')
    if (!res.ok) return null
    const j = await res.json() as { results?: Array<{ name: string }> }
    const named = (j.results ?? []).map(t => t.name).filter(n => n !== 'latest')
    return named[0] ?? null
  } catch { return null }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx tsx --test .claude/skills/langflow-e2e-issue-deterministic/pipeline/runners.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: One-shot manual smoke of the wrappers (read-only)**

Run: `npx tsx -e "import('./.claude/skills/langflow-e2e-issue-deterministic/pipeline/runners.ts').then(async r => { console.log(r.ghIssueView('oriontech-me/langflow-e2e', 493).title); console.log(await r.getLatestNightlyTag()) })"`
Expected: prints issue 493's real title and a nightly tag string. (Requires `gh` auth + network; if offline, note it and move on — wrappers are exercised again in Task 7's smoke.)

---

### Task 5: Gates — evidence verifiers

**Files:**
- Create: `pipeline/gates.ts`, `pipeline/gates.test.ts`

**Interfaces:**
- Consumes: `FFEntry` from `types.ts`.
- Produces (all pure; return `string[]` of problems, empty = pass):
  `checkSpecDoc(content: string, releaseCycle: string): string[]`,
  `checkQaDiff(diff: string): string[]`,
  `checkForceFailCoverage(required: Array<{ file: string; titles: string[] }>, ff: FFEntry[]): string[]`,
  `checkNoMutationMarkers(diffs: Array<{ file: string; diff: string }>): string[]`,
  `checkPrReadiness(e: { branch: string; prBody: string; issue: number; isWave: boolean; labels: string[] }): string[]`,
  and `BRANCH_RE`.

- [ ] **Step 1: Write failing tests in `pipeline/gates.test.ts`**

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  checkSpecDoc, checkQaDiff, checkForceFailCoverage,
  checkNoMutationMarkers, checkPrReadiness, BRANCH_RE,
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
```

- [ ] **Step 2: Run to verify failure**

Run: `npx tsx --test .claude/skills/langflow-e2e-issue-deterministic/pipeline/gates.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `pipeline/gates.ts`**

```ts
import type { FFEntry } from './types.ts'

export const SPEC_DOC_SECTIONS = [
  'What this test validates', 'Tags', 'Validation criterion', 'External dependencies',
]

export function checkSpecDoc(content: string, releaseCycle: string): string[] {
  const problems = SPEC_DOC_SECTIONS
    .filter(s => !content.includes(s))
    .map(s => `spec doc missing mandatory section "${s}"`)
  const lv = content.match(/Last validated[:\s*]+([\d.]+)/i)
  if (!lv) problems.push('spec doc missing "Last validated" field')
  else if (!lv[1].startsWith(releaseCycle)) {
    problems.push(`"Last validated" is ${lv[1]}, expected current cycle ${releaseCycle}.x`)
  }
  return problems
}

export function checkQaDiff(diff: string): string[] {
  const problems: string[] = []
  for (const line of diff.split('\n')) {
    if (!/^[+-]/.test(line) || /^(\+\+\+|---)/.test(line)) continue
    const content = line.slice(1)
    if (/^\s*\|/.test(content)) {
      problems.push(`generated Coverage Summary table touched: "${line.trim()}"`)
    } else if (/Phase 0 — Validated/.test(content)) {
      problems.push('generated "Phase 0 — Validated" block touched')
    } else if (content.trim() === '' || /^\s*- \[/.test(content) || /^\s{2,}\S/.test(content)) {
      // ok: blank, checklist bullet, or indented continuation of a bullet
    } else {
      problems.push(`non-bullet top-level line changed: "${line.trim()}"`)
    }
  }
  return problems
}

export function checkForceFailCoverage(
  required: Array<{ file: string; titles: string[] }>, ff: FFEntry[],
): string[] {
  const problems: string[] = []
  for (const { file, titles } of required) {
    for (const title of titles) {
      const hit = ff.find(e => e.file === file && e.test === title && e.unexpected > 0)
      if (!hit) problems.push(`no verified force-fail for test "${title}" in ${file}`)
    }
  }
  return problems
}

export function checkNoMutationMarkers(diffs: Array<{ file: string; diff: string }>): string[] {
  return diffs
    .filter(d => d.diff.includes('FF-MUTATION'))
    .map(d => `FF-MUTATION marker still present in working diff of ${d.file} — revert incomplete`)
}

export const BRANCH_RE = /^(test|fix|docs|chore|feat|refactor)\/issue-\d+-[a-z0-9][a-z0-9-]*$/

export function checkPrReadiness(e: {
  branch: string; prBody: string; issue: number; isWave: boolean; labels: string[]
}): string[] {
  const problems: string[] = []
  if (!BRANCH_RE.test(e.branch)) {
    problems.push(`branch "${e.branch}" does not match type/issue-NNN-desc`)
  }
  if (!new RegExp(`Closes #${e.issue}\\b`).test(e.prBody)) {
    problems.push(`PR body missing "Closes #${e.issue}"`)
  }
  if (e.isWave && !e.labels.includes('roadmap')) {
    problems.push('wave issue without roadmap label')
  }
  return problems
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx tsx --test .claude/skills/langflow-e2e-issue-deterministic/pipeline/gates.test.ts`
Expected: PASS (11 tests).

---

### Task 6: Instruction emitters

**Files:**
- Create: `pipeline/instructions.ts`, `pipeline/instructions.test.ts`

**Interfaces:**
- Consumes: `PipelineState`, `IssueData` from `types.ts`.
- Produces: `instructionFor(state: PipelineState, extra?: Record<string, unknown>): string` — the English text `next` prints. Instructions POINT to companion skills; they never restate their content (design rule).

- [ ] **Step 1: Write failing tests in `pipeline/instructions.test.ts`**

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { instructionFor } from './instructions.ts'
import { initState, setType } from './state.ts'

function stateAt(phase: string, type?: string) {
  const s = initState(493, 'oriontech-me/langflow-e2e')
  if (type) setType(s, type as never, 'heuristic', 'x')
  s.phase = phase as never
  s.issueData = {
    title: 'Create agent-tools.spec.ts', body: '**Done when**: merged',
    labels: ['roadmap'], milestone: 'Wave 1 — Agents & providers',
    state: 'OPEN', bodyFormat: 'A',
  }
  return s
}

test('SPECIFY instruction points to langflow-e2e skill and format-A criterion rule', () => {
  const text = instructionFor(stateAt('SPECIFY', 'new-spec'))
  assert.match(text, /langflow-e2e/)
  assert.match(text, /Validation criterion/)
  assert.match(text, /complete 493 SPECIFY/)
})

test('SPECIFY for validate-promote asks for locate + force-failability audit', () => {
  const text = instructionFor(stateAt('SPECIFY', 'validate-promote'))
  assert.match(text, /force-fail/i)
  assert.match(text, /existing spec/i)
})

test('DEBUG instruction points to systematic-debugging and verdict taxonomy', () => {
  const text = instructionFor(stateAt('DEBUG', 'fix'))
  assert.match(text, /systematic-debugging/)
  assert.match(text, /verdict/)
})

test('AWAIT_PR_AUTH instruction says report and WAIT', () => {
  const text = instructionFor(stateAt('AWAIT_PR_AUTH', 'new-spec'))
  assert.match(text, /WAIT/)
  assert.match(text, /authorize-pr/)
})

test('DISPATCH instruction covers fan-out per CONTRIBUTING', () => {
  const text = instructionFor(stateAt('DISPATCH', 'daily-failure-triage'))
  assert.match(text, /one dedicated issue per problem/i)
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx tsx --test .claude/skills/langflow-e2e-issue-deterministic/pipeline/instructions.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `pipeline/instructions.ts`**

```ts
import type { PipelineState } from './types.ts'

const CLI = 'npx tsx .claude/skills/langflow-e2e-issue-deterministic/pipeline/cli.ts'

export function instructionFor(s: PipelineState, extra: Record<string, unknown> = {}): string {
  const n = s.issue
  const done = (step: string, ev = '{}') =>
    `When done: ${CLI} complete ${n} ${step} --evidence-json '${ev}'`

  switch (s.phase) {
    case 'INTAKE':
      return [
        `Issue #${n} loaded: "${s.issueData?.title}" (milestone: ${s.issueData?.milestone ?? 'none'}, body format ${s.issueData?.bodyFormat}).`,
        `Restate to the user in PT-BR what the issue asks. Do not touch code.`,
        done('INTAKE', '{"restated":true}'),
      ].join('\n')

    case 'CLASSIFY':
      return [
        s.type
          ? `Heuristic classification: ${s.type} (${s.classification?.justification}). Confirm it with the user.`
          : `No heuristic matched. Classify the issue yourself using the 6-type table in the langflow-e2e-issues skill and record a justification.`,
        done('CLASSIFY', s.type ? '{"confirmed":true}' : '{"type":"<type>","justification":"<why>"}'),
      ].join('\n')

    case 'SPECIFY': {
      const common = [
        `Invoke the langflow-e2e skill (Skill tool) — it owns the SDD workflow and authoring conventions.`,
        `Grep its references/authoring-conventions.md for any mechanism before hand-rolling it.`,
      ]
      if (s.type === 'validate-promote') {
        return [
          `Locate the EXISTING spec/test this issue promotes. Audit force-failability BEFORE trusting any green baseline (dead assertions, if-visible guards, silent early returns — hardening is in scope).`,
          `Author a spec doc only if missing.`,
          ...common,
          done('SPECIFY', '{"specDoc":"docs/<path>.md","userConfirmed":true,"existingSpec":"tests/<path>.spec.ts"}'),
        ].join('\n')
      }
      return [
        `Author the spec doc under docs/ mirroring the test path. Body format ${s.issueData?.bodyFormat}: map its fields per the langflow-e2e-issues field tables.`,
        `Format-A issues are thin: derive a CONCRETE Validation criterion (a distinctive observable) yourself and confirm it with the user — never ship the issue's vagueness.`,
        ...common,
        `Do NOT create or edit any .spec.ts yet — the pipeline blocks IMPLEMENT until this step completes.`,
        done('SPECIFY', '{"specDoc":"docs/<path>.md","userConfirmed":true}'),
      ].join('\n')
    }

    case 'PLAN':
      return [
        `Plan the test design: POM/helper reuse, tags (≥1 cross-cutting + ≥1 functional), fixtures import from tests/fixtures/fixtures.ts, live-testid scouting via playwright-cli (never invent selectors).`,
        `Agent/provider specs: run collect-models first, set model strategy in .env, plan --workers=1 runs; read the area-local CLAUDE.md.`,
        done('PLAN', '{"design":"<one-paragraph summary>"}'),
      ].join('\n')

    case 'DEBUG':
      return [
        `Root-cause before fixing. Invoke superpowers:systematic-debugging.`,
        `Decide the verdict with evidence per the langflow-e2e-issues taxonomy: test-defect | langflow-regression | product-changed | transient-saturation | cross-worker-wiper.`,
        `Any verdict other than test-defect: STOP and present evidence to the user; their decision goes in evidence.decision.`,
        done('DEBUG', '{"verdict":"<verdict>","summary":"<root cause>","decision":"<required unless test-defect>"}'),
      ].join('\n')

    case 'IMPLEMENT':
      return [
        `Implement per the confirmed spec doc. New helper/POM as real code → invoke superpowers:test-driven-development.`,
        `Known limitations (e.g. local --trace=on hangs on template-family specs): see the langflow-e2e-issues skill — don't rediscover them.`,
        done('IMPLEMENT', '{"files":["tests/<path>.spec.ts"]}'),
      ].join('\n')

    case 'VALIDATE':
      return [
        `Mechanical validation ran (see status above): nightly check, --retries=0 burst parsed from JSON stats, typecheck, lint, backend-error scan, QA-CHECKLIST diff rules.`,
        `Fix whatever is red and re-run ${CLI} next ${n}. Update the QA-CHECKLIST bullet (bullets only — generated blocks are enforced).`,
        `Extra targets beyond the git diff: ${CLI} next ${n} --spec <path> or --grep <pattern>.`,
        done('VALIDATE', '{"nightly":"<resolved version>"}'),
      ].join('\n')

    case 'FORCE_FAIL':
      return [
        `Force-fail every test() in the touched spec files (list in status). For each: add a mutation WITH the marker comment "// FF-MUTATION", then run:`,
        `${CLI} ff-run ${n} --file <spec> --test "<exact title>" --mutation "<what you changed>"`,
        `The command runs playwright --grep on that title and only records the entry if it FAILS. Serial files: mutate one test at a time. Then revert all mutations; the gate verifies no FF-MUTATION marker remains and requires a final green run (next runs it).`,
        done('FORCE_FAIL'),
      ].join('\n')

    case 'REPORT':
      return [
        `Write the PT-BR report: (1) what the issue is about; (2) what was done, with real output and resolved nightly; (3) the REQUIRED per-test table (skeleton in status — fill "O que faz" / "O que valida" with concrete observables) + one FF: line per mutation; (4) end with the manual --debug run command.`,
        done('REPORT', '{"reported":true}'),
      ].join('\n')

    case 'AWAIT_PR_AUTH':
      return [
        `Report is delivered. WAIT. Do NOT run gh pr create, commit, or push.`,
        `Only when the user explicitly authorizes ("abre o PR" or similar), run:`,
        `${CLI} authorize-pr ${n} --quote "<their exact words>"`,
      ].join('\n')

    case 'PR':
      return [
        `Authorized. Follow langflow-e2e/references/pr-guide.md: branch type/issue-NNN-desc, Conventional-Commit title with (#${n}), body with "Closes #${n}" + the correct template + the REAL Validation block.`,
        `The complete gate verifies branch name, Closes line, and roadmap label mechanically.`,
        `Post-merge: verify the issue actually closed (edited-Fixes GitHub quirk) and delete the branch.`,
        done('PR', '{"prUrl":"<url>","prBody":"<body text>"}'),
      ].join('\n')

    case 'DISPATCH':
      return [
        `This is a triage dispatcher, not a fix. Per CONTRIBUTING § @stable lifecycle: open one dedicated issue per problem, classify each (hard-failure vs recurrent-flake vs transient vs wiper), and do NOT fix anything on this branch.`,
        done('DISPATCH', '{"createdIssues":["#NNN"]}'),
      ].join('\n')

    case 'DONE': return `Pipeline for #${n} is DONE.`
    case 'DISPATCHED': return `Triage #${n} dispatched — work the created issues separately.`
    case 'ABORTED': return `Pipeline for #${n} was aborted: ${s.abortReason}`
    default: return `No instruction for phase ${s.phase}.`
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx tsx --test .claude/skills/langflow-e2e-issue-deterministic/pipeline/instructions.test.ts`
Expected: PASS (5 tests).

---

### Task 7: CLI — command dispatch and mechanical work

**Files:**
- Create: `pipeline/cli.ts`, `pipeline/cli.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–6 (exact exports listed in their Interfaces blocks).
- Produces: commands `next`, `complete`, `escalate`, `ff-run`, `status`, `abort`, `metrics`, `authorize-pr`. Also exports pure helpers for testing: `parseArgs(argv: string[])`, `sanitizeEvidence(raw: Record<string, unknown>): Record<string, unknown>` (strips RESERVED keys), `releaseCycleOf(version: string): string` (`'1.11.2.dev3'` → `'1.11'`).

- [ ] **Step 1: Write failing tests in `pipeline/cli.test.ts`**

```ts
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
```

- [ ] **Step 2: Run to verify failure**

Run: `npx tsx --test .claude/skills/langflow-e2e-issue-deterministic/pipeline/cli.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `pipeline/cli.ts`**

```ts
import * as fs from 'node:fs'
import type { FFEntry, Phase, PipelineState, PwStats } from './types.ts'
import {
  initState, loadState, saveState, ensureStep, completeStep, escalateToDebug,
  setType, abortState, metricsOf, listStates, spineFor, TERMINAL, now,
} from './state.ts'
import { classify, detectBodyFormat } from './classify.ts'
import {
  ghIssueView, ghAssignSelf, runPlaywright, npmRun, gitCurrentBranch,
  gitDiffNames, gitDiffOf, enumerateTests, getInstanceVersion, getLatestNightlyTag,
} from './runners.ts'
import {
  checkSpecDoc, checkQaDiff, checkForceFailCoverage, checkNoMutationMarkers,
  checkPrReadiness,
} from './gates.ts'
import { instructionFor } from './instructions.ts'

const REPO = 'oriontech-me/langflow-e2e'
const EXCEPTION_LABELS = ['daily-failure', 'community', 'follow-up']
export const RESERVED_KEYS = ['runs', 'typecheck', 'lint', 'nightly', 'qaDiff', 'ff', 'finalGreen']
const BURST = Number(process.env.PIPELINE_BURST ?? 3)

// ---------- pure helpers (unit-tested) ----------

export function parseArgs(argv: string[]) {
  const [command, issueStr, ...rest] = argv
  const issue = Number(issueStr)
  const flags: Record<string, string> = {}
  let step: string | undefined
  let evidence: Record<string, unknown> = {}
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const val = rest[i + 1] ?? ''
      i++
      if (key === 'evidence-json') evidence = JSON.parse(val)
      else flags[key] = val
    } else if (!step) step = a
  }
  return { command, issue, step, flags, evidence }
}

export function sanitizeEvidence(raw: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(raw).filter(([k]) => !RESERVED_KEYS.includes(k)))
}

export function releaseCycleOf(version: string): string {
  return version.split('.').slice(0, 2).join('.')
}

// ---------- shared mechanical helpers ----------

function fail(msg: string): never {
  console.error(`✖ ${msg}`)
  process.exit(1)
}

function load(issue: number): PipelineState {
  const s = loadState(issue)
  if (!s) fail(`no state for issue ${issue} — run: next ${issue}`)
  return s
}

function touchedSpecFiles(): string[] {
  return gitDiffNames().filter(f => f.endsWith('.spec.ts'))
}

function guardBranchOwnership(s: PipelineState): void {
  const branch = gitCurrentBranch()
  const other = listStates().find(o =>
    o.issue !== s.issue && o.branch === branch && !TERMINAL.includes(o.phase))
  if (branch && other) {
    fail(`branch "${branch}" belongs to in-flight issue #${other.issue} — one issue per branch`)
  }
  if (branch && branch !== 'main') s.branch = branch
}

function guardSpecFirst(s: PipelineState): void {
  const before = ['INTAKE', 'CLASSIFY', 'SPECIFY', 'PLAN']
  if (before.includes(s.phase) && !s.steps.SPECIFY?.completedAt) {
    const touched = touchedSpecFiles()
    if (touched.length > 0) {
      fail(`spec-first gate: .spec.ts modified before SPECIFY completed: ${touched.join(', ')}`)
    }
  }
}

// ---------- per-phase mechanical work run by `next` ----------

async function mechanicalFor(s: PipelineState, flags: Record<string, string>): Promise<string[]> {
  const notes: string[] = []
  const rec = ensureStep(s, s.phase)
  rec.attempts++

  if (s.phase === 'INTAKE' && !s.issueData) {
    const data = ghIssueView(REPO, s.issue)
    if (data.state !== 'OPEN') fail(`issue #${s.issue} is ${data.state}`)
    const bodyFormat = detectBodyFormat(data.body)
    s.issueData = { ...data, bodyFormat }
    const linked = data.milestone !== null
      || data.labels.some(l => EXCEPTION_LABELS.includes(l.toLowerCase()))
    if (!linked) {
      fail(`issue #${s.issue} has no milestone and no exception label (${EXCEPTION_LABELS.join('/')}) — no roadmap linkage (ROADMAP.md → Intake)`)
    }
    if (flags['no-assign'] === undefined) ghAssignSelf(REPO, s.issue)
    const dep = data.body.match(/depends on:?\s*#(\d+)/i)
    if (dep) {
      const depIssue = ghIssueView(REPO, Number(dep[1]))
      if (depIssue.state === 'OPEN') {
        fail(`blocker #${dep[1]} ("${depIssue.title}") is still OPEN — resolve it first`)
      }
      notes.push(`blocker #${dep[1]} is closed ✓`)
    }
    notes.push(`intake ok: milestone=${data.milestone ?? 'exception-label'} format=${bodyFormat}`)
  }

  if (s.phase === 'CLASSIFY' && !s.type) {
    const r = classify({
      title: s.issueData!.title, labels: s.issueData!.labels, body: s.issueData!.body,
    })
    if (r.type) {
      setType(s, r.type, 'heuristic', r.reason)
      notes.push(`heuristic: ${r.type} (${r.reason})`)
    } else {
      notes.push(`heuristic inconclusive: ${r.reason}`)
    }
  }

  if (s.phase === 'VALIDATE') {
    const ev = rec.evidence as {
      runs?: Array<{ target: string; stats: PwStats }>
      typecheck?: number; lint?: number; nightly?: Record<string, string | null>
      qaDiff?: string[]
    }
    ev.runs ??= []
    const instance = await getInstanceVersion(process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:7860')
    const latest = await getLatestNightlyTag()
    ev.nightly = { instance, latest }
    if (instance && latest && !latest.includes(instance) && !instance.includes(latest)) {
      notes.push(`⚠ nightly mismatch: instance=${instance} latest=${latest} — restart via ./scripts/start-langflow-docker.sh`)
    } else {
      notes.push(`nightly: instance=${instance} latest=${latest}`)
    }
    const targets = flags.spec ? [flags.spec]
      : flags.grep ? [`--grep:${flags.grep}`]
      : touchedSpecFiles()
    for (const t of targets) {
      const already = ev.runs.filter(r => r.target === t && r.stats.unexpected === 0 && !r.stats.backendErrors)
      for (let i = already.length; i < BURST; i++) {
        const args = t.startsWith('--grep:')
          ? ['--grep', t.slice(7), '--retries=0', '--workers=1']
          : [t, '--retries=0', '--workers=1']
        const run = runPlaywright(args)
        if (!run.stats) fail(`could not parse playwright JSON for ${t}`)
        ev.runs.push({ target: t, stats: run.stats })
        notes.push(`run ${i + 1}/${BURST} ${t}: expected=${run.stats.expected} unexpected=${run.stats.unexpected} flaky=${run.stats.flaky} backendErrors=${run.stats.backendErrors}`)
        if (run.stats.unexpected > 0 || run.stats.backendErrors) break
      }
    }
    if (targets.length === 0) notes.push('no .spec.ts in diff — docs-only change, burst skipped')
    ev.typecheck = npmRun('typecheck').code
    ev.lint = npmRun('lint').code
    notes.push(`typecheck=${ev.typecheck} lint=${ev.lint}`)
    if (gitDiffNames().includes('QA-CHECKLIST.md')) {
      ev.qaDiff = checkQaDiff(gitDiffOf('QA-CHECKLIST.md'))
      notes.push(ev.qaDiff.length ? `QA-CHECKLIST problems: ${ev.qaDiff.join('; ')}` : 'QA-CHECKLIST diff ok')
    }
  }

  if (s.phase === 'FORCE_FAIL') {
    const ev = rec.evidence as { ff?: FFEntry[]; finalGreen?: PwStats }
    ev.ff ??= []
    const required = touchedSpecFiles().map(f => ({
      file: f, titles: enumerateTests(fs.readFileSync(f, 'utf8')),
    }))
    const missing = checkForceFailCoverage(required, ev.ff)
    const dirty = checkNoMutationMarkers(
      touchedSpecFiles().map(f => ({ file: f, diff: gitDiffOf(f) })))
    notes.push(`FF coverage: ${missing.length === 0 ? 'complete' : missing.join('; ')}`)
    notes.push(dirty.length ? dirty.join('; ') : 'no FF-MUTATION markers in diff ✓')
    if (missing.length === 0 && dirty.length === 0 && !ev.finalGreen) {
      for (const { file } of required) {
        const run = runPlaywright([file, '--retries=0', '--workers=1'])
        if (!run.stats || run.stats.unexpected > 0 || run.stats.backendErrors) {
          fail(`final green run failed for ${file} after FF reverts`)
        }
        ev.finalGreen = run.stats
      }
      notes.push('final green run after reverts ✓')
    }
  }

  if (s.phase === 'REPORT') {
    const rows = touchedSpecFiles().flatMap(f =>
      enumerateTests(fs.readFileSync(f, 'utf8')).map(t => `| | ${t} | | |`))
    notes.push('Report table skeleton:\n| # | Teste | O que faz | O que valida (observável concreto) |\n|---|---|---|---|\n' + rows.join('\n'))
    const ff = (s.steps.FORCE_FAIL?.evidence as { ff?: FFEntry[] })?.ff ?? []
    for (const e of ff) notes.push(`FF: ${e.test} — ${e.mutation} → failed as expected (unexpected=${e.unexpected})`)
  }

  return notes
}

// ---------- gates run by `complete` ----------

function gateFor(s: PipelineState, step: Phase, evidence: Record<string, unknown>): string[] {
  const problems: string[] = []
  const rec = s.steps[step]

  if (step === 'CLASSIFY') {
    if (!s.type && typeof evidence.type === 'string') {
      if (typeof evidence.justification !== 'string') problems.push('claude classification needs justification')
      else setType(s, evidence.type as never, 'claude', evidence.justification)
    }
    if (!s.type && !evidence.type) problems.push('no type: heuristic failed and none supplied')
  }

  if (step === 'SPECIFY') {
    const doc = evidence.specDoc
    if (typeof doc !== 'string' || !fs.existsSync(doc)) {
      problems.push(`evidence.specDoc missing or not found: ${doc}`)
    } else {
      const instanceCycle = ((s.steps.VALIDATE?.evidence as { nightly?: { instance?: string } })
        ?.nightly?.instance) ?? process.env.PIPELINE_RELEASE_CYCLE ?? '1.11'
      problems.push(...checkSpecDoc(fs.readFileSync(doc, 'utf8'), releaseCycleOf(instanceCycle + '.0')))
    }
    if (evidence.userConfirmed !== true) {
      problems.push('evidence.userConfirmed must be true — confirm the spec doc with the user first')
    }
  }

  if (step === 'VALIDATE') {
    const ev = (rec?.evidence ?? {}) as {
      runs?: Array<{ stats: PwStats }>; typecheck?: number; lint?: number; qaDiff?: string[]
    }
    const runs = ev.runs ?? []
    const greens = runs.filter(r => r.stats.unexpected === 0 && r.stats.flaky === 0 && !r.stats.backendErrors)
    const hadTargets = touchedSpecFiles().length > 0
    if (hadTargets && greens.length < BURST) {
      problems.push(`need ${BURST} clean --retries=0 runs per target; have ${greens.length} (run next again)`)
    }
    if (ev.typecheck !== 0) problems.push(`typecheck exit=${ev.typecheck}`)
    if (ev.lint !== 0) problems.push(`lint exit=${ev.lint}`)
    if ((ev.qaDiff ?? []).length > 0) problems.push(...ev.qaDiff!)
  }

  if (step === 'FORCE_FAIL') {
    const ev = (rec?.evidence ?? {}) as { ff?: FFEntry[]; finalGreen?: PwStats }
    const required = touchedSpecFiles().map(f => ({
      file: f, titles: enumerateTests(fs.readFileSync(f, 'utf8')),
    }))
    problems.push(...checkForceFailCoverage(required, ev.ff ?? []))
    problems.push(...checkNoMutationMarkers(
      touchedSpecFiles().map(f => ({ file: f, diff: gitDiffOf(f) }))))
    if (required.length > 0 && !ev.finalGreen) problems.push('final green run missing (run next)')
  }

  if (step === 'DISPATCH') {
    const created = evidence.createdIssues
    if (!Array.isArray(created) || created.length === 0) {
      problems.push('evidence.createdIssues must list the dedicated issues opened')
    }
  }

  if (step === 'PR') {
    const prBody = typeof evidence.prBody === 'string' ? evidence.prBody : ''
    if (typeof evidence.prUrl !== 'string') problems.push('evidence.prUrl required')
    problems.push(...checkPrReadiness({
      branch: gitCurrentBranch(), prBody, issue: s.issue,
      isWave: s.issueData?.milestone != null,
      labels: s.issueData?.labels ?? [],
    }))
  }

  return problems
}

// ---------- commands ----------

async function main() {
  const { command, issue, step, flags, evidence } = parseArgs(process.argv.slice(2))
  if (!command || Number.isNaN(issue)) {
    fail('usage: cli.ts <next|complete|escalate|ff-run|status|abort|metrics|authorize-pr> <issue> [step] [--flags]')
  }

  if (command === 'next') {
    const s = loadState(issue) ?? initState(issue, REPO)
    guardBranchOwnership(s)
    guardSpecFirst(s)
    const notes = await mechanicalFor(s, flags)
    saveState(s)
    console.log(`— issue #${issue} · phase ${s.phase} · type ${s.type ?? '?'} —`)
    for (const line of notes) console.log(line)
    console.log('\n' + instructionFor(s))
    return
  }

  if (command === 'complete') {
    const s = load(issue)
    if (!step) fail('complete needs a step name')
    if (step !== s.phase) fail(`expected "${s.phase}", got "${step}"`)
    const clean = sanitizeEvidence(evidence)
    const problems = gateFor(s, step as Phase, clean)
    if (problems.length > 0) {
      saveState(s)
      fail(`gate failed for ${step}:\n  - ${problems.join('\n  - ')}`)
    }
    completeStep(s, step as Phase, clean)
    saveState(s)
    console.log(`✔ ${step} complete → phase ${s.phase}`)
    console.log('\n' + instructionFor(s))
    return
  }

  if (command === 'escalate') {
    const s = load(issue)
    if (flags.reason === undefined) fail('escalate needs --reason')
    escalateToDebug(s, flags.reason)
    saveState(s)
    console.log(`⚠ escalated to DEBUG (parked: ${s.parkedPhase})`)
    console.log('\n' + instructionFor(s))
    return
  }

  if (command === 'ff-run') {
    const s = load(issue)
    if (s.phase !== 'FORCE_FAIL') fail(`ff-run only valid in FORCE_FAIL (now: ${s.phase})`)
    const { file, test: title, mutation } = flags
    if (!file || !title || !mutation) fail('ff-run needs --file --test --mutation')
    if (!gitDiffOf(file).includes('FF-MUTATION')) {
      fail(`diff of ${file} has no "// FF-MUTATION" marker — add it to the mutation first`)
    }
    const run = runPlaywright([file, '--grep', title, '--retries=0', '--workers=1'])
    if (!run.stats) fail('could not parse playwright JSON')
    if (run.stats.unexpected === 0) {
      fail(`mutation did NOT make "${title}" fail (unexpected=0) — the test cannot detect it; strengthen the assert or pick a real mutation`)
    }
    const rec = ensureStep(s, 'FORCE_FAIL')
    const ev = rec.evidence as { ff?: FFEntry[] }
    ev.ff ??= []
    ev.ff.push({ file, test: title, mutation, unexpected: run.stats.unexpected, at: now() })
    saveState(s)
    console.log(`✔ FF recorded: "${title}" failed as expected (unexpected=${run.stats.unexpected}). Now REVERT the mutation.`)
    return
  }

  if (command === 'status') {
    const s = load(issue)
    console.log(JSON.stringify({
      issue: s.issue, phase: s.phase, type: s.type, branch: s.branch,
      parkedPhase: s.parkedPhase, spine: spineFor(s.type),
      completed: Object.entries(s.steps).filter(([, r]) => r.completedAt).map(([k]) => k),
    }, null, 2))
    return
  }

  if (command === 'abort') {
    const s = load(issue)
    abortState(s, flags.reason ?? 'unspecified')
    saveState(s)
    console.log(`✖ aborted: ${s.abortReason}`)
    return
  }

  if (command === 'metrics') {
    const s = load(issue)
    console.log(JSON.stringify(metricsOf(s), null, 2))
    return
  }

  if (command === 'authorize-pr') {
    const s = load(issue)
    if (s.phase !== 'AWAIT_PR_AUTH') fail(`authorize-pr only valid in AWAIT_PR_AUTH (now: ${s.phase})`)
    if (!flags.quote) fail('authorize-pr needs --quote "<user\'s exact words>"')
    s.prAuth = { quote: flags.quote, at: now() }
    completeStep(s, 'AWAIT_PR_AUTH', { authorized: true, quote: flags.quote })
    saveState(s)
    console.log(`✔ PR authorized → phase ${s.phase}`)
    console.log('\n' + instructionFor(s))
    return
  }

  fail(`unknown command "${command}"`)
}

const isDirectRun = process.argv[1]?.endsWith('cli.ts')
if (isDirectRun) {
  main().catch(e => fail(e instanceof Error ? e.message : String(e)))
}
```

- [ ] **Step 4: Run unit tests to verify pass**

Run: `npx tsx --test .claude/skills/langflow-e2e-issue-deterministic/pipeline/cli.test.ts`
Expected: PASS (4 tests). Note: importing `cli.ts` from the test must NOT execute `main()` — the `isDirectRun` guard covers that (test entry is `cli.test.ts`).

- [ ] **Step 5: Full suite + typecheck**

Run: `npx tsx --test .claude/skills/langflow-e2e-issue-deterministic/pipeline/*.test.ts && npx tsc --noEmit -p .claude/skills/langflow-e2e-issue-deterministic/pipeline/tsconfig.json`
Expected: all tests PASS, tsc exit 0.

- [ ] **Step 6: Manual smoke against a real issue (no side effects)**

Run (uses `--no-assign ''` so no assignment happens; pick any OPEN issue number from `gh issue list --repo oriontech-me/langflow-e2e --state open --limit 3`):

```bash
npx tsx .claude/skills/langflow-e2e-issue-deterministic/pipeline/cli.ts next <NNN> --no-assign ''
npx tsx .claude/skills/langflow-e2e-issue-deterministic/pipeline/cli.ts status <NNN>
npx tsx .claude/skills/langflow-e2e-issue-deterministic/pipeline/cli.ts complete <NNN> VALIDATE --evidence-json '{}'
npx tsx .claude/skills/langflow-e2e-issue-deterministic/pipeline/cli.ts abort <NNN> --reason "smoke test"
rm .claude/issue-pipeline/issue-<NNN>.json
```

Expected: `next` prints intake notes + INTAKE instruction; `status` prints JSON with `phase: "INTAKE"`; the out-of-order `complete VALIDATE` FAILS with `expected "INTAKE"`; abort works; state file removed.

---

### Task 8: SKILL.md driver

**Files:**
- Create: `SKILL.md` (skill root, next to DESIGN.md)

**Interfaces:**
- Consumes: the CLI command surface from Task 7 (exact invocations).
- Produces: the user-invocable skill.

- [ ] **Step 1: Write `SKILL.md`**

```markdown
---
name: langflow-e2e-issue-deterministic
description: >-
  Deterministic pipeline variant of langflow-e2e-issues. Use when the user asks
  to work a GitHub issue from oriontech-me/langflow-e2e VIA THE PIPELINE — e.g.
  "resolve issue #493 com o pipeline", "roda a issue #520 no modo determinístico",
  "issue pipeline". A TypeScript state machine owns phase order, gates, and
  evidence; you only do the judgment work each emitted instruction asks for.
  Coexists with langflow-e2e-issues (future benchmark).
---

# Langflow E2E — Deterministic Issue Pipeline

The state machine at `pipeline/cli.ts` (this directory) drives one issue
end-to-end. You do not decide what comes next — the CLI does.

## Language rule

Talk to the user in PT-BR; every artifact (code, spec docs, commit/PR/issue
text, branch names) in English. Repo rule — `CLAUDE.md`.

## The loop (only behavior of this skill)

```bash
PIPE="npx tsx .claude/skills/langflow-e2e-issue-deterministic/pipeline/cli.ts"
$PIPE next <NNN>          # run this first and after every completed step
```

1. Run `next`. Read the status lines and the instruction it prints.
2. Do EXACTLY what the instruction says — including invoking the companion
   skills it names (`langflow-e2e`, `playwright-cli`,
   `superpowers:systematic-debugging`, `superpowers:test-driven-development`).
3. When the instruction's work is done, run the `complete` command it printed,
   with truthful `--evidence-json`. If the gate rejects, fix and repeat.
4. Repeat until `DONE` / `DISPATCHED`.

Other commands, only when the situation calls for them:

```bash
$PIPE escalate <NNN> debug --reason "…"   # behavior looks broken, any phase
$PIPE ff-run <NNN> --file <spec> --test "<title>" --mutation "<desc>"
$PIPE status <NNN>
$PIPE metrics <NNN>                        # benchmark data
$PIPE abort <NNN> --reason "…"
$PIPE authorize-pr <NNN> --quote "<user's exact words>"   # ONLY after explicit user authorization
```

## Hard rules

- **Never bypass the CLI**: no `gh pr create`, no commit/push, no phase
  skipping, no editing files under `.claude/issue-pipeline/`.
- **Never fabricate evidence**: `userConfirmed: true` only after the user
  actually confirmed in chat; `--quote` only with words the user actually said.
  Runner-written keys (runs/typecheck/lint/nightly/qaDiff/ff) are ignored if
  you pass them — don't try.
- **If the pipeline errors or its instruction contradicts reality** (e.g. the
  issue premise died upstream), stop and report to the user — don't improvise
  around the state machine.
- Force-fail mutations must carry a `// FF-MUTATION` comment — `ff-run`
  refuses to record without it, and the revert gate greps for it.

## Boundaries

Git-ignored `.claude/` — never commit any of this or reference it from tracked
files. Domain conventions live in `langflow-e2e` (+ its references) and
`langflow-e2e-issues`; instructions point there. Process lives here.
```

- [ ] **Step 2: Verify skill discovery**

Run: `head -12 .claude/skills/langflow-e2e-issue-deterministic/SKILL.md`
Expected: valid YAML frontmatter with `name` and `description`. (New skills load on next session; note that to the user.)

- [ ] **Step 3: Final full verification**

Run: `npx tsx --test .claude/skills/langflow-e2e-issue-deterministic/pipeline/*.test.ts && npx tsc --noEmit -p .claude/skills/langflow-e2e-issue-deterministic/pipeline/tsconfig.json && npm run typecheck && npm run lint`
Expected: pipeline tests PASS, pipeline tsc exit 0, and the repo's own typecheck/lint still PASS (proves zero footprint on the tracked repo).

---

## Self-Review (performed)

- **Spec coverage:** every DESIGN.md element maps to a task — state machine + spines + escalate (T2), classification + body formats (T3), runners incl. nightly/backend-error/QA-diff mechanics (T4/T7), all 6 hard gates (T5/T7: spec-first in `guardSpecFirst`, parsed-green in VALIDATE gate, FF coverage in FORCE_FAIL gate, PR auth in `authorize-pr`, one-issue-per-branch in `guardBranchOwnership`, pre-PR checklist in `checkPrReadiness`+`checkSpecDoc`), instructions with companion-skill pointers (T6), metrics/abort (T2/T7), SKILL.md contract (T8). `ff-run` extends the design's command surface (anticipated by DESIGN's FF evidence model).
- **Placeholder scan:** none — all code complete.
- **Type consistency:** `FFEntry.unexpected` (not `stats.unexpected`) used consistently in gates/cli; `spineFor`/`TERMINAL`/`now` exported from state.ts and consumed in cli.ts; `PwStats` shared via types.ts.
- **Known simplification:** `checkSpecDoc` release-cycle source falls back to `PIPELINE_RELEASE_CYCLE` env / `'1.11'` when VALIDATE hasn't run yet (SPECIFY happens before VALIDATE); acceptable — the pre-PR gate re-checks after VALIDATE recorded the real instance version.
```
