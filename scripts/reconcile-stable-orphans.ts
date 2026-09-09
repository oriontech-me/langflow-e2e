#!/usr/bin/env ts-node
/**
 * Reconcile `@stable` removals against their trackers (#1746) — the I/O half.
 *
 * `scripts/lib/stable-orphans.ts` decides and renders; this script gathers the
 * three inputs that decision needs and cannot be faked:
 *
 *   1. the declared tests, parsed from the spec ASTs (`stable-tests.ts`);
 *   2. WHEN each non-`@stable` test lost the tag, by walking that spec's git
 *      history until a revision is found where the SAME TITLE carried it;
 *   3. which open issues name the spec — read live, because issues get
 *      reopened (#1460 did exactly that).
 *
 * ## The history walk
 *
 * `git log --raw` gives, per revision of one path, the commit metadata AND the
 * post-image BLOB SHA. Reading blobs rather than paths is what makes `--follow`
 * usable: a spec that was moved keeps its history, and the walk never has to
 * know which path the content lived at in that revision.
 *
 * The walk goes newest → oldest and stops at the first revision where the title
 * carried `@stable`; the revision AFTER that one (the one walked immediately
 * before) is the commit that removed it. It also stops when the title is absent
 * — the test did not exist under that title yet, so nothing older can be a
 * removal, and the verdict is `never`.
 *
 * Every way the walk fails to decide is `unknown` WITH the reason, never
 * silence (#1012): an empty history, a revision cap hit, a blob that cannot be
 * read, or a working tree that differs from HEAD.
 *
 * ## Not a PR gate
 *
 * A pre-existing orphan is not the PR author's fault, and failing on one would
 * redden unrelated PRs until someone does an audit — #980's coverage-first
 * trade. This exits 0 on findings; only a broken RUN (an unreadable
 * declarations file, no specs found) exits non-zero. The findings reach a human
 * as an issue body, because a warning nobody reads is not a mechanism
 * (`mode=count`, #1252).
 *
 * Usage:
 *   npx ts-node scripts/reconcile-stable-orphans.ts [--markdown out.md]
 *                                                   [--json out.json]
 *                                                   [--no-trackers]
 *                                                   [--max-revisions N]
 */

import { execFileSync } from "child_process";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";

import {
  REGRESSION_ROOT,
  REPO_ROOT,
  collectDeclaredTests,
  parseDeclaredTests,
  type DeclaredTest,
} from "./lib/stable-tests";
import {
  hasFindings,
  historyKey,
  reconcile,
  renderReport,
  selectCandidates,
  type ExemptionDecl,
  type HistoryVerdict,
  type TrackerRef,
  type Verdict,
} from "./lib/stable-orphans";

/**
 * The identity of the report issue. A fixed title is what keeps one issue
 * current instead of opening one per run (the `unpriced-models` pattern).
 *
 * It is exported and echoed to `$GITHUB_OUTPUT` so the workflow never spells it
 * a second time — and, more importantly, so the tracker matcher can EXCLUDE it.
 * This issue names every orphaned spec by construction; counting it as a
 * tracker would mark every orphan "owned" on the next run, empty the report,
 * and make the finding reappear the run after. That oscillation is silent, and
 * it is the one bug this design can produce on its own.
 */
export const ORPHAN_ISSUE_TITLE =
  "[@stable] removals with no owner — tests that run in no scheduled lane";

export const EXEMPTIONS_PATH = "scripts/lib/stable-orphan-exemptions.json";

/**
 * Cap on how far back one spec's history is walked. Well above the deepest
 * spec history in the repo; a spec that hits it is reported `unknown`, never
 * silently resolved as `never`.
 */
const DEFAULT_MAX_REVISIONS = 500;

// ─── git plumbing ────────────────────────────────────────────────────────────

export interface Revision {
  commit: string;
  /** Committer date, ISO-8601. */
  date: string;
  subject: string;
  /** Post-image blob SHA — the file's content AT this revision. */
  blob: string;
}

const RECORD_SEP = "\u001e";
const FIELD_SEP = "\u001f";

/** The `--format` the parser below expects. Exported so the two cannot drift. */
export const GIT_LOG_FORMAT = `${RECORD_SEP}%H${FIELD_SEP}%cI${FIELD_SEP}%s`;

/**
 * Parse `git log --follow --raw --no-abbrev --format=<GIT_LOG_FORMAT>` output.
 *
 * Pure, and the seam the unit lane exercises: the raw-diff line shape (mode,
 * mode, src blob, dst blob, status, path — TAB-separated after the status) is
 * the part that would break silently on a git behaviour change, and a wrong
 * blob column reads as "this spec never had `@stable`" rather than as an error.
 *
 * A revision with no raw line is DROPPED, not reported empty: that is how a
 * merge commit and an empty commit show up, and neither changed the file.
 */
export function parseGitLogRaw(stdout: string): Revision[] {
  const out: Revision[] = [];
  for (const record of stdout.split(RECORD_SEP)) {
    if (!record.trim()) continue;
    const lines = record.split("\n");
    const header = lines[0].split(FIELD_SEP);
    if (header.length < 3) continue;
    const [commit, date, subject] = header;
    let blob: string | null = null;
    for (const line of lines.slice(1)) {
      if (!line.startsWith(":")) continue;
      // `:<srcmode> <dstmode> <srcsha> <dstsha> <status>\t<path>[\t<path>]`
      const [meta] = line.split("\t");
      const parts = meta.slice(1).split(" ").filter(Boolean);
      if (parts.length < 5) continue;
      const dst = parts[3];
      if (/^0+$/.test(dst)) continue; // deletion — no content at this revision
      blob = dst;
      break;
    }
    if (!blob) continue;
    out.push({ commit, date, subject, blob });
  }
  return out;
}

function git(args: string[]): string {
  return execFileSync("git", args, {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    maxBuffer: 256 * 1024 * 1024,
  });
}

/** `git rev-parse --is-shallow-repository`, defaulting to "assume truncated". */
export function isShallowRepository(): boolean {
  try {
    return git(["rev-parse", "--is-shallow-repository"]).trim() === "true";
  } catch {
    // If git cannot say, the safe answer is the one that reports UNKNOWN rather
    // than the one that reports a clean tree.
    return true;
  }
}

function revisionsOf(relativeToRepo: string): Revision[] {
  return parseGitLogRaw(
    git([
      "log",
      "--follow",
      "--raw",
      "--no-abbrev",
      `--format=${GIT_LOG_FORMAT}`,
      "--",
      relativeToRepo,
    ]),
  );
}

/**
 * Read many blobs in ONE `git cat-file --batch`. Per-blob `git show` calls cost
 * a process each and this walk reads thousands of them.
 *
 * The batch protocol is `<sha> <type> <size>\n<size bytes>\n` per request, or
 * `<sha> missing\n`. Sizes are BYTES, so the framing is done on a Buffer and
 * only the payload is decoded — slicing the decoded string would desynchronise
 * on the first non-ASCII character, and spec titles are full of them.
 */
export function readBlobs(shas: string[]): Map<string, string> {
  const out = new Map<string, string>();
  const unique = [...new Set(shas)];
  if (unique.length === 0) return out;

  const raw = execFileSync("git", ["cat-file", "--batch"], {
    cwd: REPO_ROOT,
    input: unique.join("\n") + "\n",
    maxBuffer: 512 * 1024 * 1024,
  });

  let offset = 0;
  while (offset < raw.length) {
    const nl = raw.indexOf("\n", offset);
    if (nl === -1) break;
    const header = raw.subarray(offset, nl).toString("utf-8");
    offset = nl + 1;
    const parts = header.split(" ");
    if (parts.length < 3) continue; // `<sha> missing` — leave it out of the map
    const size = Number(parts[2]);
    if (!Number.isFinite(size)) break;
    out.set(parts[0], raw.subarray(offset, offset + size).toString("utf-8"));
    offset += size + 1; // payload plus its trailing newline
  }
  return out;
}

// ─── The walk ────────────────────────────────────────────────────────────────

export interface WalkDeps {
  revisionsOf: (relativeToRepo: string) => Revision[];
  readBlobs: (shas: string[]) => Map<string, string>;
  maxRevisions: number;
  /**
   * Whether the repository's history is TRUNCATED (`git clone --depth N`).
   *
   * This is the one input that decides whether "the walk ran out of revisions"
   * means `never` or `unknown`, and getting it from the revision cap alone is
   * wrong in the direction that matters: a shallow clone runs out of history
   * long before any cap, so every unresolved title falls out as `never`, which
   * `reconcile()` counts and does not list. Measured on a `--depth 1` clone of
   * this branch: **0 orphaned, 0 undecidable** — both real orphans gone, and
   * both valid #1039 declarations reported as expired, telling a human to
   * delete correct declarations. That is precisely the false-clean #1012
   * forbids, produced by the check built to prevent it.
   */
  shallow: boolean;
}

/**
 * Date the `@stable` removal of every candidate title in one spec.
 *
 * Injectable dependencies so the unit lane can drive the whole walk — the
 * newest-first ordering and the "removal is the revision AFTER the last stable
 * one" rule are the parts worth pinning, and neither needs a real repository.
 */
export function walkSpec(
  relativePath: string,
  titles: string[],
  deps: WalkDeps,
): Record<string, HistoryVerdict> {
  const result: Record<string, HistoryVerdict> = {};
  const key = (title: string) => historyKey(relativePath, title);
  const repoPath = path
    .join(path.relative(REPO_ROOT, REGRESSION_ROOT), relativePath)
    .split(path.sep)
    .join("/");

  let revisions: Revision[];
  try {
    revisions = deps.revisionsOf(repoPath);
  } catch (e) {
    const reason = `git could not walk the history of this spec (${(e as Error).message.split("\n")[0]})`;
    for (const t of titles) result[key(t)] = { kind: "unknown", reason };
    return result;
  }

  if (revisions.length === 0) {
    for (const t of titles) {
      result[key(t)] = {
        kind: "unknown",
        reason:
          "this spec has no committed history at this ref, so when it lost `@stable` cannot be dated",
      };
    }
    return result;
  }

  const capped = revisions.length > deps.maxRevisions;
  const walked = revisions.slice(0, deps.maxRevisions);
  const blobs = deps.readBlobs(walked.map((r) => r.blob));

  const pending = new Set(titles);
  const parseCache = new Map<string, DeclaredTest[]>();
  let previous: Revision | null = null;

  for (const rev of walked) {
    if (pending.size === 0) break;

    const text = blobs.get(rev.blob);
    if (text === undefined) {
      const reason = `the blob for revision ${rev.commit.slice(0, 8)} could not be read, so the walk cannot continue past it`;
      for (const t of pending) result[key(t)] = { kind: "unknown", reason };
      return result;
    }

    let declared = parseCache.get(rev.blob);
    if (!declared) {
      declared = parseDeclaredTests(path.join(REGRESSION_ROOT, relativePath), text);
      parseCache.set(rev.blob, declared);
    }

    for (const title of [...pending]) {
      const found = declared.find((d) => d.title === title);
      if (!found) {
        // The title does not exist at this revision ⇒ it was introduced in the
        // revision walked immediately before this one, without `@stable`.
        result[key(title)] = { kind: "never" };
        pending.delete(title);
        continue;
      }
      if (found.stable) {
        if (!previous) {
          // The tag is present at HEAD but absent in the working tree.
          result[key(title)] = {
            kind: "unknown",
            reason:
              "`@stable` is present at HEAD but absent in the working tree — the removal is uncommitted, so no commit can be named for it",
          };
        } else {
          result[key(title)] = {
            kind: "removed",
            removal: {
              commit: previous.commit,
              date: previous.date,
              subject: previous.subject,
            },
          };
        }
        pending.delete(title);
      }
    }

    previous = rev;
  }

  for (const title of pending) {
    // Exhausting the walk is the ONLY place `never` is concluded from an
    // absence rather than from an observation, so it is the only place a
    // truncated history can turn into a clean verdict. A `never` decided
    // earlier — the title was absent at a revision we actually read — stays
    // sound whatever the clone depth, because the test's whole life is then
    // inside the window that was walked.
    result[key(title)] = capped
      ? {
          kind: "unknown",
          reason: `the walk hit the ${deps.maxRevisions}-revision cap without finding a revision where this title carried \`@stable\``,
        }
      : deps.shallow
        ? {
            kind: "unknown",
            reason:
              "this repository is a SHALLOW clone, so the walk ran out of history rather than reaching the revision that introduced this title — whether it ever carried `@stable` cannot be decided here (clone with `fetch-depth: 0`)",
          }
        : { kind: "never" };
  }

  return result;
}

// ─── Declared exemptions ─────────────────────────────────────────────────────

/**
 * Read and VALIDATE the declarations file.
 *
 * Malformed is a hard failure rather than "no exemptions": silently reading a
 * broken file as empty would turn every declared absence into a fresh orphan
 * row and drown the real findings — the same false-verdict shape the catalog
 * baseline's shape guard exists for.
 */
export function parseExemptions(text: string, where: string): ExemptionDecl[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`${where} is not valid JSON: ${(e as Error).message}`);
  }
  const list = (parsed as { exemptions?: unknown })?.exemptions;
  if (!Array.isArray(list)) {
    throw new Error(`${where} must have an "exemptions" array at the top level`);
  }
  return list.map((entry, i) => {
    const e = entry as Partial<ExemptionDecl>;
    for (const field of ["spec", "title", "reason"] as const) {
      if (typeof e[field] !== "string" || !e[field]) {
        throw new Error(
          `${where}: exemption #${i} is missing a non-empty "${field}". A declaration with no reason is the silent expiry this check exists to prevent (#1084).`,
        );
      }
    }
    if (e.ref !== undefined && typeof e.ref !== "string") {
      throw new Error(`${where}: exemption #${i} has a non-string "ref"`);
    }
    return {
      spec: e.spec as string,
      title: e.title as string,
      reason: e.reason as string,
      ...(e.ref ? { ref: e.ref } : {}),
    };
  });
}

// ─── Trackers ────────────────────────────────────────────────────────────────

export interface RawIssue {
  number: number;
  title: string;
  body?: string | null;
  html_url: string;
  pull_request?: unknown;
}

/**
 * Which open issues own which removal.
 *
 * "Names the file" is the criterion the hand audits used, and it is
 * deliberately generous: a false "owned" costs one hidden row that a human can
 * still find, while a false "orphaned" costs the report its credibility — the
 * failure mode rule 1 was written about. A tracker that also quotes the test
 * title is recorded as the stronger `title` match so the reader can tell the
 * two apart.
 *
 * PRs are excluded (the issues endpoint returns them), and so is this check's
 * OWN report issue — see `ORPHAN_ISSUE_TITLE`.
 */
export function buildTrackerIndex(
  issues: RawIssue[],
  candidates: DeclaredTest[],
  ownTitle: string = ORPHAN_ISSUE_TITLE,
): Record<string, TrackerRef[]> {
  const index: Record<string, TrackerRef[]> = {};
  const real = issues.filter((i) => !i.pull_request && i.title !== ownTitle);

  for (const test of candidates) {
    const basename = test.relativePath.split("/").pop() as string;
    // A bare `includes` on the BASENAME matches inside a longer one, and this
    // tree already contains three such pairs — `run-flow.spec.ts` inside
    // `api-run-flow.spec.ts`, `starter-projects.spec.ts` inside
    // `mcp-server-starter-projects.spec.ts`, `traces.spec.ts` inside
    // `api-monitor-traces.spec.ts`. `run-flow.spec.ts` is one of the orphans
    // this reports today, so the day someone opens an issue about
    // `api-run-flow.spec.ts` that orphan would silently read as owned. The
    // preceding character must not be one a filename can continue through.
    const basenamePattern = new RegExp(
      `(^|[^A-Za-z0-9_.\\-])${basename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
    );
    const refs: TrackerRef[] = [];
    for (const issue of real) {
      const haystack = `${issue.title}\n${issue.body ?? ""}`;
      const namesFile =
        haystack.includes(test.relativePath) || basenamePattern.test(haystack);
      if (!namesFile) continue;
      refs.push({
        number: issue.number,
        title: issue.title,
        url: issue.html_url,
        matchedOn: haystack.includes(test.title) ? "title" : "path",
      });
    }
    if (refs.length > 0) {
      index[historyKey(test.relativePath, test.title)] = refs;
    }
  }
  return index;
}

function fetchOpenIssues(): RawIssue[] {
  const out = execFileSync(
    "gh",
    [
      "api",
      "--paginate",
      "-X",
      "GET",
      "repos/{owner}/{repo}/issues",
      "-f",
      "state=open",
      "-f",
      "per_page=100",
      // `--paginate` concatenates one JSON array per page; `--slurp` merges them
      // into a single array so the parse below cannot silently see page 1 only.
      "--slurp",
    ],
    { cwd: REPO_ROOT, encoding: "utf-8", maxBuffer: 256 * 1024 * 1024 },
  );
  const pages = JSON.parse(out) as RawIssue[][];
  return pages.flat();
}

// ─── Entry point ─────────────────────────────────────────────────────────────

function argValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
}

export function run(argv: string[]): number {
  const noTrackers = argv.includes("--no-trackers");
  const maxRevisions = Number(
    argValue(argv, "--max-revisions") ?? DEFAULT_MAX_REVISIONS,
  );
  if (!Number.isFinite(maxRevisions) || maxRevisions < 1) {
    console.error("--max-revisions must be a positive integer");
    return 1;
  }

  const tests = collectDeclaredTests();
  if (tests.length === 0) {
    // Zero declared tests means the spec tree moved or the parse broke. Reporting
    // "no orphans" there would be the clean-looking verdict #1012 forbids.
    console.error(
      `No declared tests found under ${REGRESSION_ROOT}. Refusing to report a clean reconciliation from an empty parse.`,
    );
    return 1;
  }

  const exemptionsFile = path.join(REPO_ROOT, EXEMPTIONS_PATH);
  const exemptions = parseExemptions(
    fs.readFileSync(exemptionsFile, "utf-8"),
    EXEMPTIONS_PATH,
  );

  const candidates = selectCandidates(tests);
  const bySpec = new Map<string, string[]>();
  for (const c of candidates) {
    const list = bySpec.get(c.relativePath) ?? [];
    list.push(c.title);
    bySpec.set(c.relativePath, list);
  }

  const shallow = isShallowRepository();
  if (shallow) {
    console.error(
      "reconcile-stable-orphans: this is a SHALLOW clone — every removal that cannot be dated inside the truncated history is reported UNKNOWN, not clean. Re-run with `fetch-depth: 0` for a usable report.",
    );
  }
  const history: Record<string, HistoryVerdict> = {};
  for (const [spec, titles] of bySpec) {
    Object.assign(
      history,
      walkSpec(spec, titles, { revisionsOf, readBlobs, maxRevisions, shallow }),
    );
  }

  let trackers: Record<string, TrackerRef[]> = {};
  let trackerLookupError: string | undefined;
  if (noTrackers) {
    trackerLookupError = "tracker lookup was disabled with --no-trackers";
  } else {
    try {
      trackers = buildTrackerIndex(fetchOpenIssues(), candidates);
    } catch (e) {
      trackerLookupError = (e as Error).message.split("\n")[0];
    }
  }

  const verdict: Verdict = reconcile({
    tests,
    history,
    trackers,
    exemptions,
    trackerLookupError,
  });

  const runLabel = process.env.RUN_LABEL || undefined;
  const markdown = renderReport(verdict, {
    runLabel,
    exemptionsPath: EXEMPTIONS_PATH,
  });

  const mdOut = argValue(argv, "--markdown");
  if (mdOut) fs.writeFileSync(mdOut, markdown + "\n");
  const jsonOut = argValue(argv, "--json");
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(verdict, null, 2) + "\n");

  console.log(markdown);

  const findings =
    verdict.orphaned.length +
    verdict.unknown.length +
    verdict.staleExemptions.length +
    verdict.unverifiedExemptions.length;

  if (process.env.GITHUB_OUTPUT) {
    // Per-run, because the body carries repo-authored text (test titles,
    // exemption reasons, `gh`'s first error line) and a fixed delimiter is one
    // unlucky string away from truncating the report.
    const delimiter = `__ORPHANS_EOF_${randomUUID().replace(/-/g, "")}__`;
    fs.appendFileSync(
      process.env.GITHUB_OUTPUT,
      [
        `orphan_count=${verdict.orphaned.length}`,
        `finding_count=${findings}`,
        `has_findings=${hasFindings(verdict)}`,
        // The workflow uses this to leave a standing report ALONE rather than
        // overwriting it with "we could not ask GitHub": an outage decides
        // nothing about ownership, and a body rewrite is destructive.
        `tracker_lookup_failed=${trackerLookupError ? "true" : "false"}`,
        `issue_title=${ORPHAN_ISSUE_TITLE}`,
        `summary_md<<${delimiter}`,
        markdown,
        delimiter,
        "",
      ].join("\n"),
    );
  }

  return 0;
}

if (require.main === module) {
  try {
    process.exit(run(process.argv.slice(2)));
  } catch (e) {
    console.error(`reconcile-stable-orphans: ${(e as Error).message}`);
    process.exit(1);
  }
}
