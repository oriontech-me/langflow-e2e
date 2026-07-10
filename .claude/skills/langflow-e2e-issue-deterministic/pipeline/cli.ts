import * as fs from 'node:fs'
import type { FFEntry, Phase, PipelineState, PwStats } from './types.ts'
import {
  initState, loadState, saveState, ensureStep, completeStep, escalateToDebug,
  setType, abortState, metricsOf, listStates, spineFor, TERMINAL, now,
} from './state.ts'
import { classify, detectBodyFormat } from './classify.ts'
import {
  ghIssueView, ghAssignSelf, ghPrView, runPlaywright, npmRun, gitCurrentBranch,
  gitDiffNames, gitDiffOf, enumerateTests, getInstanceVersion, getLatestNightlyTag, sh,
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
        if (!run.stats) { saveState(s); fail(`could not parse playwright JSON for ${t}`) }
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

  if (step === 'VALIDATE') {
    const ev = (rec?.evidence ?? {}) as {
      runs?: Array<{ target: string; stats: PwStats }>; typecheck?: number; lint?: number; qaDiff?: string[]
    }
    const runs = ev.runs ?? []
    for (const target of touchedSpecFiles()) {
      const greens = runs.filter(r =>
        r.target === target && r.stats.unexpected === 0 && r.stats.flaky === 0 && !r.stats.backendErrors)
      if (greens.length < BURST) {
        problems.push(`need ${BURST} clean --retries=0 runs for ${target}; have ${greens.length} (run next again)`)
      }
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
        const { body } = ghPrView(evidence.prUrl)
        problems.push(...checkPrReadiness({
          branch: gitCurrentBranch(), prBody: body, issue: s.issue,
          isWave: s.issueData?.milestone != null,
          labels: s.issueData?.labels ?? [],
        }))
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
    fail('usage: cli.ts <next|complete|escalate|ff-run|status|abort|metrics|authorize-pr> <issue> [step] [--flags]')
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
