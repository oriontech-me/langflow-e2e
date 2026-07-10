import type { FFEntry } from './types.ts'

export const SPEC_DOC_SECTIONS = [
  'What this test validates', 'Tags', 'Validation criterion', 'External dependencies',
]

export function checkSpecDoc(content: string, releaseCycle: string): string[] {
  const problems = SPEC_DOC_SECTIONS
    .filter(s => !content.includes(s))
    .map(s => `spec doc missing mandatory section "${s}"`)
  // Repo convention writes "**Last validated:** Langflow 1.11.x" — allow the
  // product name and a trailing ".x" cycle suffix before the numeric capture.
  const lv = content.match(/Last validated[:*\s]+(?:Langflow\s+)?v?([\d]+(?:\.[\d]+)*)/i)
  if (!lv) problems.push('spec doc missing "Last validated" field')
  else if (!(lv[1] === releaseCycle || lv[1].startsWith(releaseCycle + '.'))) {
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
