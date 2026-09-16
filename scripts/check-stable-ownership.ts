/**
 * Does every spec whose tests carry no `@stable` have an owner? (#1770)
 *
 *   npm run check:stable-ownership                                  # the daily's view
 *   npx ts-node scripts/check-stable-ownership.ts --base-ref origin/main   # the PR lane
 *   … [--markdown out.md] [--json out.json]
 *
 * The verdict lives in `lib/stable-ownership.ts`; this file only gathers its
 * inputs, and the two lanes differ in exactly two of them:
 *
 * - `--base-ref <ref>` (the PR lane) reads the frozen baseline FROM THAT REF and
 *   the specs this PR changed from `git diff <ref>...HEAD`. The ref matters: a PR
 *   that regenerated the baseline to include the spec it adds would otherwise
 *   turn its own failure into a quiet notice. A spec outside the baseline fails
 *   only when this diff touched it (#980).
 * - Without it (the daily), the working-tree baseline is read and there is no
 *   diff, so nothing is a diff failure — the standing issue carries the report.
 *
 * Exit 1 on a failure row, and on a run that could not decide: an unreadable
 * baseline, a diff that could not be taken, a failed issue lookup (#1012). The
 * owners come from #1746's `fetchOpenIssues` + `buildSpecTrackerIndex` and the
 * declared absences from #1746's exemptions file — shared, not copied, so the
 * two reports cannot disagree about the same spec.
 *
 * `process.exitCode`, never `process.exit(run())`: the markdown body can be tens
 * of kilobytes, and `exit` discards whatever a piped stdout has not flushed.
 */
import { execFileSync } from "child_process";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { collectBacklog } from "./lib/inherited-backlog";
import { REPO_ROOT } from "./lib/stable-tests";
import type { ExemptionDecl } from "./lib/stable-orphans";
import {
  hasOwnershipFindings,
  ownershipOutputLines,
  ownershipReport,
  renderOwnershipReport,
  type OwnershipReport,
} from "./lib/stable-ownership";
import {
  EXEMPTIONS_PATH,
  buildSpecTrackerIndex,
  fetchOpenIssues,
  parseExemptions,
  withoutReportIssues,
  type RawIssue,
} from "./reconcile-stable-orphans";
import { BASELINE_PATH } from "./update-inherited-backlog-baseline";

const REGRESSION_PREFIX = "tests/tests-automations/regression/";
const BASELINE_REL = path.relative(REPO_ROOT, BASELINE_PATH).split(path.sep).join("/");

/** Repo-relative changed paths → regression-relative spec paths. */
export function specsFromDiffNames(names: readonly string[]): Set<string> {
  const specs = new Set<string>();
  for (const name of names) {
    if (!name.startsWith(REGRESSION_PREFIX) || !name.endsWith(".spec.ts")) continue;
    specs.add(name.slice(REGRESSION_PREFIX.length));
  }
  return specs;
}

/**
 * The baseline's spec paths. Every malformed shape throws: read as "no
 * baseline", it would make every backlog spec new at once.
 */
export function parseBaselineSpecs(text: string, where: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`${where} is not valid JSON: ${(e as Error).message}`);
  }
  const specs = (parsed as { specs?: unknown })?.specs;
  if (!Array.isArray(specs)) throw new Error(`${where} must have a "specs" array at the top level`);
  return specs.map((s, i) => {
    const rel = (s as { relativePath?: unknown })?.relativePath;
    if (typeof rel !== "string" || rel === "") {
      throw new Error(`${where}: specs[${i}] has no string "relativePath"`);
    }
    return rel;
  });
}

/** #1746's per-test declarations, seen per spec. */
export function exemptSpecsFrom(decls: readonly ExemptionDecl[]): Map<string, string> {
  const reasons = new Map<string, string[]>();
  for (const d of decls) {
    const list = reasons.get(d.spec) ?? [];
    if (!list.includes(d.reason)) list.push(d.reason);
    reasons.set(d.spec, list);
  }
  return new Map([...reasons].map(([spec, list]) => [spec, list.join(" ")]));
}

/** GitHub's workflow-command escaping for annotation messages. */
const escapeData = (s: string): string =>
  s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");

/**
 * Workflow commands for the PR lane. The frozen baseline is ONE notice: GitHub
 * keeps ten annotations of a kind per step and drops the rest silently, and the
 * baseline alone is dozens of specs. The full table goes to the step summary.
 */
export function annotationLines(report: OwnershipReport): string[] {
  const title = "title=@stable ownership (#1770)";
  const lines: string[] = [];
  for (const r of report.failures) {
    lines.push(`::error file=${REGRESSION_PREFIX}${r.spec},${title}::${escapeData(`${r.spec}: ${r.detail}`)}`);
  }
  for (const r of report.warnings) {
    lines.push(`::warning file=${REGRESSION_PREFIX}${r.spec},${title}::${escapeData(`${r.spec}: ${r.detail}`)}`);
  }
  if (report.notices.length > 0) {
    lines.push(
      `::notice ${title}::${escapeData(
        `${report.notices.length} spec(s) in the frozen triage baseline have no @stable test and no open issue that owns them. ` +
          "Pre-existing, so not a failure here — the full list is in the job summary.",
      )}`,
    );
  }
  return lines;
}

export interface OwnershipDeps {
  backlogSpecs: () => string[];
  /** The baseline file's text, at `ref` when given, else from the working tree. */
  readBaseline: (ref: string | undefined) => string;
  readExemptions: () => string;
  fetchIssues: () => RawIssue[];
  /** Repo-relative paths changed between `ref` and HEAD. */
  changedFiles: (ref: string) => string[];
  env: Record<string, string | undefined>;
  log: (s: string) => void;
  error: (s: string) => void;
  writeFile: (file: string, text: string) => void;
  appendGithubOutput: (text: string) => void;
  appendStepSummary: (text: string) => void;
}

const git = (args: string[]): string =>
  execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });

export const realDeps: OwnershipDeps = {
  backlogSpecs: () => collectBacklog().specs.map((s) => s.relativePath),
  readBaseline: (ref) =>
    ref ? git(["show", `${ref}:${BASELINE_REL}`]) : fs.readFileSync(BASELINE_PATH, "utf-8"),
  readExemptions: () => fs.readFileSync(path.join(REPO_ROOT, EXEMPTIONS_PATH), "utf-8"),
  fetchIssues: fetchOpenIssues,
  changedFiles: (ref) =>
    git(["diff", "--name-only", "--diff-filter=d", `${ref}...HEAD`, "--", REGRESSION_PREFIX])
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean),
  env: process.env,
  log: (s) => console.log(s),
  error: (s) => console.error(s),
  writeFile: (file, text) => fs.writeFileSync(file, text),
  appendGithubOutput: (text) => fs.appendFileSync(process.env.GITHUB_OUTPUT as string, text),
  appendStepSummary: (text) => fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY as string, text),
};

function argValue(argv: readonly string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
}

const firstLine = (e: unknown): string =>
  (e instanceof Error ? e.message : String(e)).split("\n").map((l) => l.trim()).find(Boolean) ?? "no message";

export function run(argv: readonly string[], deps: OwnershipDeps = realDeps): number {
  const baseRef = argValue(argv, "--base-ref");
  if (argv.includes("--base-ref") && !baseRef) {
    deps.error("check-stable-ownership: --base-ref needs a ref");
    return 1;
  }

  // The three inputs a verdict cannot stand without. Each failure is a broken
  // RUN, named, never an empty report.
  let backlogSpecs: string[];
  let baselineSpecs: string[];
  let exemptSpecs: Map<string, string>;
  let changedSpecs: Set<string> | undefined;
  try {
    backlogSpecs = deps.backlogSpecs();
  } catch (e) {
    deps.error(`check-stable-ownership: the spec parse failed — ${firstLine(e)}`);
    return 1;
  }
  const where = baseRef ? `${BASELINE_REL} at ${baseRef}` : BASELINE_REL;
  try {
    baselineSpecs = parseBaselineSpecs(deps.readBaseline(baseRef), where);
  } catch (e) {
    deps.error(
      `check-stable-ownership: cannot read the frozen baseline (${where}) — ${firstLine(e)}. ` +
        "Without it every spec would read as new, so the run stops here. " +
        (baseRef
          ? `Check that ${baseRef} is fetched and carries the file.`
          : "Refresh it with `npm run triage:baseline`."),
    );
    return 1;
  }
  try {
    exemptSpecs = exemptSpecsFrom(parseExemptions(deps.readExemptions(), EXEMPTIONS_PATH));
  } catch (e) {
    deps.error(`check-stable-ownership: cannot read the declared absences — ${firstLine(e)}`);
    return 1;
  }
  if (baseRef) {
    try {
      changedSpecs = specsFromDiffNames(deps.changedFiles(baseRef));
    } catch (e) {
      deps.error(`check-stable-ownership: cannot take the diff against ${baseRef} — ${firstLine(e)}`);
      return 1;
    }
  }

  // The lookup is the one input whose failure is REPORTED rather than fatal to
  // the render: every row it decides becomes `unknown`, which fails the run.
  let trackers: ReturnType<typeof buildSpecTrackerIndex> | null = null;
  let lookupError: string | undefined;
  try {
    // `fetchOpenIssues` already drops both report issues; filtering again here
    // makes that a property of THIS guard rather than of whichever fetch it was
    // handed — the self-ownership oscillation is the one bug this design can
    // produce on its own.
    trackers = buildSpecTrackerIndex(withoutReportIssues(deps.fetchIssues()), backlogSpecs);
  } catch (e) {
    lookupError = firstLine(e);
  }

  const report = ownershipReport({
    backlogSpecs,
    baselineSpecs,
    exemptSpecs,
    trackers,
    lookupError,
    changedSpecs,
  });

  const runLabel = deps.env.RUN_LABEL || undefined;
  const markdown = renderOwnershipReport(report, { runLabel });

  const mdOut = argValue(argv, "--markdown");
  if (mdOut) deps.writeFile(mdOut, `${markdown}\n`);
  const jsonOut = argValue(argv, "--json");
  if (jsonOut) deps.writeFile(jsonOut, `${JSON.stringify(report, null, 2)}\n`);

  for (const r of report.rows) {
    if (r.verdict === "owned" || r.verdict === "exempt") continue;
    deps.log(`${r.verdict.padEnd(17)} ${r.spec} — ${r.detail}`);
  }
  const c = report.counts;
  deps.log(
    `[ownership] ${report.rows.length} spec(s) with no @stable test: ` +
      `${c.owned} owned, ${c.exempt} declared, ${c["unowned-baseline"]} unowned in the baseline, ` +
      `${c["unowned-new"]} unowned outside it, ${c.unknown} undecidable — ` +
      `${report.failures.length} failure(s)` +
      (baseRef ? ` (diff against ${baseRef})` : " (no diff: nothing is a diff failure)"),
  );

  if (deps.env.GITHUB_ACTIONS === "true") {
    for (const line of annotationLines(report)) deps.log(line);
  }
  if (deps.env.GITHUB_STEP_SUMMARY) {
    deps.appendStepSummary(`${markdown}\n`);
  }
  if (deps.env.GITHUB_OUTPUT) {
    // Per-run, because the body carries repo-authored text.
    const delimiter = `__OWNERSHIP_EOF_${randomUUID().replace(/-/g, "")}__`;
    deps.appendGithubOutput(`${ownershipOutputLines(report, markdown, delimiter).join("\n")}\n`);
  }

  if (!hasOwnershipFindings(report)) {
    deps.log("[ownership] every spec with no @stable test is owned or declared.");
  }
  return report.failures.length > 0 ? 1 : 0;
}

if (require.main === module) {
  try {
    process.exitCode = run(process.argv.slice(2));
  } catch (e) {
    console.error(`check-stable-ownership: ${firstLine(e)}`);
    process.exitCode = 1;
  }
}
