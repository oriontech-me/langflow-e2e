import type { FFEntry, ReproRate, TestEntry } from './types.ts'
import { VERDICTS } from './types.ts'

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
    } else if (/^#{2,4} \S/.test(content) || /^> \S/.test(content) || content.trim() === '---') {
      // ok: the structural lines a BRAND-NEW Part II area needs — its `###`
      // section heading, its `#### N.M` subsections, an area-level `>` note, and
      // the `---` separator between areas. The repo's authoritative guard
      // (scripts/check-checklist-guard.mjs) only rejects GENERATED line shapes
      // (table row / count note / Phase bullet) at or after the `## Coverage
      // Summary` anchor, so these were never a violation there; forbidding them
      // here made adding a checklist area impossible, because dropping the
      // heading makes coverage-summary.ts fail with "Section start not found"
      // for the module's `sectionStart` (found while scoping A2A, #1195). The
      // generated blocks stay protected by the two branches above, which run
      // first: a table row and any "Phase 0 — Validated" line are still
      // rejected even when they look like a heading.
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

// ---------- quarantine lift (#1060) ----------

const QUARANTINE_RE = /quarantin|test\.fixme/i
const RESTORE_STABLE_RE = /restore\s+`?@stable|@stable\b[^.\n]{0,40}\brestor/i

/**
 * Lifting the quarantine is the DELIVERABLE of a dedicated issue spawned by
 * triage: `test.fixme` comes off and `@stable` goes back. Nothing checked it,
 * so a fix could ship leaving the test muted in every context — daily, PR gate
 * and full suite alike.
 *
 * Only the issue body arms this gate: an issue that never quarantined anything
 * is unaffected, and the `@stable` half only fires when the body asks for the
 * tag back (utility specs legitimately carry no `@stable`).
 */
export function checkQuarantineLifted(
  issueBody: string, files: Array<{ file: string; entries: TestEntry[] }>,
): string[] {
  if (!QUARANTINE_RE.test(issueBody)) return []
  const problems: string[] = []
  // A touched spec can carry a `test.fixme` that belongs to ANOTHER issue, and
  // demanding its lift here is asking one PR to close someone else's
  // investigation. #1422 hit exactly that: its body arms this gate through the
  // template's "Quarantine lifted" deliverable while quarantining nothing
  // itself (the workflow only auto-removed `@stable`), and the surviving
  // `.fixme` in the same file is #1266's — a transport-level flake its body
  // explicitly excludes as a different cause. So the flag is scoped to the
  // tests the issue actually NAMES, the same attribution the `@stable` half
  // below already uses.
  //
  // Fallback, deliberately strict: if the body arms the gate but names none of
  // the touched titles, every `.fixme` is flagged as before — an issue we
  // cannot attribute must not be the one that slips a muted test through.
  const named = (e: TestEntry) => issueBody.includes(e.title)
  const anyNamed = files.some(f => f.entries.some(named))
  for (const { file, entries } of files) {
    for (const e of entries) {
      if (e.modifier !== '.fixme') continue
      if (anyNamed && !named(e)) continue
      problems.push(`quarantine not lifted: test.fixme still on "${e.title}" in ${file}`)
    }
  }
  if (RESTORE_STABLE_RE.test(issueBody)) {
    for (const { file, entries } of files) {
      for (const e of entries) {
        if (!issueBody.includes(e.title)) continue
        if (!e.tags.includes('@stable')) {
          problems.push(`@stable not restored on "${e.title}" in ${file} (the issue asks for it)`)
        }
      }
    }
  }
  return problems
}

// ---------- per-symptom verdicts (#1060) ----------

/**
 * The spec rows of a dedicated issue's symptom table. A row is any table cell
 * naming a spec file with a line number — the shape triage writes.
 */
export function extractSymptomRows(body: string): string[] {
  const rows = new Set<string>()
  for (const line of body.split('\n')) {
    if (!line.trim().startsWith('|')) continue
    const cell = line.split('|')[1]?.trim()
    if (!cell) continue
    const m = cell.match(/([\w/.-]+\.spec\.ts:\d+)/)
    if (m) rows.add(m[1])
  }
  return [...rows]
}

/**
 * Every row of the issue must get its own verdict. #1060 listed two failures
 * of the SAME test line; they had different causes and one belonged to another
 * issue entirely — a single `verdict` field cannot say that, and closing on the
 * first cause silently drops the second.
 */
export function checkSymptomCoverage(rows: string[], symptoms: unknown): string[] {
  if (rows.length === 0) return []
  if (!Array.isArray(symptoms) || symptoms.length === 0) {
    return [`issue lists ${rows.length} symptom row(s) — evidence.symptoms must give each one a verdict: ${rows.join(', ')}`]
  }
  const problems: string[] = []
  const list = symptoms as Array<Record<string, unknown>>
  for (const s of list) {
    if (typeof s?.row !== 'string') problems.push('every symptom needs a "row"')
    if (typeof s?.verdict !== 'string' || !VERDICTS.includes(s.verdict as never)) {
      problems.push(`symptom "${String(s?.row)}" has an invalid verdict "${String(s?.verdict)}" (one of: ${VERDICTS.join(' | ')})`)
    }
    if (s?.ownedBy !== undefined && !/^#\d+$/.test(String(s.ownedBy))) {
      problems.push(`symptom "${String(s?.row)}" has ownedBy "${String(s.ownedBy)}" — use "#NNNN"`)
    }
  }
  for (const row of rows) {
    const covered = list.some(s =>
      typeof s?.row === 'string' && (s.row.includes(row) || row.includes(s.row)))
    if (!covered) problems.push(`symptom row not accounted for: ${row}`)
  }
  return problems
}

export function symptomsOwnedElsewhere(symptoms: unknown): string[] {
  if (!Array.isArray(symptoms)) return []
  return (symptoms as Array<Record<string, unknown>>)
    .map(s => (typeof s?.ownedBy === 'string' ? s.ownedBy : null))
    .filter((x): x is string => x !== null)
}

// ---------- DEBUG evidence ----------

const FLAKE_RE = /\bflak(e|y|iness)\b|\brecurrent\b|\bintermittent\b/i
const MIN_REPRO_RUNS = 5

/**
 * A flake needs its PRE-fix rate measured, because VALIDATE's clean burst is
 * not evidence on its own: at #1060's ~8 %-per-run rate, three green runs is
 * the expected outcome of doing NOTHING. Either the baseline reproduced the
 * failure, or the mechanism was proven some other way and that proof is stated.
 */
export function checkDebugEvidence(e: {
  issueBody: string
  labels: string[]
  verdict: unknown
  summary: unknown
  decision: unknown
  symptoms: unknown
  reproRate?: ReproRate
  mechanismProof: unknown
}): string[] {
  const problems: string[] = []
  if (typeof e.verdict !== 'string' || !VERDICTS.includes(e.verdict as never)) {
    problems.push(`evidence.verdict must be one of: ${VERDICTS.join(' | ')}`)
  }
  if (typeof e.summary !== 'string' || e.summary.trim() === '') {
    problems.push('evidence.summary must state the root cause')
  }
  if (e.verdict !== 'test-defect' && (typeof e.decision !== 'string' || e.decision.trim() === '')) {
    problems.push(`verdict "${String(e.verdict)}" requires the user's decision in evidence.decision — present the evidence and wait`)
  }
  problems.push(...checkSymptomCoverage(extractSymptomRows(e.issueBody), e.symptoms))

  const isFlake = FLAKE_RE.test(e.issueBody) || e.labels.some(l => /flak/i.test(l))
  if (isFlake) {
    const r = e.reproRate
    if (!r) {
      problems.push('flake issue: measure the PRE-fix rate first — repro-run <NNN> --spec <path> [--grep "<title>"] --runs 10 (VALIDATE\'s clean burst proves nothing on its own)')
    } else if (r.runs < MIN_REPRO_RUNS) {
      problems.push(`repro-run recorded only ${r.runs} run(s); need at least ${MIN_REPRO_RUNS}`)
    } else if (r.failures === 0 && (typeof e.mechanismProof !== 'string' || e.mechanismProof.trim() === '')) {
      problems.push(`the baseline never reproduced (${r.runs} runs, 0 failures) — state how the mechanism was proven in evidence.mechanismProof, or raise --runs`)
    }
  }
  return problems
}

// ---------- PR ----------

export const BRANCH_RE = /^(test|fix|docs|chore|feat|refactor)\/issue-\d+-[a-z0-9][a-z0-9-]*$/

/**
 * The branch must carry the pipeline's files and nothing else. Rebasing onto a
 * local `main` that a parallel session had already committed to silently
 * absorbs that session's commit into the PR (#1060 — caught by hand).
 * `changed === null` means the base ref could not be resolved: fail closed.
 */
export function checkBranchPurity(
  changed: string[] | null,
  allowed: string[],
  declared?: { extraFiles?: unknown; extraFilesReason?: unknown },
): string[] {
  if (changed === null) {
    return ['could not diff against the base ref (git fetch origin?) — branch purity unverified']
  }
  const ok = new Set(allowed)
  // A PR legitimately grows after IMPLEMENT: VALIDATE and FORCE_FAIL run the
  // whole touched file and surface defects in surfaces the plan had not named
  // (#1422 grew a sidebar-click repair and two pipeline fixes that way, both on
  // the user's explicit decision). The list frozen at IMPLEMENT cannot be
  // re-declared — the step is complete — so the PR step declares the additions
  // WITH a written reason. Unreasoned additions still fail, which is the whole
  // point of #1060's guard: the danger is a file nobody can account for, not a
  // file the author accounts for in writing.
  const extra = Array.isArray(declared?.extraFiles)
    ? declared!.extraFiles.filter((f): f is string => typeof f === 'string')
    : []
  const reason = typeof declared?.extraFilesReason === 'string'
    ? declared.extraFilesReason.trim()
    : ''
  const problems: string[] = []
  if (extra.length > 0 && reason === '') {
    problems.push('evidence.extraFiles needs evidence.extraFilesReason — say why each file belongs to THIS issue')
  }
  const excused = reason === '' ? new Set<string>() : new Set(extra)
  problems.push(...changed
    .filter(f => !ok.has(f) && !excused.has(f))
    .map(f => `branch carries a file the pipeline never touched: ${f} (another session's commit? rebase with --onto — or declare it in evidence.extraFiles with a reason)`))
  // A declaration that names files the branch does not carry is stale, and a
  // stale exemption is the failure mode #1084 was raised about.
  problems.push(...extra
    .filter(f => !changed.includes(f))
    .map(f => `evidence.extraFiles names ${f}, which this branch does not change — drop it`))
  return problems
}

/**
 * A red CI gate must be either fixed or justified in writing on the PR — never
 * merged silently. #1060's E2E job was red for an ambient cause tracked
 * elsewhere; the justification comment is what makes that call reviewable.
 */
export function checkCiVerdict(
  evidence: { ciVerdict?: unknown; justificationCommentUrl?: unknown },
  prCommentUrls: string[],
): string[] {
  const v = evidence.ciVerdict
  if (v !== 'green' && v !== 'ambient-red') {
    return ['evidence.ciVerdict must be "green" (all checks pass) or "ambient-red" (red for a cause outside this PR)']
  }
  if (v === 'green') return []
  const url = evidence.justificationCommentUrl
  if (typeof url !== 'string' || url.trim() === '') {
    return ['ambient-red needs evidence.justificationCommentUrl — comment on the PR naming the cause, the evidence it is ambient, and why merging is still right']
  }
  if (!prCommentUrls.some(c => c === url || c.endsWith(url) || url.endsWith(c))) {
    return [`justificationCommentUrl ${url} is not a comment on this PR`]
  }
  return []
}

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
