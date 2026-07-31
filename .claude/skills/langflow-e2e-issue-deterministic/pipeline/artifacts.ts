/**
 * Reading a daily run's own artifact is the highest-signal step of a
 * daily-failure investigation: the `playwright-json-daily-<run>` blob carries
 * every attempt's status, duration and error, which is what separates a real
 * defect from an environment abort (#1060: the `unknown` signature on one row
 * turned out to be #1030's auto_login timeout, and the flaky row's error named
 * the stale context_id outright).
 *
 * The summarizer is pure so the shape of a run report can be unit-tested; the
 * download lives in runners.ts.
 */

interface AttemptLike {
  retry?: number
  status?: string
  duration?: number
  error?: { message?: string }
}

interface TestLike {
  projectName?: string
  status?: string
  results?: AttemptLike[]
}

interface SpecLike {
  title?: string
  file?: string
  line?: number
  tests?: TestLike[]
  specs?: SpecLike[]
  suites?: SpecLike[]
}

export function firstLines(message: string, max = 3): string {
  return message
    // eslint-disable-next-line no-control-regex
    .replace(/\[[0-9;]*m/g, '')
    .split('\n')
    .filter(l => l.trim() !== '')
    .slice(0, max)
    .join(' ⏎ ')
}

function walk(node: SpecLike | undefined, out: SpecLike[]): void {
  if (!node) return
  for (const s of node.specs ?? []) {
    if (s.tests) out.push(s)
    walk(s, out)
  }
  for (const s of node.suites ?? []) walk(s, out)
}

/**
 * One block per matching test: its file:line, then one line per attempt with
 * status, duration and the head of the error. `filter` is a case-insensitive
 * substring matched against the test title — pass the failing title from the
 * issue to cut the report down to the rows under investigation.
 */
export function summarizeRunArtifact(raw: string, filter?: string): string[] {
  let data: { suites?: SpecLike[] }
  try { data = JSON.parse(raw) } catch { return ['✖ artifact is not valid JSON'] }
  const specs: SpecLike[] = []
  for (const s of data.suites ?? []) walk(s, specs)

  const needle = filter?.toLowerCase()
  const matched = specs.filter(s => !needle || (s.title ?? '').toLowerCase().includes(needle))
  if (matched.length === 0) {
    return [filter ? `no test matching "${filter}" in the artifact` : 'artifact contains no tests']
  }

  const lines: string[] = []
  for (const spec of matched) {
    for (const t of spec.tests ?? []) {
      lines.push(`${spec.file ?? '?'}:${spec.line ?? '?'} [${t.projectName ?? 'default'}] ${spec.title ?? '?'} → ${t.status ?? '?'}`)
      for (const r of t.results ?? []) {
        const secs = Math.round((r.duration ?? 0) / 1000)
        lines.push(`  attempt ${r.retry ?? 0}: ${r.status ?? '?'} (${secs}s)`)
        if (r.error?.message) lines.push(`    ${firstLines(r.error.message)}`)
      }
    }
  }
  return lines
}
