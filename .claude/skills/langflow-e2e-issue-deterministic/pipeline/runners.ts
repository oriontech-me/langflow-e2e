import { spawnSync } from 'node:child_process'
import type { PwStats } from './types.ts'

// ---------- pure, unit-tested ----------

export function parsePwJson(raw: string): PwStats | null {
  // Playwright's JSON reporter pretty-prints to stdout, so the payload
  // starts with '{\n  "config"' — never assume compact '{"'.
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let data: { stats?: Record<string, number> }
  try { data = JSON.parse(raw.slice(start, end + 1)) } catch { return null }
  const s = data.stats
  if (!s) return null
  return {
    expected: s.expected ?? 0,
    unexpected: s.unexpected ?? 0,
    flaky: s.flaky ?? 0,
    skipped: s.skipped ?? 0,
    durationMs: Math.round(s.duration ?? 0),
    backendErrors: raw.includes('🚨 Backend Error'),
  }
}

const TEST_RE = /(?<![\w.$])test(?:\.only|\.fixme|\.fail)?\s*\(\s*(['"`])([\s\S]*?)\1\s*,/g

export function enumerateTests(source: string): string[] {
  return [...source.matchAll(TEST_RE)].map(m => m[2])
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

export function ghPrView(url: string): { body: string } {
  const r = sh('gh', ['pr', 'view', url, '--json', 'body'])
  if (r.code !== 0) throw new Error(`gh pr view failed: ${r.stderr}`)
  const j = JSON.parse(r.stdout)
  return { body: (j.body ?? '') as string }
}

export function runPlaywright(args: string[]): { stats: PwStats | null; code: number; raw: string } {
  const r = sh('npx', ['playwright', 'test', ...args, '--reporter=json'])
  const raw = r.stdout + '\n' + r.stderr
  return { stats: parsePwJson(raw), code: r.code, raw }
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
}

// Throwaway scout specs (live-DOM harvesting during PLAN) are never burst
// targets — issue #491's run auto-picked a leftover scout-491b-tmp.spec.ts
// and burned a burst cycle on it.
export function filterScoutSpecs(files: string[]): string[] {
  return files.filter(f => !/(^|\/)scout[^/]*\.spec\.ts$/i.test(f) && !/-tmp\.spec\.ts$/i.test(f))
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
