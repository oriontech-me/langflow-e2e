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
