import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { BackendAmbient, PwStats, RunClass, RunRecord, TestEntry } from './types.ts'

// ---------- pure, unit-tested ----------

/**
 * Environment failures that say nothing about the spec under test. The
 * backend wedge measured in #1074 (gunicorn kills the single worker 7-10x per
 * shard) drops whatever request is in flight, so any call — most often the
 * `/api/v1/auto_login` in `getAuthToken` — dies on its own timeout.
 */
export const INFRA_SIGNATURES: RegExp[] = [
  /Timeout \d+ms exceeded[\s\S]{0,400}\/api\/v1\/auto_login/,
  /socket hang up/i,
  /ERR_EMPTY_RESPONSE/,
  /ERR_CONNECTION_REFUSED/,
  /ECONNREFUSED/,
  /ECONNRESET/,
]

export function isInfraFailure(message: string): boolean {
  return INFRA_SIGNATURES.some(re => re.test(message))
}

// Walk the report tree collecting every non-passing result's error text.
function collectFailureMessages(node: unknown, out: string[]): void {
  if (Array.isArray(node)) {
    for (const child of node) collectFailureMessages(child, out)
    return
  }
  if (!node || typeof node !== 'object') return
  const n = node as Record<string, unknown>
  // specs before nested suites keeps the messages in source order
  for (const key of ['specs', 'tests', 'suites']) {
    if (n[key]) collectFailureMessages(n[key], out)
  }
  if (Array.isArray(n.results)) {
    for (const r of n.results as Array<Record<string, unknown>>) {
      if (r.status === 'passed' || r.status === 'skipped') continue
      const err = r.error as { message?: string } | undefined
      if (err?.message) out.push(err.message)
      for (const e of (r.errors ?? []) as Array<{ message?: string }>) {
        if (e.message) out.push(e.message)
      }
    }
  }
}

/**
 * Two sources, deliberately separate (#1837).
 *
 * `reportOut` is where the JSON payload is — Playwright's JSON reporter writes
 * it to STDOUT and nowhere else. `fullOutput` is everything the run printed.
 * Handing one concatenated string for both is what broke: `globalSetup` writes
 * its API-drift warning to stderr, so a single route template in it
 * (`PATCH /api/v1/connections/{connection_id}`) moved `lastIndexOf('}')` past
 * the end of the payload and every run came back unparseable, on a run that had
 * in fact succeeded. Measured on the same bytes: stdout alone parsed, stdout +
 * stderr did not. Any future stderr line with a brace would have done it again,
 * which is why the fix separates the inputs rather than sharpening the
 * delimiter — a delimiter fix survives exactly until the next output shape.
 *
 * **Why `fullOutput` stays wider than `reportOut` — and it is NOT the reason
 * the first version of this comment gave.** That version said the fixture
 * writes `🚨 Backend Error` to stderr, so a scan narrowed along with the
 * payload would blank the backend-error gate. Both halves are false and the
 * measurement is the useful part: `fixtures.ts` prints the marker with
 * `console.log`, and under `--reporter=json` nothing a WORKER prints reaches
 * the process streams at all — measured on 1.58.2, `console.log` and
 * `console.error` alike, from a test body and from `afterAll`, are captured
 * into the payload as `results[].stdout` / `.stderr`, with the process stderr
 * coming back 0 bytes. On a real report the stdout-only scan finds the marker
 * anyway. The only writer to the real stderr is the MAIN process
 * (`globalSetup`), which never prints the marker. So the width buys resilience
 * to that changing — a reporter that forwards worker output, a marker printed
 * from a global hook — not the live gate the first version claimed. It costs
 * nothing, so it stays; what does not stay is a justification the code cannot
 * support.
 *
 * `fullOutput` defaults to `reportOut` for callers that legitimately hold one
 * string.
 *
 * **Residual, because "removes the class" is only half true.** `end` was
 * hardened by choosing a stream; `start` is still the FIRST brace of the stream
 * this now trusts, and `globalSetup` prints its preflight lines to STDOUT,
 * ahead of the payload, several of them interpolating a string that came from
 * the backend. Measured, with a brace in one of them:
 * `parsePwJson('[preflight] routed provider ready — model {"name":"x"}\n' +
 * payload)` is null — today's defect with the indices swapped. No preflight
 * line carries a brace today. The fix that does remove the class is to stop
 * scraping a stream at all: `PLAYWRIGHT_JSON_OUTPUT_NAME` writes the report to
 * a file and leaves stdout carrying only the line reporter Playwright then adds
 * by itself (verified on 1.58.2).
 */
export function parsePwJson(reportOut: string, fullOutput: string = reportOut): PwStats | null {
  // Playwright's JSON reporter pretty-prints to stdout, so the payload
  // starts with '{\n  "config"' — never assume compact '{"'. `start` is the
  // first brace on the stream, which is the residual named above.
  const start = reportOut.indexOf('{')
  const end = reportOut.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let data: { stats?: Record<string, number>; suites?: unknown }
  try { data = JSON.parse(reportOut.slice(start, end + 1)) } catch { return null }
  const s = data.stats
  if (!s) return null
  const failureMessages: string[] = []
  collectFailureMessages(data.suites, failureMessages)
  return {
    expected: s.expected ?? 0,
    unexpected: s.unexpected ?? 0,
    flaky: s.flaky ?? 0,
    skipped: s.skipped ?? 0,
    durationMs: Math.round(s.duration ?? 0),
    backendErrors: fullOutput.includes('🚨 Backend Error'),
    backendErrorLines: fullOutput
      .split('\n')
      .filter(l => l.includes('🚨 Backend Error'))
      .map(l => l.trim()),
    failureMessages,
  }
}

/**
 * Split a run into "the spec answered" vs "the environment answered".
 *
 * A run whose every failure carries an infra signature is VOID: it is neither
 * evidence of a defect nor of stability, so the caller re-runs it instead of
 * counting it. Anything else — including a run with no parseable error but a
 * backend-error log — stays a real failure, so the classification can never
 * silence a genuine red.
 */
export function classifyRun(stats: PwStats, ambient?: BackendAmbient): RunClass {
  // Checked FIRST, and ahead of the ambient declaration: an empty run satisfies
  // every green predicate below, so any ordering that reaches them turns
  // "nothing ran" into "nothing failed" (#1593). A declaration excuses a
  // backend error; it can never supply a result that was never produced.
  if (isEvidenceFree(stats)) return 'no-evidence'
  // Both clean verdicts require the spec to have ANSWERED. Without this, a run
  // that executed nothing satisfies each of them on the nose — no unexpected,
  // no flaky — and an ambient declaration turns the empty run into
  // `clean-ambient`, laundering the very absence #1593 is about.
  const answered = executedTests(stats) > 0
  if (answered && stats.unexpected === 0 && stats.flaky === 0 && !stats.backendErrors) return 'clean'
  // A declared ambient backend error counts as clean ONLY when the run is
  // otherwise green AND every logged line matches a declared pattern: one
  // unmatched line keeps the run a real failure, so a declaration can never
  // blanket-silence the monitor the way `allowHttpErrors()` on the spec would
  // (#1084's lesson, applied to the pipeline instead of the fixture).
  if (
    answered && stats.unexpected === 0 && stats.flaky === 0 &&
    ambient && ambient.patterns.length > 0 && ambient.reason.trim() !== '' &&
    stats.backendErrorLines.length > 0 &&
    stats.backendErrorLines.every(l => ambient.patterns.some(p => l.includes(p)))
  ) return 'clean-ambient'
  const msgs = stats.failureMessages
  if (msgs.length > 0 && msgs.every(isInfraFailure)) return 'infra-void'
  return 'real-failure'
}

/** Tests that actually produced a verdict. `skipped` is deliberately not one. */
export function executedTests(stats: PwStats): number {
  return stats.expected + stats.unexpected + stats.flaky
}

/**
 * A run that said nothing at all: no test reached a verdict AND nothing fired.
 *
 * The second half is load-bearing. A run where zero tests executed but the
 * backend monitor DID log — something breaking in globalSetup or a fixture
 * before any test could start — carries a positive signal, and a positive
 * signal outranks the absence of one: it stays a `real-failure`, which also
 * keeps it out of reach of an ambient declaration (that excuses a backend error
 * beside a green run, never a run that never happened).
 */
export function isEvidenceFree(stats: PwStats): boolean {
  return executedTests(stats) === 0
    && !stats.backendErrors
    && stats.failureMessages.length === 0
}

/**
 * The class of a stored run. Records written before infra classification
 * existed carry no `class`, so it is derived — but an EMPTY legacy record
 * derives `no-evidence` rather than `clean`, or the false verdict #1593 names
 * simply moves from the run into the state file. The derivation can only ever
 * cost a phase one more run, never one fewer.
 */
export function classOf(r: RunRecord): RunClass {
  if (r.class) return r.class
  if (isEvidenceFree(r.stats)) return 'no-evidence'
  return r.stats.unexpected === 0 && r.stats.flaky === 0 && !r.stats.backendErrors
    ? 'clean'
    : 'real-failure'
}

/** A run counts toward a burst — or as a phase's green run — when the spec answered green. */
export function countsAsClean(r: RunRecord): boolean {
  const c = classOf(r)
  return c === 'clean' || c === 'clean-ambient'
}

const TEST_RE =
  /(?<![\w.$])test(\.only|\.fixme|\.fail|\.skip)?\s*\(\s*(['"`])([\s\S]*?)\2\s*,/g

/**
 * Title, modifier and tags of every `test(...)` in a spec file. Tags are read
 * from the options object between the title and the callback, so a quarantine
 * (`test.fixme`) and a missing `@stable` are both machine-checkable.
 */
export function enumerateTestEntries(source: string): TestEntry[] {
  const entries: TestEntry[] = []
  for (const m of source.matchAll(TEST_RE)) {
    const after = source.slice(m.index + m[0].length)
    // The options object always precedes the callback; stop at the callback so
    // the NEXT test's tags can never be attributed to this one.
    const stop = after.search(/async\s*\(|\(\s*\{|\(\s*\)\s*=>/)
    const head = after.slice(0, stop === -1 ? 300 : stop)
    const tagBlock = head.match(/tag:\s*\[([^\]]*)\]/)
    const tags = tagBlock
      ? [...tagBlock[1].matchAll(/['"`]([^'"`]+)['"`]/g)].map(t => t[1])
      : []
    entries.push({ title: m[3], modifier: m[1] ?? '', tags })
  }
  return entries
}

// Unchanged contract: an unconditionally skipped test is not in play, so it
// stays out of the burst/report enumeration (a quarantined `.fixme` still
// shows up — the quarantine gate needs to see it).
export function enumerateTests(source: string): string[] {
  return enumerateTestEntries(source).filter(e => e.modifier !== '.skip').map(e => e.title)
}

/**
 * Titles a force-fail can actually be run against. A `test.fixme`/`test.skip`
 * never executes, so requiring a red run for it would deadlock FORCE_FAIL.
 */
export function enumerateRunnableTests(source: string): string[] {
  return enumerateTestEntries(source)
    .filter(e => e.modifier !== '.fixme' && e.modifier !== '.skip')
    .map(e => e.title)
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

export function ghPrView(url: string): { body: string; commentUrls: string[] } {
  const r = sh('gh', ['pr', 'view', url, '--json', 'body,comments'])
  if (r.code !== 0) throw new Error(`gh pr view failed: ${r.stderr}`)
  const j = JSON.parse(r.stdout)
  return {
    body: (j.body ?? '') as string,
    commentUrls: ((j.comments ?? []) as Array<{ url?: string }>)
      .map(c => c.url).filter((u): u is string => typeof u === 'string'),
  }
}

/**
 * Which stream feeds which reader — a pure function so the decision is covered
 * by a test on its output rather than living in the subprocess wrapper, where
 * nothing could reach it (#1837; the shape #1226 argues for). Reverting it to
 * one concatenated input fails `pwRunResult reads the report from stdout`
 * instead of passing the whole lane.
 */
export function pwRunResult(stdout: string, stderr: string): { stats: PwStats | null; raw: string } {
  const raw = stdout + '\n' + stderr
  return { stats: parsePwJson(stdout, raw), raw }
}

export function runPlaywright(args: string[]): { stats: PwStats | null; code: number; raw: string } {
  const r = sh('npx', ['playwright', 'test', ...args, '--reporter=json'])
  return { ...pwRunResult(r.stdout, r.stderr), code: r.code }
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
  // Tracked modifications AND untracked new files — a new-spec issue's
  // .spec.ts is untracked until the PR, and `git diff HEAD` alone misses it
  // (which silently skipped the VALIDATE burst and FF enumeration).
  const diff = sh('git', ['diff', '--name-only', 'HEAD']).stdout
  const untracked = sh('git', ['ls-files', '--others', '--exclude-standard']).stdout
  return filterScoutSpecs([...new Set((diff + '\n' + untracked).split('\n').filter(Boolean))])
    // DELETED paths are in `git diff` too, and a consolidation issue legitimately
    // deletes a duplicated spec (#938). They are not runnable targets: the burst,
    // the FF enumeration and the REPORT skeleton all read the file, which threw
    // ENOENT and blocked the phase. A deleted spec has no test() to run or
    // force-fail, so dropping it weakens no gate.
    .filter(f => existsSync(f))
}

// Throwaway scout specs (live-DOM harvesting during PLAN) are never burst
// targets — issue #491's run auto-picked a leftover scout-491b-tmp.spec.ts
// and burned a burst cycle on it.
export function filterScoutSpecs(files: string[]): string[] {
  return files.filter(f => !/(^|\/)scout[^/]*\.spec\.ts$/i.test(f) && !/-tmp\.spec\.ts$/i.test(f))
}

/**
 * Files the branch changed relative to its base — the input to the PR purity
 * gate. Returns null when the base ref cannot be resolved, so the gate can
 * fail closed instead of reading "nothing extra".
 */
export function gitChangedVsBase(base = 'origin/main'): string[] | null {
  const r = sh('git', ['diff', '--name-only', `${base}..HEAD`])
  if (r.code !== 0) return null
  return r.stdout.split('\n').filter(Boolean)
}

export function ghRunArtifactName(repo: string, runId: string): string | null {
  const r = sh('gh', ['api', `repos/${repo}/actions/runs/${runId}/artifacts`,
    '--jq', '.artifacts[].name'])
  if (r.code !== 0) return null
  return r.stdout.split('\n').filter(Boolean).find(n => /playwright-json/.test(n)) ?? null
}

export function ghRunDownload(repo: string, runId: string, name: string, dir: string): boolean {
  return sh('gh', ['run', 'download', runId, '--repo', repo, '-n', name, '-D', dir]).code === 0
}

export function gitIsDirty(path: string): boolean {
  return sh('git', ['status', '--porcelain', '--', path]).stdout.trim() !== ''
}

export function gitDiffOf(path: string): string {
  // For untracked files `git diff HEAD -- <path>` is empty; diff against
  // /dev/null so mutation markers (FF-MUTATION) are still detectable.
  const tracked = sh('git', ['diff', 'HEAD', '--', path]).stdout
  if (tracked) return tracked
  const untracked = sh('git', ['ls-files', '--others', '--exclude-standard', '--', path]).stdout
  if (!untracked.trim()) return ''
  return sh('git', ['diff', '--no-index', '--', '/dev/null', path]).stdout
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
