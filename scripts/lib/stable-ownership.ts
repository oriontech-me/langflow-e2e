/**
 * Does every spec whose tests carry no `@stable` have an owner? (#1770)
 *
 * Such a spec runs in no scheduled lane: the daily greps `@stable`, and nothing
 * else is scheduled. Until this check, nothing reconciled "specs that run
 * nowhere" against "open issues that own putting them somewhere", and the
 * inherited-spec audit found 55 of them with no owner at all.
 *
 * Pure and total: `scripts/check-stable-ownership.ts` does the IO, this decides.
 * Design: `docs/triage/inherited-spec-triage-design.md` §5.
 *
 * NOT #1746's question. That reconciler is about a tag that was REMOVED — it
 * walks git history to date the removal and asks who owns the restore. This is
 * about a spec nobody is holding, whatever its history. Same thesis, separate
 * reports, and the two deliberately share their inputs instead of duplicating
 * them: the tracker matcher (`buildSpecTrackerIndex`) and the declared
 * absences (`stable-orphan-exemptions.json`) both come from #1746, so the two
 * reports cannot disagree about whether a spec is owned or declared.
 *
 * Three decisions differ from the plan's first draft, each on a measurement
 * recorded in the plan's Task 8:
 *
 * 1. No second exemptions file. Its only two entries were already declared
 *    for #1746, and one declaration in two files is the silent-expiry hazard
 *    both checks were built to close.
 * 2. No `expired-exemption` keyed on "the cited issue is closed". Both real
 *    declarations cite #1039, which is closed and is PROVENANCE for a standing
 *    packaging policy — that rule would have expired both on the first run.
 *    #1746 already verifies each declaration against the test's actual state,
 *    which is the expiry that means something.
 * 3. Severity follows the DIFF, not the baseline alone. The daily strips
 *    `@stable` from a hard-failing test and commits to `main` itself, so a spec
 *    can leave the daily with no PR involved; failing every later PR on it
 *    would be #980's inversion. And the PR lane reads the baseline from the
 *    BASE ref, so regenerating it inside the PR cannot hide a new spec.
 */

/**
 * The standing report issue's identity. It is excluded from every tracker
 * search — this guard's and #1746's — because its body names every unowned
 * spec: counted as a tracker, it would mark them all owned on the next run,
 * empty itself, and bring the findings back the run after. The workflow reads
 * the title from the script's output and never spells it a second time.
 */
export const OWNERSHIP_ISSUE_TITLE =
  "[@stable] specs no scheduled lane runs and no open issue owns";

export type OwnershipVerdict =
  | "owned"
  | "exempt"
  | "unowned-baseline"
  | "unowned-new"
  | "unknown";

export interface OwnershipRow {
  /** Path under `tests/tests-automations/regression/`. */
  spec: string;
  verdict: OwnershipVerdict;
  detail: string;
}

export interface OwnershipInput {
  /** Specs whose tests carry no `@stable` — `collectBacklog()`'s specs. */
  backlogSpecs: readonly string[];
  /** The frozen baseline. On the PR lane, read from the BASE ref. */
  baselineSpecs: readonly string[];
  /** Spec → reason, for every spec #1746's declarations name. */
  exemptSpecs: ReadonlyMap<string, string>;
  /** Spec → open issues naming it; `null` when the lookup failed. */
  trackers: Readonly<Record<string, readonly { number: number }[]>> | null;
  /** Why the lookup failed, when it did — carried into every row it decides. */
  lookupError?: string;
  /**
   * Specs the PR changed. Absent means "no diff context" — the daily — where a
   * spec outside the baseline is a warning, never a failure.
   */
  changedSpecs?: ReadonlySet<string>;
}

export interface OwnershipReport {
  rows: OwnershipRow[];
  /** Fail the run: an unowned spec THIS PR touched, or a row we could not decide. */
  failures: OwnershipRow[];
  /** Report loudly, never fail: an unowned spec outside the baseline nobody's diff introduced. */
  warnings: OwnershipRow[];
  /** Report quietly: the frozen baseline, which the triage wave is retiring. */
  notices: OwnershipRow[];
  counts: Record<OwnershipVerdict, number>;
  lookupFailed: boolean;
}

export function ownershipReport(input: OwnershipInput): OwnershipReport {
  const baseline = new Set(input.baselineSpecs);
  const rows: OwnershipRow[] = [];
  const failures: OwnershipRow[] = [];
  const warnings: OwnershipRow[] = [];
  const notices: OwnershipRow[] = [];
  const lookupFailed = input.trackers === null;

  for (const spec of [...new Set(input.backlogSpecs)].sort()) {
    // Read from a committed file, not from GitHub: an outage decides nothing
    // about it, and calling the row `unknown` would name the wrong cause.
    const reason = input.exemptSpecs.get(spec);
    if (reason !== undefined) {
      rows.push({ spec, verdict: "exempt", detail: reason });
      continue;
    }

    if (input.trackers === null) {
      const row: OwnershipRow = {
        spec,
        verdict: "unknown",
        detail:
          `the open-issue lookup failed${input.lookupError ? ` (${input.lookupError})` : ""}, ` +
          "so ownership could not be read — a verdict this check cannot produce is not a pass",
      };
      rows.push(row);
      failures.push(row);
      continue;
    }

    const owners = input.trackers[spec] ?? [];
    if (owners.length > 0) {
      rows.push({
        spec,
        verdict: "owned",
        detail: `owned by ${owners.map((o) => `#${o.number}`).join(", ")}`,
      });
      continue;
    }

    if (baseline.has(spec)) {
      const row: OwnershipRow = {
        spec,
        verdict: "unowned-baseline",
        detail: "in the frozen triage baseline; no open issue owns it",
      };
      rows.push(row);
      notices.push(row);
      continue;
    }

    const touched = input.changedSpecs?.has(spec) ?? false;
    const row: OwnershipRow = {
      spec,
      verdict: "unowned-new",
      detail: touched
        ? "this PR leaves the spec with no @stable test, outside the frozen baseline, and no open issue owns it — open one that names the file, or restore @stable"
        : "outside the frozen baseline and no open issue owns it; no diff under review introduced it, so it most likely lost its last @stable on main (the daily's auto-removal)",
    };
    rows.push(row);
    (touched ? failures : warnings).push(row);
  }

  const counts: Record<OwnershipVerdict, number> = {
    owned: 0,
    exempt: 0,
    "unowned-baseline": 0,
    "unowned-new": 0,
    unknown: 0,
  };
  for (const r of rows) counts[r.verdict]++;

  return { rows, failures, warnings, notices, counts, lookupFailed };
}

/** Something the standing issue should say: any row that is neither owned nor declared. */
export function hasOwnershipFindings(report: OwnershipReport): boolean {
  return report.rows.some((r) => r.verdict !== "owned" && r.verdict !== "exempt");
}

export interface RenderOptions {
  /** A markdown link to the run that produced this, when there is one. */
  runLabel?: string;
}

const table = (rows: OwnershipRow[]): string[] => [
  "| Spec | Verdict | Detail |",
  "|---|---|---|",
  ...rows.map((r) => `| \`${r.spec}\` | ${r.verdict} | ${r.detail.replace(/\|/g, "\\|")} |`),
];

export function renderOwnershipReport(report: OwnershipReport, opts: RenderOptions): string {
  const c = report.counts;
  const out: string[] = [];
  out.push(
    `**${report.rows.length} spec(s) with no \`@stable\` test** — ` +
      `${c["unowned-new"]} unowned outside the baseline, ${c["unowned-baseline"]} unowned in the baseline, ` +
      `${c.unknown} undecidable, ${c.owned} owned, ${c.exempt} declared.` +
      (opts.runLabel ? ` Run: ${opts.runLabel}.` : ""),
    "",
    "A spec whose tests carry no `@stable` runs in no scheduled lane. It needs an **open** issue that names the file, " +
      "or a declared absence in `scripts/lib/stable-orphan-exemptions.json` (#1770). " +
      "Tags that were **removed** are reported separately, with the commit that removed them — see #1746's report.",
  );

  if (report.rows.length === 0) {
    out.push("", "No spec is missing `@stable` — nothing to own.");
    return out.join("\n");
  }

  const sections: [string, OwnershipRow[]][] = [
    ["Undecidable — the issue lookup failed", report.rows.filter((r) => r.verdict === "unknown")],
    ["Unowned, outside the frozen baseline", report.rows.filter((r) => r.verdict === "unowned-new")],
    ["Unowned, in the frozen baseline (the triage wave is retiring these)", report.notices],
  ];
  for (const [heading, rows] of sections) {
    if (rows.length === 0) continue;
    out.push("", `## ${heading}`, "", ...table(rows));
  }

  const settled = report.rows.filter((r) => r.verdict === "owned" || r.verdict === "exempt");
  if (settled.length > 0) {
    out.push("", "<details><summary>", `${settled.length} spec(s) owned or declared — no action here</summary>`, "", ...table(settled), "", "</details>");
  }
  return out.join("\n");
}

/**
 * The lines appended to `$GITHUB_OUTPUT`. The body carries repo-authored text,
 * so the caller passes a per-run delimiter — and a delimiter that occurs in the
 * body is refused, because it would truncate the heredoc without an error.
 */
export function ownershipOutputLines(report: OwnershipReport, markdown: string, delimiter: string): string[] {
  if (markdown.split("\n").some((line) => line.includes(delimiter))) {
    throw new Error(`the report body contains the output delimiter ${delimiter}; refusing to emit a truncated summary`);
  }
  return [
    `has_findings=${hasOwnershipFindings(report)}`,
    `failure_count=${report.failures.length}`,
    `tracker_lookup_failed=${report.lookupFailed}`,
    `issue_title=${OWNERSHIP_ISSUE_TITLE}`,
    `summary_md<<${delimiter}`,
    markdown,
    delimiter,
  ];
}
