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
  candidateSpecs,
  checklistBullets,
  classifyGates,
  extractRefs,
  hasGateFindings,
  refKey,
  renderGateSection,
  tagsSection,
  type CitedRef,
  type GateDecl,
  type GateVerdict,
  type JustificationSource,
  type RefState,
  type SpecJustification,
  type TrackedBy,
} from "./lib/gate-justifications";
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
  "[@stable] absences nobody is holding — orphaned removals and expired justifications";

export const EXEMPTIONS_PATH = "scripts/lib/stable-orphan-exemptions.json";

/** Declared PROVENANCE citations for the gate-justification check (#1783). */
export const GATE_DECLARATIONS_PATH =
  "scripts/lib/gate-justification-declarations.json";

/**
 * The upstream repository this repo's docs cite. A bare `#N` is resolved
 * against OUR repo and an `owner/repo#N` against the one it names; this
 * constant only decides where an `upstream` reference is looked up.
 */
const UPSTREAM_REPO = "langflow-ai/langflow";

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

// ─── Gate justifications (#1783) ─────────────────────────────────────────────

/**
 * Read a file, or return "" when it is absent.
 *
 * Absent is a legitimate state for the checklist only in a stripped checkout,
 * and it degrades this check to the doc source alone rather than crashing the
 * whole reconciliation — the orphan half is the release-relevant one and must
 * not be lost to a missing markdown file (#980's coverage-first trade).
 */
function readTextOrEmpty(file: string): string {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "";
}


/**
 * Which OPEN issues name which candidate SPEC.
 *
 * The per-test index above answers "who owns this removal"; this answers "does
 * anyone own this file at all", which is the question a spec-level
 * justification needs. Same generous criterion and the same boundary rule — a
 * bare `includes` on `run-flow.spec.ts` matches inside `api-run-flow.spec.ts`,
 * and this tree has three such pairs.
 */
export function buildSpecTrackerIndex(
  issues: RawIssue[],
  specs: string[],
  ownTitle: string = ORPHAN_ISSUE_TITLE,
): Record<string, TrackedBy[]> {
  const index: Record<string, TrackedBy[]> = {};
  const real = issues.filter((i) => !i.pull_request && i.title !== ownTitle);
  for (const spec of specs) {
    const basename = spec.split("/").pop() as string;
    const pattern = new RegExp(
      `(^|[^A-Za-z0-9_.\\-])${basename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
    );
    const refs: TrackedBy[] = [];
    for (const issue of real) {
      const haystack = `${issue.title}\n${issue.body ?? ""}`;
      if (!haystack.includes(spec) && !pattern.test(haystack)) continue;
      refs.push({ number: issue.number, url: issue.html_url });
    }
    if (refs.length > 0) index[spec] = refs;
  }
  return index;
}

/**
 * Read each candidate spec's written justification off disk.
 *
 * Two sources, both required by `CONTRIBUTING.md` → "Exceptions": the spec
 * doc's `## Tags` section and the `QA-CHECKLIST.md` Part II bullets naming the
 * spec. A MISSING doc is not an error — `check-checklist-coverage.ts` records
 * that docs resolve by content reference rather than by filename, so most specs
 * legitimately have none and the checklist is then the only source. An
 * UNREADABLE one is different, and is carried as `readError` so the spec is
 * reported undecidable instead of "cites nothing" (#1012).
 */
export function collectJustifications(
  specs: string[],
  opts: {
    docsRoot: string;
    checklistText: string;
    readDoc: (path: string) => string | null;
  },
): Record<string, SpecJustification> {
  const out: Record<string, SpecJustification> = {};
  for (const spec of specs) {
    const docPath = path.join(
      opts.docsRoot,
      spec.replace(/\.spec\.ts$/, ".md"),
    );
    // The report is rendered into a GitHub issue, where an absolute path from
    // whichever machine ran the check means nothing to the reader.
    const docLabel = path.relative(REPO_ROOT, docPath);
    const sources: JustificationSource[] = [];
    let readError: string | undefined;
    let docText: string | null = null;
    try {
      docText = opts.readDoc(docPath);
    } catch (e) {
      readError = `the spec doc \`${docLabel}\` exists but could not be read (${(e as Error).message})`;
    }
    if (docText !== null && docText !== undefined) {
      const tags = tagsSection(docText);
      if (tags !== null) {
        const line =
          docText.split("\n").findIndex((l) => /^#{2,}\s+Tags\b/.test(l)) + 1;
        sources.push({ kind: "doc-tags", file: docLabel, line, text: tags });
      }
    }
    sources.push(...checklistBullets(opts.checklistText, spec));
    out[spec] = { spec, sources, ...(readError ? { readError } : {}) };
  }
  return out;
}

interface GraphQlRefNode {
  __typename?: string;
  state?: string;
}

/**
 * Resolve every cited reference to its live state, in one GraphQL round trip
 * per repository.
 *
 * REST would need one request per number and cannot say whether a number is an
 * issue or a pull request without trying both; GraphQL's `issueOrPullRequest`
 * answers both in a single aliased batch. A number that resolves to nothing
 * comes back as `unresolved` WITH that reason rather than as an error, because
 * the commonest cause is benign and specific: this repo's prose cites upstream
 * pull requests without their `langflow-ai/langflow#` prefix (`#14512`), and
 * resolving such a ref against our repo is exactly how a live upstream gate
 * would be reported dead.
 */
export function resolveRefStates(
  refs: CitedRef[],
  query: (repo: string, numbers: number[]) => Record<number, GraphQlRefNode | null>,
): Record<string, RefState> {
  const byRepo = new Map<string, number[]>();
  for (const r of refs) {
    const repo = r.repo === "self" ? "self" : UPSTREAM_REPO;
    const list = byRepo.get(repo) ?? [];
    if (!list.includes(r.number)) list.push(r.number);
    byRepo.set(repo, list);
  }

  const out: Record<string, RefState> = {};
  for (const [repo, numbers] of byRepo) {
    let nodes: Record<number, GraphQlRefNode | null>;
    try {
      nodes = query(repo, numbers);
    } catch (e) {
      const reason = (e as Error).message.split("\n")[0];
      for (const n of numbers) {
        out[refKey({ repo: repo === "self" ? "self" : "upstream", number: n })] =
          { kind: "unresolved", reason: `lookup failed: ${reason}` };
      }
      continue;
    }
    for (const n of numbers) {
      const key = refKey({
        repo: repo === "self" ? "self" : "upstream",
        number: n,
      });
      const node = nodes[n];
      if (!node) {
        out[key] =
          repo === "self"
            ? {
                kind: "unresolved",
                reason:
                  "no issue or pull request with this number exists in THIS repo — most likely an upstream reference written without its `langflow-ai/langflow#` prefix",
              }
            : {
                kind: "unresolved",
                reason: `no issue or pull request with this number exists in ${repo}`,
              };
        continue;
      }
      // MERGED is the strongest form of "this gate is gone" (rule 4); a CLOSED
      // pull request was abandoned, which is also not a live gate.
      if (node.state === "OPEN") out[key] = { kind: "open" };
      else if (node.state === "MERGED") out[key] = { kind: "merged" };
      else if (node.state === "CLOSED") out[key] = { kind: "closed" };
      else
        out[key] = {
          kind: "unresolved",
          reason: `unrecognised state ${JSON.stringify(node.state)}`,
        };
    }
  }
  return out;
}

function queryRefsViaGh(
  repo: string,
  numbers: number[],
): Record<number, GraphQlRefNode | null> {
  const target =
    repo === "self"
      ? "repository(owner: $owner, name: $name)"
      : `repository(owner: "${UPSTREAM_REPO.split("/")[0]}", name: "${UPSTREAM_REPO.split("/")[1]}")`;
  const fields = numbers
    .map(
      (n) =>
        `n${n}: issueOrPullRequest(number: ${n}) { __typename ... on Issue { state } ... on PullRequest { state } }`,
    )
    .join("\n");
  const query =
    repo === "self"
      ? `query($owner:String!,$name:String!){ ${target} { ${fields} } }`
      : `query{ ${target} { ${fields} } }`;

  const args = ["api", "graphql", "-f", `query=${query}`];
  if (repo === "self") {
    // `{owner}` and `{repo}` are the placeholders `gh` substitutes from the
    // current repository. `{name}` is NOT one — it is passed through verbatim,
    // which resolves the query against `owner/{name}` and fails with a
    // NOT_FOUND naming that literal string.
    args.push("-F", "owner={owner}", "-F", "name={repo}");
  }

  // A number that resolves to nothing makes `gh` EXIT NON-ZERO even though the
  // response carries `data` with every other alias resolved. That is not an
  // edge case here: the reference this check exists to handle correctly —
  // a bare `#14512` that is really an upstream PR — produces exactly that
  // partial failure on every run, so treating a non-zero exit as "the batch
  // failed" would report a whole spec undecidable because ONE of its citations
  // is unresolvable. stdout is therefore parsed either way, and only a response
  // with no usable `data` is an error.
  let out: string;
  try {
    out = execFileSync("gh", args, {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    const partial = (e as { stdout?: string }).stdout;
    if (!partial) throw e;
    out = partial;
  }

  let parsed: {
    data?: { repository?: Record<string, GraphQlRefNode | null> | null };
  };
  try {
    parsed = JSON.parse(out);
  } catch {
    throw new Error(`gh returned unparseable output for ${repo}`);
  }
  // `repository: null` means the REPOSITORY did not resolve — a different
  // failure from a number that did not, and one that must not silently mark
  // every reference in the batch as nonexistent.
  const repoNode = parsed.data?.repository;
  if (!repoNode) {
    throw new Error(
      `the repository itself did not resolve for ${repo === "self" ? "this repo" : repo}`,
    );
  }
  const result: Record<number, GraphQlRefNode | null> = {};
  for (const n of numbers) result[n] = repoNode[`n${n}`] ?? null;
  return result;
}

/**
 * Parse and validate the declarations file. A declaration with no reason is the
 * silent expiry this check exists to prevent (#1084), so it is refused here
 * rather than honoured.
 */
export function parseGateDeclarations(raw: string, where: string): GateDecl[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${where}: not valid JSON (${(e as Error).message})`);
  }
  const list = (parsed as { declarations?: unknown }).declarations;
  if (!Array.isArray(list)) {
    throw new Error(`${where}: missing a "declarations" array`);
  }
  return list.map((entry, i) => {
    const d = entry as Partial<GateDecl>;
    for (const field of ["spec", "reason"] as const) {
      if (typeof d[field] !== "string" || !d[field]) {
        throw new Error(
          `${where}: declaration #${i} is missing a non-empty "${field}". A declaration with no reason is the silent expiry this check exists to prevent (#1084).`,
        );
      }
    }
    if (
      !Array.isArray(d.refs) ||
      d.refs.length === 0 ||
      d.refs.some((r) => typeof r !== "string" || !r)
    ) {
      throw new Error(
        `${where}: declaration #${i} must list the references it covers in a non-empty "refs" array of strings — a declaration that names no reference cannot be verified in the other direction.`,
      );
    }
    if (d.ref !== undefined && typeof d.ref !== "string") {
      throw new Error(`${where}: declaration #${i} has a non-string "ref"`);
    }
    return {
      spec: d.spec as string,
      refs: d.refs as string[],
      reason: d.reason as string,
      ...(d.ref ? { ref: d.ref } : {}),
    };
  });
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
  // Fetched once and reused by BOTH finding classes: two identical paginated
  // sweeps would double the run's only expensive call, and — worse — could
  // disagree with each other if an issue closes between them.
  let openIssues: RawIssue[] | undefined;
  if (noTrackers) {
    trackerLookupError = "tracker lookup was disabled with --no-trackers";
  } else {
    try {
      openIssues = fetchOpenIssues();
      trackers = buildTrackerIndex(openIssues, candidates);
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

  // ─── Second finding class: gate justifications (#1783) ───────────────────
  //
  // Deliberately computed from the SAME `tests` parse and the SAME issue
  // fetch, and deliberately kept in its own module: it answers a different
  // question (is the written reason still live?) about a different unit (the
  // spec file, not the test), and folding it into `reconcile()` would couple
  // two verdicts that fail for unrelated causes.
  const gateSpecs = candidateSpecs(tests);
  const justifications = collectJustifications(gateSpecs, {
    docsRoot: path.join(REPO_ROOT, "docs"),
    checklistText: readTextOrEmpty(path.join(REPO_ROOT, "QA-CHECKLIST.md")),
    readDoc: (p) => (fs.existsSync(p) ? fs.readFileSync(p, "utf-8") : null),
  });
  const declarations = parseGateDeclarations(
    fs.readFileSync(path.join(REPO_ROOT, GATE_DECLARATIONS_PATH), "utf-8"),
    GATE_DECLARATIONS_PATH,
  );
  const citedRefs = Object.values(justifications).flatMap((j) =>
    extractRefs(j.sources.map((s) => s.text).join("\n")),
  );
  let refStates: Record<string, RefState> = {};
  let gateLookupError: string | undefined;
  if (noTrackers) {
    gateLookupError = "reference lookup was disabled with --no-trackers";
  } else if (citedRefs.length > 0) {
    refStates = resolveRefStates(citedRefs, queryRefsViaGh);
  }
  // A reference that does not EXIST is a finding; a reference we could not ASK
  // about is an outage, and the two must not render the same. The workflow uses
  // this to leave a standing report alone rather than overwrite real findings
  // with "we could not ask" — the same rule the tracker lookup already follows,
  // and for the same reason: a body rewrite is destructive and an outage
  // decides nothing.
  const gateLookupFailed = Object.values(refStates).some(
    (s) => s.kind === "unresolved" && s.reason.startsWith("lookup failed:"),
  );
  const gateVerdict: GateVerdict = classifyGates({
    tests,
    justifications,
    refStates,
    trackedSpecs: noTrackers
      ? {}
      : buildSpecTrackerIndex(openIssues ?? [], gateSpecs),
    declarations,
    lookupError: gateLookupError ?? trackerLookupError,
  });

  const runLabel = process.env.RUN_LABEL || undefined;
  const markdown =
    renderReport(verdict, {
      runLabel,
      exemptionsPath: EXEMPTIONS_PATH,
    }) +
    "\n\n---\n\n" +
    renderGateSection(gateVerdict, {
      declarationsPath: GATE_DECLARATIONS_PATH,
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
    verdict.unverifiedExemptions.length +
    gateVerdict.expired.length +
    gateVerdict.unknown.length +
    gateVerdict.staleDeclarations.length;

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
        `has_findings=${hasFindings(verdict) || hasGateFindings(gateVerdict)}`,
        `expired_gate_count=${gateVerdict.expired.length}`,
        `gate_lookup_failed=${gateLookupFailed ? "true" : "false"}`,
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
