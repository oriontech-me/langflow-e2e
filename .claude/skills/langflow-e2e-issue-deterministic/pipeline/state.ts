import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Phase, PipelineState, StepRecord, IssueType } from './types.ts'

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
    .map(f => {
      const s = JSON.parse(fs.readFileSync(path.join(stateDir(), f), 'utf8')) as PipelineState
      if (s.version !== 1) throw new Error(`unsupported state version ${s.version} in ${f}`)
      return s
    })
}

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
  // Start the next phase's clock at the moment the previous one completes —
  // deferring to the next `next` call made per-phase ms read ~0 whenever
  // `complete` calls ran back-to-back (benchmark rows 3 and 9 undercount).
  else ensureStep(s, s.phase)
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
  if (rec.completedAt) {
    // Fresh episode: a prior DEBUG run already completed here — archive its
    // evidence instead of silently merging into it (keeps benchmark metrics honest).
    const { previousEpisodes, ...oldEvidence } = rec.evidence as Record<string, unknown> & {
      previousEpisodes?: unknown[]
    }
    const archive = previousEpisodes ?? []
    archive.push(oldEvidence)
    rec.evidence = { previousEpisodes: archive }
    rec.startedAt = now()
    delete rec.completedAt
  }
  rec.evidence.reason = reason
}

export function abortState(s: PipelineState, reason: string): void {
  if (TERMINAL.includes(s.phase)) throw new Error(`pipeline already ${s.phase}`)
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
