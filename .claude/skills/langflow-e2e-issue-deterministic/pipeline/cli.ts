import * as fs from 'node:fs'
import * as path from 'node:path'
import type {
  BackendAmbient, FFEntry, Phase, PipelineState, PwStats, ReproRate, RunRecord,
} from './types.ts'
import {
  initState, loadState, saveState, ensureStep, completeStep, escalateToDebug,
  setType, abortState, metricsOf, listStates, spineFor, TERMINAL, now,
} from './state.ts'
import { classify, detectBodyFormat } from './classify.ts'
import { makeTempDir } from '../../../../scripts/lib/tmp-dir.mjs'
import {
  ghIssueView, ghAssignSelf, ghPrView, runPlaywright, npmRun, gitCurrentBranch,
  gitDiffNames, gitDiffOf, enumerateTests, enumerateTestEntries, enumerateRunnableTests,
  getInstanceVersion, getLatestNightlyTag, sh, classifyRun, classOf, countsAsClean,
  gitChangedVsBase, gitIsDirty, ghRunArtifactName, ghRunDownload,
} from './runners.ts'
import {
  checkSpecDoc, checkQaDiff, checkForceFailCoverage, checkNoMutationMarkers,
  checkPrReadiness, checkQuarantineLifted, checkDebugEvidence, checkBranchPurity,
  checkCiVerdict, symptomsOwnedElsewhere, checkFinalGreenCoverage, finalGreenTargets,
} from './gates.ts'
import { summarizeRunArtifact } from './artifacts.ts'
import { instructionFor } from './instructions.ts'

const REPO = 'oriontech-me/langflow-e2e'
const EXCEPTION_LABELS = ['daily-failure', 'community', 'follow-up']
export const RESERVED_KEYS = [
  'runs', 'typecheck', 'lint', 'nightly', 'qaDiff', 'ff', 'finalGreen',
  'finalGreenRuns', 'reproRate', 'artifactRuns',
]
const BURST = Number(process.env.PIPELINE_BURST ?? 3)
// A wedged backend can void several runs in a row (#1074: the worker is killed
// 7-10x per shard). Past this many, the environment — not the spec — is the
// blocker, and the phase says so instead of burning the whole afternoon.
const MAX_INFRA_VOIDS = Number(process.env.PIPELINE_MAX_INFRA_VOIDS ?? 3)

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

/**
 * Run a spec, classifying infra aborts as void and retrying them, so a wedged
 * backend never masquerades as a spec verdict. Returns the classified runs;
 * the caller decides what a clean/failed run means for its phase.
 */
function runUntilClean(
  args: string[], target: string, needed: number, existing: RunRecord[], notes: string[],
  ambient?: BackendAmbient,
): { records: RunRecord[]; voids: number; realFailure: boolean; noEvidence: boolean } {
  const records: RunRecord[] = []
  let voids = existing.filter(r => r.target === target && classOf(r) === 'infra-void').length
  let clean = existing.filter(r => r.target === target && countsAsClean(r)).length
  while (clean < needed) {
    const run = runPlaywright(args)
    if (!run.stats) throw new Error(`could not parse playwright JSON for ${target}`)
    const cls = classifyRun(run.stats, ambient)
    records.push({ target, stats: run.stats, class: cls })
    notes.push(`run ${clean + 1}/${needed} ${target}: ${cls} expected=${run.stats.expected} unexpected=${run.stats.unexpected} flaky=${run.stats.flaky} backendErrors=${run.stats.backendErrors} skipped=${run.stats.skipped}`)
    // Deterministic, so retrying is pointless: return and let the caller name
    // the cause. Counting it clean is the #1593 trap; retrying it would spin.
    if (cls === 'no-evidence') return { records, voids, realFailure: false, noEvidence: true }
    if (cls === 'clean') { clean++; continue }
    if (cls === 'clean-ambient') {
      clean++
      notes.push(`  ↳ counted clean: every backend error matched a declared ambient pattern — ${ambient?.reason ?? ''}`)
      continue
    }
    if (cls === 'infra-void') {
      voids++
      notes.push(`  ↳ voided: every failure carries an environment signature (auto_login/socket hang up/connection) — not counted, re-running`)
      if (voids >= MAX_INFRA_VOIDS) return { records, voids, realFailure: false, noEvidence: false }
      continue
    }
    return { records, voids, realFailure: true, noEvidence: false }
  }
  return { records, voids, realFailure: false, noEvidence: false }
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

/**
 * Files this pipeline legitimately produced: whatever SPECIFY and IMPLEMENT
 * recorded, plus the checklist bullet every spec change edits. Anything else
 * on the branch came from somewhere the pipeline never went.
 */
export function allowedBranchFiles(s: PipelineState): string[] {
  const spec = s.steps.SPECIFY?.evidence as {
    specDoc?: string; existingSpec?: string; affectedSpecs?: string[]
  } | undefined
  const impl = s.steps.IMPLEMENT?.evidence as { files?: string[] } | undefined
  return [...new Set([
    ...(spec?.specDoc ? [spec.specDoc] : []),
    ...(spec?.existingSpec ? [spec.existingSpec] : []),
    ...(spec?.affectedSpecs ?? []),
    ...(impl?.files ?? []),
    'QA-CHECKLIST.md',
  ])]
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
    const labelsLower = data.labels.map(l => l.toLowerCase())
    if (labelsLower.includes('community')) {
      const order = ['high', 'medium', 'low priority']
      const idx = order.findIndex(sev => labelsLower.includes(sev))
      if (idx === -1) {
        notes.push('community issue has no severity label — severity-order check skipped')
      } else {
        for (const sev of order.slice(0, idx)) {
          const r = sh('gh', ['issue', 'list', '--repo', REPO, '--label', 'community',
            '--label', sev, '--state', 'open', '--json', 'number'])
          if (r.code !== 0) throw new Error(`gh issue list failed: ${r.stderr}`)
          const nums = (JSON.parse(r.stdout) as Array<{ number: number }>)
            .map(x => x.number).filter(n => n !== s.issue)
          if (nums.length > 0) {
            fail(`work community issues in severity order — ROADMAP.md → Intake (open ${sev} first: ${nums.map(n => '#' + n).join(', ')})`)
          }
        }
        notes.push(`community severity order ok (${order[idx]}, no open higher-severity issues)`)
      }
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
      runs?: RunRecord[]
      typecheck?: number; lint?: number; nightly?: Record<string, string | null>
      qaDiff?: string[]
      backendAmbient?: BackendAmbient
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
    // A declared-ambient backend error, with its written reason (#1422). The
    // pair is stored in the evidence so the PR can quote what was excused, and
    // a pattern without a reason is refused rather than obeyed.
    if (flags['ambient-backend'] !== undefined) {
      const patterns = flags['ambient-backend'].split('|').map(x => x.trim()).filter(Boolean)
      const reason = (flags['ambient-reason'] ?? '').trim()
      if (patterns.length === 0) fail('--ambient-backend needs at least one non-empty pattern')
      if (reason === '') fail('--ambient-backend requires --ambient-reason "<why this is not the issue\'s defect>"')
      ev.backendAmbient = { patterns, reason }
    }
    const ambient = ev.backendAmbient
    const targets = flags.spec ? [flags.spec]
      : flags.grep ? [`--grep:${flags.grep}`]
      : touchedSpecFiles()
    for (const t of targets) {
      const args = t.startsWith('--grep:')
        ? ['--grep', t.slice(7), '--retries=0', '--workers=1']
        : [t, '--retries=0', '--workers=1']
      let outcome
      try {
        outcome = runUntilClean(args, t, BURST, ev.runs, notes, ambient)
      } catch (e) {
        saveState(s)
        fail(e instanceof Error ? e.message : String(e))
      }
      ev.runs.push(...outcome.records)
      if (outcome.noEvidence) {
        saveState(s)
        const last = outcome.records[outcome.records.length - 1]?.stats
        fail(`${t} executed NOTHING (expected=0 unexpected=0 flaky=0 skipped=${last?.skipped ?? 0}) — that is not a clean run, it is no run at all (#1593). `
          + (last?.skipped
            ? `Every test skipped: a runtime test.skip() gate is unmet (missing provider key, unmet lane precondition).`
            : `Zero tests were selected: a lane-selected spec needs its lane flag (PW_SERVING_IDENTITY / PW_ENTERPRISE / PW_DESTRUCTIVE — playwright.config.ts grepInverts them and a CLI --grep cannot widen it), or the --grep matched nothing.`))
      }
      if (outcome.voids >= MAX_INFRA_VOIDS) {
        saveState(s)
        fail(`${outcome.voids} runs of ${t} aborted on environment signatures (auto_login timeout / socket hang up / connection refused) — the instance is the blocker, not the spec. Restart it (see langflow-e2e → nightly) and run next again; these runs are recorded as void, not as failures.`)
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
    const ev = rec.evidence as {
      ff?: FFEntry[]; finalGreen?: PwStats; finalGreenRuns?: RunRecord[]
    }
    ev.ff ??= []
    // Per-file green runs, accumulated across invocations. Legacy state carries
    // only the single `finalGreen` slot, which cannot say WHICH file it covered,
    // so such a pipeline re-runs them — one extra run per file, never one fewer.
    ev.finalGreenRuns ??= []
    // A test.fixme/test.skip never executes, so demanding a red run for it
    // would deadlock the phase — only runnable titles are required.
    const required = touchedSpecFiles().map(f => ({
      file: f, titles: enumerateRunnableTests(fs.readFileSync(f, 'utf8')),
    }))
    const missing = checkForceFailCoverage(required, ev.ff)
    const dirty = checkNoMutationMarkers(
      touchedSpecFiles().map(f => ({ file: f, diff: gitDiffOf(f) })))
    notes.push(`FF coverage: ${missing.length === 0 ? 'complete' : missing.join('; ')}`)
    notes.push(dirty.length ? dirty.join('; ') : 'no FF-MUTATION markers in diff ✓')
    // The ambient declaration VALIDATE ran under applies here too (#1422): the
    // final green run is the same spec on the same instance, so honouring it in
    // one phase and not the other leaves FORCE_FAIL unclosable for a reason
    // VALIDATE already examined and wrote down.
    const ffAmbient = (s.steps.VALIDATE?.evidence as { backendAmbient?: BackendAmbient })
      ?.backendAmbient
    if (missing.length === 0 && dirty.length === 0) {
      const files = required.map(r => r.file)
      // Only what is still missing a green run, so a re-invocation banks
      // progress instead of redoing it — and `--spec` narrows to ONE file so it
      // can be measured on the instance that file needs (#1593). Records from
      // every invocation accumulate, exactly as VALIDATE's burst already does.
      const selection = finalGreenTargets(files, ev.finalGreenRuns, flags.spec)
      if (selection.problem) fail(selection.problem)
      for (const file of selection.targets) {
        let outcome
        try {
          outcome = runUntilClean(
            [file, '--retries=0', '--workers=1'], file, 1, ev.finalGreenRuns, notes, ffAmbient)
        } catch (e) {
          saveState(s)
          fail(e instanceof Error ? e.message : String(e))
        }
        // Banked BEFORE any exit path: a green run already measured must not be
        // discarded because a later file failed, or a four-instance issue can
        // never converge.
        ev.finalGreenRuns.push(...outcome.records)
        const last = outcome.records[outcome.records.length - 1]?.stats
        // `finalGreen` is no longer what the gate reads — `finalGreenRuns` is —
        // but it stays written as the human-readable "last green run" summary a
        // reviewer opening the state file looks for, and keeps the evidence
        // shape unchanged for anything that already parsed it.
        if (last) ev.finalGreen = last
        saveState(s)
        if (outcome.noEvidence) {
          fail(`final green run for ${file} executed NOTHING (expected=0, skipped=${last?.skipped ?? 0}) — not a green run (#1593). `
            + `A lane-selected spec needs its lane flag set (PW_SERVING_IDENTITY / PW_ENTERPRISE / PW_DESTRUCTIVE); `
            + `playwright.config.ts grepInverts those tags and a CLI --grep cannot widen it.`)
        }
        if (outcome.voids >= MAX_INFRA_VOIDS) {
          fail(`final green run for ${file} kept aborting on environment signatures — restart the instance and run next again`)
        }
        if (outcome.realFailure) fail(`final green run failed for ${file} after FF reverts`)
      }
      const stillMissing = checkFinalGreenCoverage(files, ev.finalGreenRuns)
      notes.push(stillMissing.length === 0
        ? `final green run after reverts ✓ (${files.length} file(s))`
        : stillMissing.join('; '))
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

async function gateFor(s: PipelineState, step: Phase, evidence: Record<string, unknown>): Promise<string[]> {
  const problems: string[] = []
  const rec = s.steps[step]

  if (step === 'CLASSIFY') {
    if (!s.type && typeof evidence.type === 'string') {
      if (typeof evidence.justification !== 'string') problems.push('claude classification needs justification')
      else setType(s, evidence.type as never, 'claude', evidence.justification)
    }
    if (!s.type && !evidence.type) problems.push('no type: heuristic failed and none supplied')
  }

  if (step === 'SPECIFY' && s.type === 'file-watcher') {
    const specs = evidence.affectedSpecs
    if (!Array.isArray(specs) || specs.length === 0) {
      problems.push('evidence.affectedSpecs must be a non-empty array of spec files (from the issue\'s --grep table)')
    }
    if (evidence.userConfirmed !== true) {
      problems.push('evidence.userConfirmed must be true — confirm the affected specs with the user first')
    }
  } else if (step === 'SPECIFY') {
    const doc = evidence.specDoc
    if (typeof doc !== 'string' || !fs.existsSync(doc)) {
      problems.push(`evidence.specDoc missing or not found: ${doc}`)
    } else {
      const instance = await getInstanceVersion(process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:7860')
      const versionSource = instance ?? process.env.PIPELINE_RELEASE_CYCLE ?? null
      if (versionSource === null) {
        problems.push('could not resolve instance version — set PIPELINE_RELEASE_CYCLE or start the Langflow instance')
      } else {
        problems.push(...checkSpecDoc(fs.readFileSync(doc, 'utf8'), releaseCycleOf(versionSource)))
      }
    }
    if (evidence.userConfirmed !== true) {
      problems.push('evidence.userConfirmed must be true — confirm the spec doc with the user first')
    }
  }

  if (step === 'DEBUG') {
    const reproRate = (rec?.evidence as { reproRate?: ReproRate } | undefined)?.reproRate
    problems.push(...checkDebugEvidence({
      issueBody: s.issueData?.body ?? '',
      labels: s.issueData?.labels ?? [],
      verdict: evidence.verdict,
      summary: evidence.summary,
      decision: evidence.decision,
      symptoms: evidence.symptoms,
      reproRate,
      mechanismProof: evidence.mechanismProof,
    }))
  }

  if (step === 'VALIDATE') {
    const ev = (rec?.evidence ?? {}) as {
      runs?: RunRecord[]; typecheck?: number; lint?: number; qaDiff?: string[]
    }
    const runs = ev.runs ?? []
    for (const target of touchedSpecFiles()) {
      // Same predicate the burst counts with (#1422): a run whose only backend
      // error was declared ambient, with a written reason, is a clean run here
      // too — counting it in one place and not the other is how the phase could
      // never close on evidence it had already accepted.
      const greens = runs.filter(r => r.target === target && countsAsClean(r))
      const voids = runs.filter(r => r.target === target && classOf(r) === 'infra-void')
      if (greens.length < BURST) {
        const voidNote = voids.length ? ` (${voids.length} run(s) voided on environment signatures)` : ''
        problems.push(`need ${BURST} clean --retries=0 runs for ${target}; have ${greens.length}${voidNote} (run next again)`)
      }
    }
    problems.push(...checkQuarantineLifted(
      s.issueData?.body ?? '',
      touchedSpecFiles().map(f => ({ file: f, entries: enumerateTestEntries(fs.readFileSync(f, 'utf8')) })),
    ))
    if (ev.typecheck !== 0) problems.push(`typecheck exit=${ev.typecheck}`)
    if (ev.lint !== 0) problems.push(`lint exit=${ev.lint}`)
    if ((ev.qaDiff ?? []).length > 0) problems.push(...ev.qaDiff!)
  }

  if (step === 'FORCE_FAIL') {
    const ev = (rec?.evidence ?? {}) as {
      ff?: FFEntry[]; finalGreen?: PwStats; finalGreenRuns?: RunRecord[]
    }
    const required = touchedSpecFiles().map(f => ({
      file: f, titles: enumerateRunnableTests(fs.readFileSync(f, 'utf8')),
    }))
    problems.push(...checkForceFailCoverage(required, ev.ff ?? []))
    problems.push(...checkNoMutationMarkers(
      touchedSpecFiles().map(f => ({ file: f, diff: gitDiffOf(f) }))))
    // Per FILE, not one flag for the whole phase (#1593): the old check closed
    // on any single green run, which is both too weak (one file's green stood
    // for all of them) and unreachable for a multi-instance issue.
    problems.push(...checkFinalGreenCoverage(required.map(r => r.file), ev.finalGreenRuns ?? []))
  }

  if (step === 'AWAIT_PR_AUTH') {
    if (!s.prAuth?.quote) {
      problems.push('PR not authorized — record the user\'s explicit authorization via authorize-pr first')
    }
  }

  if (step === 'DISPATCH') {
    const created = evidence.createdIssues
    if (!Array.isArray(created) || created.length === 0) {
      problems.push('evidence.createdIssues must list the dedicated issues opened')
    }
  }

  if (step === 'PR') {
    if (typeof evidence.prUrl !== 'string') {
      problems.push('evidence.prUrl required')
    } else {
      try {
        const { body, commentUrls } = ghPrView(evidence.prUrl)
        problems.push(...checkPrReadiness({
          branch: gitCurrentBranch(), prBody: body, issue: s.issue,
          isWave: s.issueData?.milestone != null,
          labels: s.issueData?.labels ?? [],
        }))
        // `evidence` is the payload being recorded by THIS call; `rec.evidence`
        // is what a previous attempt left behind. Reading the stale one meant a
        // declaration could never be accepted on the attempt that made it.
        problems.push(...checkBranchPurity(
          gitChangedVsBase(), allowedBranchFiles(s),
          evidence as { extraFiles?: unknown; extraFilesReason?: unknown }))
        problems.push(...checkCiVerdict(evidence, commentUrls))
        // A symptom another issue owns must be visible to the reviewer, or the
        // PR reads as if it closed a cause it never touched.
        for (const owner of symptomsOwnedElsewhere(
          (s.steps.DEBUG?.evidence as { symptoms?: unknown } | undefined)?.symptoms)) {
          if (!body.includes(owner)) {
            problems.push(`symptom owned by ${owner} is not referenced in the PR body — say which row belongs there and why it is not fixed here`)
          }
        }
      } catch (e) {
        problems.push(e instanceof Error ? e.message : String(e))
      }
    }
  }

  return problems
}

// ---------- commands ----------

async function main() {
  const { command, issue, step, flags, evidence } = parseArgs(process.argv.slice(2))
  if (!command || Number.isNaN(issue)) {
    fail('usage: cli.ts <next|complete|escalate|ff-run|repro-run|artifacts|status|abort|metrics|authorize-pr> <issue> [step] [--flags]')
  }

  if (command === 'next') {
    const s = loadState(issue) ?? initState(issue, REPO)
    guardBranchOwnership(s)
    guardSpecFirst(s)
    if (TERMINAL.includes(s.phase)) {
      console.log(`— issue #${issue} · phase ${s.phase} · type ${s.type ?? '?'} —`)
      console.log('\n' + instructionFor(s))
      return
    }
    const notes = await mechanicalFor(s, flags)
    saveState(s)
    console.log(`— issue #${issue} · phase ${s.phase} · type ${s.type ?? '?'} —`)
    for (const line of notes) console.log(line)
    console.log('\n' + instructionFor(s))
    return
  }

  if (command === 'complete') {
    const s = load(issue)
    guardBranchOwnership(s)
    guardSpecFirst(s)
    if (!step) fail('complete needs a step name')
    if (step !== s.phase) fail(`expected "${s.phase}", got "${step}"`)
    const clean = sanitizeEvidence(evidence)
    const problems = await gateFor(s, step as Phase, clean)
    if (problems.length > 0) {
      saveState(s)
      fail(`gate failed for ${step}:\n  - ${problems.join('\n  - ')}`)
    }
    completeStep(s, step as Phase, clean)
    if (s.type === 'file-watcher' && step === 'REPORT' && gitDiffNames().length === 0) {
      s.phase = 'DONE'
      s.finishedAt = now()
      console.log('note: no drift — close the issue, nothing to PR')
    }
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
    guardBranchOwnership(s)
    if (s.phase !== 'FORCE_FAIL') fail(`ff-run only valid in FORCE_FAIL (now: ${s.phase})`)
    const { file, test: title, mutation } = flags
    if (!file || !title || !mutation) fail('ff-run needs --file --test --mutation')
    if (!gitDiffOf(file).includes('FF-MUTATION')) {
      fail(`diff of ${file} has no "// FF-MUTATION" marker — add it to the mutation first`)
    }
    const escapedTitle = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const run = runPlaywright([file, '--grep', escapedTitle, '--retries=0', '--workers=1'])
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

  if (command === 'repro-run') {
    const s = load(issue)
    guardBranchOwnership(s)
    if (s.phase !== 'DEBUG') fail(`repro-run only valid in DEBUG (now: ${s.phase})`)
    const spec = flags.spec
    if (!spec) fail('repro-run needs --spec <path> [--grep "<title>"] [--runs N]')
    if (!fs.existsSync(spec)) fail(`spec not found: ${spec}`)
    // The point of this measurement is the rate BEFORE the fix. Measuring a
    // patched spec proves nothing about the defect it is supposed to expose.
    if (gitIsDirty(spec) && flags['allow-dirty'] === undefined) {
      fail(`${spec} already has local changes — repro-run measures the PRE-fix baseline. Stash the fix, or pass --allow-dirty '' if the change cannot affect the measured behavior.`)
    }
    const total = Number(flags.runs ?? 10)
    const args = [spec, '--retries=0', '--workers=1']
    if (flags.grep) args.push('--grep', flags.grep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    let failures = 0, voids = 0
    const signatures: string[] = []
    for (let i = 1; i <= total; i++) {
      const run = runPlaywright(args)
      if (!run.stats) fail(`could not parse playwright JSON on run ${i}`)
      const cls = classifyRun(run.stats)
      if (cls === 'infra-void') voids++
      else if (cls === 'real-failure') {
        failures++
        const first = run.stats.failureMessages[0]
        if (first) signatures.push(first.split('\n')[0].slice(0, 200))
      }
      console.log(`repro ${i}/${total}: ${cls} (unexpected=${run.stats.unexpected} flaky=${run.stats.flaky} ${Math.round(run.stats.durationMs / 1000)}s)`)
    }
    const rec = ensureStep(s, 'DEBUG')
    const ev = rec.evidence as { reproRate?: ReproRate }
    ev.reproRate = {
      spec, grep: flags.grep, runs: total, failures, voids,
      signatures: [...new Set(signatures)], at: now(),
    }
    saveState(s)
    const pct = total > 0 ? Math.round((failures / total) * 100) : 0
    console.log(`✔ baseline recorded: ${failures}/${total} failed (${pct}%), ${voids} voided on environment signatures`)
    if (failures === 0) {
      console.log('note: the defect never reproduced — either raise --runs or prove the mechanism another way and pass evidence.mechanismProof at complete DEBUG.')
    }
    return
  }

  if (command === 'artifacts') {
    const s = load(issue)
    const runId = flags.run
    if (!runId) fail('artifacts needs --run <workflow-run-id> [--filter "<test title>"]')
    const name = ghRunArtifactName(REPO, runId)
    if (!name) fail(`no playwright-json artifact on run ${runId} (expired, or the run produced none)`)
    // Not a test, so the guard in `tmp-dir.test.mjs` does not cover this — but it
    // is the same leak: the artifact is downloaded, one JSON is read out of it, and
    // the directory used to stay behind for good (#1732).
    const dir = makeTempDir(`pipeline-${issue}-`)
    if (!ghRunDownload(REPO, runId, name, dir)) fail(`gh run download failed for artifact ${name}`)
    const file = fs.readdirSync(dir).find(f => f.endsWith('.json'))
    if (!file) fail(`artifact ${name} contains no .json`)
    const lines = summarizeRunArtifact(fs.readFileSync(path.join(dir, file), 'utf8'), flags.filter)
    for (const l of lines) console.log(l)
    const rec = ensureStep(s, s.phase === 'DEBUG' ? 'DEBUG' : s.phase)
    const ev = rec.evidence as { artifactRuns?: string[] }
    ev.artifactRuns = [...new Set([...(ev.artifactRuns ?? []), runId])]
    saveState(s)
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
    guardBranchOwnership(s)
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
