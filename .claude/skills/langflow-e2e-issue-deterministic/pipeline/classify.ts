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
