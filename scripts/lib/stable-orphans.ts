/**
 * Reconcile `@stable` REMOVALS against the trackers that are supposed to own
 * putting the tag back (#1746).
 *
 * `@stable` removal is automatic — `daily-stable.yml` strips the tag on a hard
 * failure and commits straight to `main` — while restoration is manual and
 * lives as a checkbox on a dedicated issue. Nothing reconciled "tags currently
 * missing" against "open issues that own a restore", so an issue could close
 * with that checkbox unticked and the test would stay out of the daily forever
 * with nobody holding it. Three hand audits (#974, #1504, and the #1460 case a
 * human caught by accident) found the same class each time.
 *
 * This module is the PURE half: given the declared tests, the per-test history
 * verdicts, the live issue state and the declared exemptions, it decides what
 * each row is and renders the report. Every git and GitHub call lives in
 * `scripts/reconcile-stable-orphans.ts`, so the classification is unit-testable
 * without a repository or a network.
 *
 * Five rules the hand audits paid for, each of which a naive implementation
 * gets wrong:
 *
 * 1. **"Issue closed" is not the criterion — "no OPEN issue names it" is.**
 *    #1460 closed WITH the restore performed; keying on the tracker's state
 *    rather than on the tag's would have reported two false orphans.
 * 2. **Issues get reopened**, so the state is read live on every run and never
 *    cached in the repository.
 * 3. **Two states, not one.** `@stable` removal and `test.fixme` are applied
 *    together at flake quarantine but separately at hard-failure auto-removal
 *    (`32ac9a1` removed the tag; `4be67e9` added the fixme four weeks later).
 *    "Not in the daily" and "runs nowhere at all" are reported apart — the
 *    second is worse, and is what also makes the test invisible on the PR
 *    impacted-specs lane (#871 / #1054).
 * 4. **Some absences are deliberate and permanent** (`groq` / `mistral` lost
 *    the tag in #1039 because the components are not bundled in the tested
 *    image). Those are declarable — and, per #1084's lesson, the declaration is
 *    verified in BOTH directions: a declaration whose reason has expired is
 *    reported rather than honoured silently.
 * 5. **Line numbers drift; titles do not.** Every issue in #1504's table cited a
 *    line number and two of the five had moved by the audit. Matching is on the
 *    test TITLE within the file; the line is display only.
 *
 * And #1012's rule throughout: a history that cannot be walked, or an issue
 * lookup that fails, is reported as UNKNOWN with the reason named. Undecidable
 * is never folded into clean.
 */

import type { DeclaredTest } from "./stable-tests";
import { LANE_TAGS } from "./stable-tests";

// ─── Inputs ──────────────────────────────────────────────────────────────────

/** The commit that took `@stable` off a test, as dated by the history walk. */
export interface RemovalEvidence {
  commit: string;
  date: string;
  subject: string;
}

/**
 * What walking a spec's history said about one test title.
 *
 * `never` means the walk reached the revision where the title first appears
 * without ever seeing `@stable` on it — the test was never in the daily, so it
 * is not an orphan. `unknown` is every way the walk failed to decide.
 */
export type HistoryVerdict =
  | { kind: "removed"; removal: RemovalEvidence }
  | { kind: "never" }
  | { kind: "unknown"; reason: string };

/** An open issue or PR that mentions a spec. Read live — see rule 2. */
export interface TrackerRef {
  number: number;
  title: string;
  url: string;
  /** `title` is a stronger claim of ownership than `path`; both are reported. */
  matchedOn: "title" | "path";
}

/** A declared, deliberate, permanent absence — see rule 4. */
export interface ExemptionDecl {
  /** Path under `regression/`. */
  spec: string;
  /** Exact test title. Titles do not drift; lines do (rule 5). */
  title: string;
  reason: string;
  /** Where the decision is written down, e.g. `#1039`. */
  ref?: string;
}

export interface ReconcileInput {
  /** Every declared test under `regression/`. */
  tests: DeclaredTest[];
  /** History verdict per candidate, keyed by `historyKey()`. */
  history: Record<string, HistoryVerdict>;
  /**
   * Open trackers per candidate test, keyed by `historyKey()`.
   *
   * The criterion the hand audits used is "an open issue NAMES THE FILE", so
   * the driver seeds every test in a named spec with that issue; a tracker that
   * also quotes the test title is recorded as a stronger `title` match. Keying
   * per test rather than per file is what lets the report say which of a spec's
   * removals the issue is actually about.
   */
  trackers: Record<string, TrackerRef[]>;
  exemptions: ExemptionDecl[];
  /**
   * Set when the issue lookup itself failed. Every affected row's ownership
   * then reads as undecided rather than as "nobody owns it" — the difference
   * between a finding and an outage (#1012).
   */
  trackerLookupError?: string;
}

// ─── Verdict ─────────────────────────────────────────────────────────────────

export type RowState = "orphaned" | "owned" | "exempt" | "unknown";

export interface ReconcileRow {
  title: string;
  relativePath: string;
  line: number;
  state: RowState;
  /** True when the test is `test.fixme` as well — it runs on NO lane at all. */
  fixme: boolean;
  removal: RemovalEvidence | null;
  trackers: TrackerRef[];
  exemption: ExemptionDecl | null;
  /** Present on `unknown` rows: why the row could not be decided. */
  reason?: string;
}

export interface ExemptionProblem {
  exemption: ExemptionDecl;
  reason: string;
}

export interface Verdict {
  orphaned: ReconcileRow[];
  owned: ReconcileRow[];
  exempt: ReconcileRow[];
  unknown: ReconcileRow[];
  /** Declarations whose justification has expired — see rule 4. */
  staleExemptions: ExemptionProblem[];
  /** Declarations that could not be verified either way (#1012). */
  unverifiedExemptions: ExemptionProblem[];
  counts: {
    declared: number;
    stable: number;
    laneGated: number;
    neverStable: number;
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Key a test by (path, title). The separator is a NUL, which cannot occur in
 * either half — a printable one would let a title containing it collide with a
 * different (path, title) pair.
 */
export function historyKey(relativePath: string, title: string): string {
  return `${relativePath}\u0000${title}`;
}

/** The lane tags on a test, if any — see `LANE_TAGS` for why they are exempt. */
export function laneTagsOf(test: DeclaredTest): string[] {
  return LANE_TAGS.filter((t) => test.tags.includes(t));
}

/**
 * The tests worth walking history for: not in the daily, and not out of it
 * because of a lane selector.
 *
 * Exempt tests are deliberately still walked. Verifying a declaration in both
 * directions means asking whether the tag was ever there to begin with, and
 * that question needs the history — a declaration protecting a test that never
 * carried `@stable` is doing nothing and should say so.
 */
export function selectCandidates(tests: DeclaredTest[]): DeclaredTest[] {
  return tests.filter((t) => !t.stable && laneTagsOf(t).length === 0);
}

function findDeclared(
  tests: DeclaredTest[],
  spec: string,
  title: string,
): DeclaredTest | undefined {
  return tests.find((t) => t.relativePath === spec && t.title === title);
}

// ─── Classification ──────────────────────────────────────────────────────────

export function reconcile(input: ReconcileInput): Verdict {
  const { tests, history, trackers, exemptions, trackerLookupError } = input;

  const exemptionByKey = new Map<string, ExemptionDecl>();
  for (const e of exemptions) {
    exemptionByKey.set(historyKey(e.spec, e.title), e);
  }

  const verdict: Verdict = {
    orphaned: [],
    owned: [],
    exempt: [],
    unknown: [],
    staleExemptions: [],
    unverifiedExemptions: [],
    counts: {
      declared: tests.length,
      stable: tests.filter((t) => t.stable).length,
      laneGated: tests.filter((t) => !t.stable && laneTagsOf(t).length > 0)
        .length,
      neverStable: 0,
    },
  };

  for (const test of selectCandidates(tests)) {
    const key = historyKey(test.relativePath, test.title);
    const exemption = exemptionByKey.get(key) ?? null;
    const base = {
      title: test.title,
      relativePath: test.relativePath,
      line: test.line,
      fixme: test.fixme,
      trackers: trackers[key] ?? [],
      exemption,
    };

    // A `tag` option the parser could not read is undecidable at the source
    // level, before history even matters: the test may or may not be `@stable`.
    if (test.unparseableTags) {
      verdict.unknown.push({
        ...base,
        state: "unknown",
        removal: null,
        reason:
          "the `tag` option is not an inline array of string literals, so whether this test is `@stable` cannot be read from the source",
      });
      continue;
    }

    const outcome = history[key];
    if (!outcome) {
      verdict.unknown.push({
        ...base,
        state: "unknown",
        removal: null,
        reason: "no history verdict was produced for this test",
      });
      continue;
    }

    if (outcome.kind === "unknown") {
      verdict.unknown.push({
        ...base,
        state: "unknown",
        removal: null,
        reason: outcome.reason,
      });
      continue;
    }

    if (outcome.kind === "never") {
      // Never in the daily ⇒ nothing was removed ⇒ not an orphan. Counted, not
      // listed: most of the suite's non-`@stable` tests are here.
      verdict.counts.neverStable++;
      continue;
    }

    if (exemption) {
      verdict.exempt.push({
        ...base,
        state: "exempt",
        removal: outcome.removal,
      });
      continue;
    }

    // Rule 1: the criterion is the ABSENCE of an open tracker, never a closed
    // one. `trackerLookupError` means we could not ask, which is not the same
    // as asking and finding none.
    if (trackerLookupError) {
      verdict.unknown.push({
        ...base,
        state: "unknown",
        removal: outcome.removal,
        reason: `the issue lookup failed (${trackerLookupError}), so it is unknown whether an open tracker owns this restore`,
      });
      continue;
    }

    const row: ReconcileRow = {
      ...base,
      state: base.trackers.length > 0 ? "owned" : "orphaned",
      removal: outcome.removal,
    };
    (row.state === "owned" ? verdict.owned : verdict.orphaned).push(row);
  }

  // ─── Rule 4, the other direction ───────────────────────────────────────────
  for (const e of exemptions) {
    const declared = findDeclared(tests, e.spec, e.title);
    if (!declared) {
      verdict.staleExemptions.push({
        exemption: e,
        reason:
          "no test with this title exists in that spec — the declaration protects nothing (titles are the match key; a rename needs the declaration updated with it)",
      });
      continue;
    }
    if (declared.stable) {
      verdict.staleExemptions.push({
        exemption: e,
        reason:
          "the test carries `@stable` again, so the declared absence no longer exists",
      });
      continue;
    }
    const lane = laneTagsOf(declared);
    if (lane.length > 0) {
      verdict.staleExemptions.push({
        exemption: e,
        reason: `the test now carries ${lane.join(", ")}, which already keeps it out of the daily by design (#1010) — the declaration is redundant`,
      });
      continue;
    }
    const outcome = history[historyKey(e.spec, e.title)];
    if (!outcome || outcome.kind === "unknown") {
      verdict.unverifiedExemptions.push({
        exemption: e,
        reason: outcome
          ? outcome.reason
          : "no history verdict was produced for this test",
      });
      continue;
    }
    if (outcome.kind === "never") {
      verdict.staleExemptions.push({
        exemption: e,
        reason:
          "this test never carried `@stable` in the walked history, so there is no removal for the declaration to justify",
      });
    }
  }

  return verdict;
}

/**
 * Whether the verdict has anything a human must act on.
 *
 * Exempt and owned rows are reported for transparency but are not findings —
 * refreshing an issue for them every run is how a mechanism becomes noise
 * nobody reads (the `mode=count` lesson, #1252).
 */
export function hasFindings(v: Verdict): boolean {
  return (
    v.orphaned.length > 0 ||
    v.unknown.length > 0 ||
    v.staleExemptions.length > 0 ||
    v.unverifiedExemptions.length > 0
  );
}

// ─── Rendering ───────────────────────────────────────────────────────────────

function shortSha(sha: string): string {
  return sha.slice(0, 8);
}

/**
 * Make a cell safe for a Markdown table: escape the delimiter, and flatten
 * newlines — a template-literal test title spans lines in the source and would
 * otherwise end the row mid-table.
 */
function esc(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function reach(row: ReconcileRow): string {
  // Rule 3 — the two states are not the same finding.
  return row.fixme ? "**runs nowhere** (`test.fixme` too)" : "not in the daily";
}

function trackerCell(row: ReconcileRow): string {
  if (row.trackers.length === 0) return "—";
  return row.trackers
    .map((t) => `#${t.number}${t.matchedOn === "title" ? " (title)" : ""}`)
    .join(", ");
}

function removalCell(row: ReconcileRow): string {
  if (!row.removal) return "—";
  return `\`${shortSha(row.removal.commit)}\` ${row.removal.date.slice(0, 10)}`;
}

export interface RenderOptions {
  /** Where the report came from, e.g. `stable-orphan-reconcile #123`. */
  runLabel?: string;
  /** Path of the declarations file, for the "how to declare" footer. */
  exemptionsPath: string;
}

export function renderReport(v: Verdict, opts: RenderOptions): string {
  const lines: string[] = [];

  lines.push(
    `**${v.orphaned.length} orphaned**, ${v.unknown.length} undecidable, ` +
      `${v.staleExemptions.length + v.unverifiedExemptions.length} declaration problem(s), ` +
      `${v.owned.length} owned, ${v.exempt.length} declared-exempt.`,
  );
  lines.push("");
  lines.push(
    "An **orphan** is a test whose `tag` array no longer contains `@stable`, " +
      "whose removal is dated in the git history, and which **no open issue names**. " +
      "It runs in no scheduled lane and nobody is holding it (#1746).",
  );
  lines.push("");

  if (v.orphaned.length > 0) {
    lines.push("## Orphaned — nobody owns the restore");
    lines.push("");
    lines.push("| Test | Spec | Reach | `@stable` removed by |");
    lines.push("|---|---|---|---|");
    for (const r of v.orphaned) {
      lines.push(
        `| ${esc(r.title)} | \`${r.relativePath}\`:${r.line} | ${reach(r)} | ${removalCell(r)} — ${esc(r.removal?.subject ?? "")} |`,
      );
    }
    lines.push("");
  }

  if (v.unknown.length > 0) {
    lines.push("## Undecidable — reported, not assumed clean (#1012)");
    lines.push("");
    lines.push("| Test | Spec | Why |");
    lines.push("|---|---|---|");
    for (const r of v.unknown) {
      lines.push(
        `| ${esc(r.title)} | \`${r.relativePath}\`:${r.line} | ${esc(r.reason ?? "unspecified")} |`,
      );
    }
    lines.push("");
  }

  if (v.staleExemptions.length > 0 || v.unverifiedExemptions.length > 0) {
    lines.push("## Declarations whose justification no longer holds");
    lines.push("");
    lines.push(
      "Verified in both directions on purpose (#1084): a declared exemption that " +
        "stops being true has to surface, or this check grows the silent-expiry " +
        `problem it exists to close. Edit \`${opts.exemptionsPath}\`.`,
    );
    lines.push("");
    lines.push("| Spec | Test | Declared reason | Problem |");
    lines.push("|---|---|---|---|");
    for (const p of [...v.staleExemptions, ...v.unverifiedExemptions]) {
      lines.push(
        `| \`${p.exemption.spec}\` | ${esc(p.exemption.title)} | ${esc(p.exemption.reason)} | ${esc(p.reason)} |`,
      );
    }
    lines.push("");
  }

  if (v.owned.length > 0) {
    lines.push("<details><summary>");
    lines.push(
      `${v.owned.length} removal(s) an open issue already names — no action here</summary>`,
    );
    lines.push("");
    lines.push("| Test | Spec | Reach | Trackers |");
    lines.push("|---|---|---|---|");
    for (const r of v.owned) {
      lines.push(
        `| ${esc(r.title)} | \`${r.relativePath}\`:${r.line} | ${reach(r)} | ${trackerCell(r)} |`,
      );
    }
    lines.push("");
    lines.push("</details>");
    lines.push("");
  }

  if (v.exempt.length > 0) {
    lines.push("<details><summary>");
    lines.push(`${v.exempt.length} declared-exempt removal(s)</summary>`);
    lines.push("");
    lines.push("| Test | Spec | Declared reason | Ref |");
    lines.push("|---|---|---|---|");
    for (const r of v.exempt) {
      lines.push(
        `| ${esc(r.title)} | \`${r.relativePath}\`:${r.line} | ${esc(r.exemption?.reason ?? "")} | ${r.exemption?.ref ?? "—"} |`,
      );
    }
    lines.push("");
    lines.push("</details>");
    lines.push("");
  }

  lines.push("---");
  lines.push("");
  lines.push(
    `Scanned ${v.counts.declared} declared test(s): ${v.counts.stable} carry \`@stable\`, ` +
      `${v.counts.laneGated} are lane-gated (\`@destructive\` / \`@enterprise\` / \`@serving\`, ` +
      "never combined with `@stable` — #1010), " +
      `${v.counts.neverStable} never carried the tag in the walked history.`,
  );
  lines.push("");
  lines.push(
    "To resolve a row: restore `@stable` on the `test(...)` call, or open an issue " +
      "that names the spec file and owns the restore, or — for a permanent, deliberate " +
      `absence — declare it in \`${opts.exemptionsPath}\`.`,
  );
  if (opts.runLabel) {
    lines.push("");
    lines.push(`<sub>Generated by ${opts.runLabel}.</sub>`);
  }
  return lines.join("\n");
}
