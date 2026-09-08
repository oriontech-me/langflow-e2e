import type { IssueType } from './types.ts'

export interface ClassifyInput { title: string; labels: string[]; body: string }

/** Dedicated daily-failure issue, e.g. "[Daily #1296] ollama-provider — ...". */
export const DEDICATED_DAILY_TITLE = /^\s*\[daily\s*#\d+\]/
/** Umbrella opened by daily-stable.yml, e.g. "[Daily Failure] @stable tests failed on ...". */
export const UMBRELLA_DAILY_TITLE = /^\s*\[daily\s+failure\]/

export function classify(i: ClassifyInput): { type: IssueType | null; reason: string } {
  const hay = (i.title + '\n' + i.body).toLowerCase()
  const title = i.title.toLowerCase()
  const labels = i.labels.map(l => l.toLowerCase())

  if (labels.includes('daily-failure')) {
    // The title contract is read FIRST, because the "triage" wording cannot
    // separate the two kinds: the dedicated-issue template's mandatory first
    // line is "Spun out of daily-failure triage #<umbrella>"
    // (langflow-e2e-triage/references/issue-templates.md), so EVERY dedicated
    // issue carries the word and every one of them used to route to the triage
    // spine — which dispatches sub-issues for a failure that already has a
    // dedicated issue. Both titles are machine-written and stable:
    // `scripts/create-failure-issue.mjs` opens the umbrella as
    // "[Daily Failure] ..." and the triage skill opens each dedicated issue as
    // "[Daily #<umbrella>] ...".
    if (DEDICATED_DAILY_TITLE.test(title)) {
      return { type: 'fix', reason: 'label daily-failure + "[Daily #N]" dedicated-issue title' }
    }
    if (UMBRELLA_DAILY_TITLE.test(title)) {
      return { type: 'daily-failure-triage', reason: 'label daily-failure + "[Daily Failure]" umbrella title' }
    }
    // Neither title form — a hand-opened issue. Fall back to the wording.
    if (/triage/.test(hay)) {
      return { type: 'daily-failure-triage', reason: 'label daily-failure + "triage" wording (no title contract match)' }
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
