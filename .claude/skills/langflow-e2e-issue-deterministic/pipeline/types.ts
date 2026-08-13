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
  /**
   * Every `🚨 Backend Error: …` line the run printed.
   *
   * The boolean above cannot be justified, only obeyed: it says a 4xx/5xx was
   * logged, not which one, so a run that is green except for a backend error
   * the repo already treats as ambient had no way through the burst (#1422 —
   * `500 /api/v1/flows/`, `OperationalError: database is locked` on the bulk
   * delete the UI issues, 8 of 8 tests passing). Keeping the lines lets a
   * declaration be matched against what actually fired.
   */
  backendErrorLines: string[]
  /** Error messages of every non-passing result — the input to classifyRun. */
  failureMessages: string[]
}

/**
 * A run that aborted on a known environment signature (a wedged backend
 * dropping /api/v1/auto_login, a socket hang up) says nothing about the spec.
 * It is voided and re-run, never counted as a failure or as a clean run.
 */
export type RunClass = 'clean' | 'clean-ambient' | 'infra-void' | 'real-failure'

/**
 * A declared-ambient backend error: substrings that may appear in a run's
 * `🚨 Backend Error` lines, plus the written reason they are not this issue's
 * defect. Both halves are required — a pattern with no reason is a mute.
 */
export interface BackendAmbient {
  patterns: string[]
  reason: string
}

export interface RunRecord {
  target: string
  stats: PwStats
  class?: RunClass
}

/** Pre-fix flake rate, written by `repro-run` (never by hand). */
export interface ReproRate {
  spec: string
  grep?: string
  runs: number
  failures: number
  voids: number
  signatures: string[]
  at: string
}

export interface TestEntry {
  title: string
  /** '', '.fixme', '.skip', '.only' or '.fail' as written in the source. */
  modifier: string
  tags: string[]
}

export const VERDICTS = [
  'test-defect', 'langflow-regression', 'product-changed',
  'transient-saturation', 'cross-worker-wiper', 'stale-confirmed-bug',
] as const
export type Verdict = (typeof VERDICTS)[number]

/**
 * One row of a dedicated issue's symptom table. A daily-failure issue can list
 * several failures with DIFFERENT causes (#1060 listed two; the second was
 * #1030's auto_login timeout), so each row carries its own verdict and, when
 * it belongs elsewhere, the issue that owns it.
 */
export interface Symptom {
  row: string
  verdict: Verdict
  ownedBy?: string
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
