#!/usr/bin/env node
/**
 * Says, on a surface a human already reads, **which providers a run did not verify**
 * because their key was down — and fails the lane only when it verified none (#1456).
 *
 * ## The gap this closes
 *
 * When `collect-models` probes a provider `inactive`, every spec parametrized on it
 * `test.skip`s with the reason the sweep measured, and every decision on the way there
 * is individually right:
 *
 *  - the skip is CORRECT — a dead key cannot produce a verdict about Langflow;
 *  - `collect-models` deliberately DOWNGRADES a billing/quota outage to a warning
 *    (Approach B, #952): failing there reddens every LLM PR until someone tops up an
 *    account, which is the recurring #915/#910/#911 cost;
 *  - the lane is right not to hard-fail — #980's trade says a drained provider key
 *    must not kill the specs that never touch it.
 *
 * And the aggregate still reads as coverage that did not happen. Measured on PR
 * #1381's E2E lane, run 31698035402 (2026-08-13): **3 skipped / 5 passed / 1 flaky**,
 * check **SUCCESS**, where the three skips were the OpenAI targets of
 * `agent-multi-tool-selection.spec.ts` — the very provider `pr-validation.yml` pins
 * itself to (#1169). Nothing in the check status told that run apart from one where
 * those three tests ran and passed. That is the all-skip green #570 and #1012 exist to
 * prevent, arriving by a route neither covered.
 *
 * ## The decision (#1456), and why it is graded rather than binary
 *
 * A `::warning::` was ruled out at the outset: `mode=count` was printed in the daily's
 * prep log every run for weeks and read by nobody (#1252), and a second line in a
 * 2000-line log is the same artifact. So the verdict goes to the **run summary**, and
 * in one case to the **job status**:
 *
 *   covered    no provider-health skip at all              → silent, exit 0
 *   degraded   some provider went unverified, but the run   → SUMMARY HEADLINE naming
 *              still executed tests in the specs it gated     the provider and the
 *                                                             reason; exit 0, SUCCESS
 *   uncovered  NOTHING ran in the specs provider health     → headline + exit 1
 *              gated — the run measured nothing about them
 *
 * `degraded` keeps SUCCESS on purpose: the run did cover something (on the PR lane the
 * pin declines and the costlier multi-provider fallback runs the other providers), and
 * reddening a PR over an ops outage its author cannot fix is exactly #980's warning.
 * `uncovered` fails because at that point the lane's LLM evidence is empty, and an
 * empty verdict must never render as a pass.
 *
 * One consequence to state rather than discover: on a lane whose only provider-gated
 * spec is hardcoded to the drained provider, `uncovered` reddens the run even though a
 * top-up is the fix. That is the chosen trade — accepted knowing that the specs which
 * matter most here already hedge it. `openai-provider.spec.ts` deliberately leaves its
 * first test on the env-presence gate so it still runs on a dry day, which is enough to
 * make the file `degraded` rather than `uncovered`.
 *
 * ## What counts, and the one marker deliberately left out
 *
 * The subject is **provider health**, and the only marker is the one string
 * `inactiveReason()` in `tests/helpers/provider-setup/provider-health.ts` produces:
 *
 *   Provider "openai" inactive — You have no credits remaining.
 *
 * It is a single source read by both the hardcoded gate (`providerSkipGate`) and the
 * parametrized resolvers (`providerSkipReasons`), and it appears ONLY when
 * `collect-models` measured a live outage. `provider-health.test.ts` pins the producer
 * against this consumer's regex, so a reworded reason fails a unit test instead of
 * silently turning this verdict into a permanent `covered`.
 *
 * The sibling skip — `OPENAI_API_KEY required to run this test`, a key that is not
 * configured at all — is **excluded**, and not for lack of interest: it fires for keys
 * a lane legitimately does not carry. `composio.spec.ts` skips on `COMPOSIO_API_KEY`,
 * which no workflow sets, so counting it would make every PR touching that spec
 * `uncovered` and red. An unset secret is a real hole of the same family, and it is
 * #570's, not this one's.
 *
 * ## Why the report, and not providers.json
 *
 * `providers.json` says which keys were down; only the report says what that COST. The
 * distinction is the whole point of the daily's rotation: on a Wednesday with a dry
 * google key the rotation advances to another provider, no test skips at all, and this
 * verdict is honestly `covered` — the deviation is google's slot going unrun, which the
 * rotation script announces on its own summary (`select-daily-model-target.mjs`).
 * Two different losses, two different reporters; neither can see the other's.
 *
 * Measured on Playwright 1.58: a `test.skip(cond, reason)` — in the body or in a
 * `beforeEach` — lands as `annotations: [{ type: "skip", description: reason }]` on the
 * test, with `status: "skipped"`, and `merge-reports --reporter=json` preserves it, so
 * both the PR lane's direct json run and the daily's merged report answer this.
 *
 * ## Undecidable is not clean (#1012/#1035)
 *
 * A report this cannot read is reported `unknown`. It exits 2 when the run it is asked
 * about REPORTED SUCCESS — a lane that says it passed and cannot show what it covered
 * must not go green on this guard's silence — and exits 0 when the run already failed,
 * where the missing report is a symptom of a failure that is already red and named.
 *
 * Run:
 *   node scripts/provider-coverage-verdict.mjs --report results.json --lane pr-validation
 *
 * Outputs: a markdown block on `$GITHUB_STEP_SUMMARY` (or `--summary PATH`), one
 * annotation, `level` / `unverified` / `headline` on `$GITHUB_OUTPUT`, and the full
 * verdict as JSON on stdout.
 */

import fs from "node:fs";

/**
 * The one skip reason that means "collect-models measured this provider down".
 *
 * Kept tolerant on the dash (an em dash today) and on trailing whitespace, and
 * deliberately NOT tolerant on the rest: a looser pattern would start matching the
 * unconfigured-key skips this verdict excludes on purpose.
 */
export const PROVIDER_INACTIVE_SKIP = /^Provider "([^"]+)" inactive\s*[—–-]\s*([\s\S]*)$/;

const LEVELS = new Set(["covered", "degraded", "uncovered", "unknown"]);

/**
 * Flatten a Playwright JSON report into one row per test.
 *
 * Reads `suites[].specs[].tests[]` recursively rather than `stats`, because the
 * question is per-test (which reason, in which file) and `stats` only aggregates.
 * Everything is defensive: a shape this does not recognise yields zero rows, which the
 * caller reports as `unknown` rather than as `covered`.
 *
 * @param {unknown} report parsed Playwright JSON report
 * @returns {Array<{file: string, title: string, status: string, skipReasons: string[]}>}
 */
export function collectTests(report) {
  const rows = [];
  const walk = (suite) => {
    if (!suite || typeof suite !== "object") return;
    for (const spec of suite.specs ?? []) {
      if (!spec || typeof spec !== "object") continue;
      for (const test of spec.tests ?? []) {
        if (!test || typeof test !== "object") continue;
        rows.push({
          file: String(spec.file ?? suite.file ?? ""),
          title: String(spec.title ?? ""),
          status: String(test.status ?? ""),
          skipReasons: (test.annotations ?? [])
            .filter((a) => a && a.type === "skip")
            .map((a) => String(a.description ?? "").trim())
            .filter(Boolean),
        });
      }
    }
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const suite of report?.suites ?? []) walk(suite);
  return rows;
}

/**
 * The graded verdict for one run.
 *
 * `gated files` — the files that produced at least one provider-health skip — are the
 * denominator on purpose. A file is what a provider gates: the parametrized specs emit
 * one test per provider into the same file, so "openai skipped, anthropic ran" is
 * visible there and nowhere else, and a run that executed something in every gated file
 * did cover the surface, just not on every provider.
 *
 * @param {unknown} report parsed Playwright JSON report
 * @returns {{level: string, unverified: Array<{provider: string, reason: string, skipped: number}>, skipped: number, executed: number, gatedFiles: string[], totalTests: number}}
 */
export function providerCoverageVerdict(report) {
  const tests = collectTests(report);
  const gatedFiles = new Set();
  /** @type {Map<string, {provider: string, reason: string, skipped: number}>} */
  const byProvider = new Map();

  for (const test of tests) {
    if (test.status !== "skipped") continue;
    for (const reason of test.skipReasons) {
      const match = PROVIDER_INACTIVE_SKIP.exec(reason);
      if (!match) continue;
      const [, provider, detail] = match;
      gatedFiles.add(test.file);
      const entry = byProvider.get(provider) ?? {
        provider,
        reason: detail.trim() || "no reason recorded by collect-models",
        skipped: 0,
      };
      entry.skipped += 1;
      byProvider.set(provider, entry);
      // One test counts once even if it carries several skip annotations.
      break;
    }
  }

  const executed = tests.filter(
    (t) => gatedFiles.has(t.file) && t.status !== "skipped",
  ).length;
  const unverified = [...byProvider.values()].sort((a, b) =>
    a.provider.localeCompare(b.provider),
  );
  const skipped = unverified.reduce((n, e) => n + e.skipped, 0);

  const level =
    tests.length === 0
      ? "unknown"
      : unverified.length === 0
        ? "covered"
        : executed > 0
          ? "degraded"
          : "uncovered";

  return {
    level,
    unverified,
    skipped,
    executed,
    gatedFiles: [...gatedFiles].sort(),
    totalTests: tests.length,
  };
}

/**
 * The markdown block written to the step summary, and its one-line annotation.
 *
 * `covered` renders nothing: a headline on every green run is how a headline stops
 * being read (#1252). `unknown` DOES render — an unread report is not a clean one.
 *
 * @param {ReturnType<typeof providerCoverageVerdict> & {reason?: string}} verdict
 * @param {{lane?: string}} [options]
 * @returns {{markdown: string, annotation: string}}
 */
export function renderVerdict(verdict, options = {}) {
  const lane = options.lane ? ` (\`${options.lane}\`)` : "";
  if (verdict.level === "covered") return { markdown: "", annotation: "" };

  if (verdict.level === "unknown") {
    const why = verdict.reason ?? "the report carried no test result at all";
    return {
      markdown: [
        `### ❔ Provider coverage — UNKNOWN${lane}`,
        "",
        `Which providers this run verified could not be determined: ${why}.`,
        "Unknown is not clean (#1012) — read this as *no verdict*, not as a healthy run.",
        "",
      ].join("\n"),
      annotation: `Provider coverage UNKNOWN: ${why}`,
    };
  }

  const providers = verdict.unverified
    .map((p) => `\`${p.provider}\``)
    .join(", ");
  const rows = verdict.unverified.map(
    (p) => `| \`${p.provider}\` | ${p.skipped} | ${p.reason} |`,
  );

  if (verdict.level === "uncovered") {
    return {
      markdown: [
        `### 🚨 Provider coverage — NONE${lane}`,
        "",
        `**No provider was verified by this run.** Every test in the ${verdict.gatedFiles.length} ` +
          `spec file(s) gated on provider health was skipped (${verdict.skipped} skipped, 0 executed), ` +
          `so this run carries no evidence about ${providers} or any other provider.`,
        "",
        "| Provider | Tests skipped | What `collect-models` measured |",
        "| --- | --- | --- |",
        ...rows,
        "",
        "This is the reason the run is RED with no test failure: a run that measured nothing",
        "must not report as a pass (#570/#1012). Restore the account, then re-run — the specs",
        "themselves are not implicated.",
        "",
      ].join("\n"),
      annotation:
        `No provider was verified by this run: ${verdict.skipped} test(s) skipped and 0 executed ` +
        `across the spec file(s) gated on ${providers}.`,
    };
  }

  return {
    markdown: [
      `### ⚠️ Provider coverage — DEGRADED${lane}`,
      "",
      `${providers} ${verdict.unverified.length === 1 ? "was" : "were"} **not verified** by this ` +
        `run: ${verdict.skipped} test(s) skipped on provider health, while ${verdict.executed} ` +
        `test(s) still ran in the same ${verdict.gatedFiles.length} spec file(s).`,
      "",
      "| Provider | Tests skipped | What `collect-models` measured |",
      "| --- | --- | --- |",
      ...rows,
      "",
      "The run is green because it did cover something — an ops outage must not redden work",
      "that cannot fix it (#980). It is **not** evidence about the provider(s) above.",
      "",
    ].join("\n"),
    annotation:
      `${providers} not verified by this run (${verdict.skipped} test(s) skipped on provider ` +
      `health, ${verdict.executed} still ran).`,
  };
}

/**
 * Read the report. Absent or unparseable is a legitimate state to REPORT, never one to
 * crash on — the caller decides how loud it is, from whether the run it describes
 * claimed success.
 * @returns {{report: unknown, reason: string|null}}
 */
export function readReport(reportPath, { readFile, exists } = {}) {
  const fileExists = exists ?? ((p) => fs.existsSync(p));
  const read = readFile ?? ((p) => fs.readFileSync(p, "utf-8"));
  if (!fileExists(reportPath)) {
    return { report: null, reason: `${reportPath} does not exist` };
  }
  try {
    return { report: JSON.parse(read(reportPath)), reason: null };
  } catch (error) {
    return { report: null, reason: `${reportPath} is unreadable: ${error.message}` };
  }
}

const HELP = `usage: provider-coverage-verdict.mjs [options]

  --report PATH        Playwright JSON report (default: results.json)
  --lane NAME          lane name, for the summary heading
  --summary PATH       markdown sink (default: $GITHUB_STEP_SUMMARY)
  --github-output PATH key=value sink (default: $GITHUB_OUTPUT)
  --run-outcome NAME   outcome of the run this describes (success|failure|…). Decides
                       how loud an unreadable report is: on a run that claimed success
                       an undecidable verdict exits 2 (#1035).
`;

function parseArgs(argv) {
  const args = {
    report: "results.json",
    lane: "",
    summary: process.env.GITHUB_STEP_SUMMARY ?? "",
    githubOutput: process.env.GITHUB_OUTPUT ?? "",
    runOutcome: "",
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "-h" || flag === "--help") {
      args.help = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`missing value for ${flag}`);
    i++;
    if (flag === "--report") args.report = value;
    else if (flag === "--lane") args.lane = value;
    else if (flag === "--summary") args.summary = value;
    else if (flag === "--github-output") args.githubOutput = value;
    else if (flag === "--run-outcome") args.runOutcome = value;
    else throw new Error(`unknown flag: ${flag}`);
  }
  return args;
}

/**
 * The exit code for a verdict. Split out so the policy is testable without a process:
 * `uncovered` is the only failing verdict, and `unknown` fails only where its silence
 * would be read as a pass.
 * @param {string} level
 * @param {string} runOutcome
 * @returns {number}
 */
export function exitCodeFor(level, runOutcome) {
  if (level === "uncovered") return 1;
  if (level === "unknown") return runOutcome === "success" ? 2 : 0;
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`::error::provider-coverage-verdict: ${error.message}\n`);
    process.exit(2);
  }
  if (args.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }

  const { report, reason } = readReport(args.report);
  const verdict = report
    ? providerCoverageVerdict(report)
    : {
        level: "unknown",
        unverified: [],
        skipped: 0,
        executed: 0,
        gatedFiles: [],
        totalTests: 0,
      };
  if (reason) verdict.reason = reason;
  if (verdict.level === "unknown" && !verdict.reason) {
    verdict.reason = "the report carried no test result at all";
  }
  if (!LEVELS.has(verdict.level)) verdict.level = "unknown";

  const { markdown, annotation } = renderVerdict(verdict, { lane: args.lane });

  if (markdown && args.summary) {
    try {
      fs.appendFileSync(args.summary, `${markdown}\n`);
    } catch (error) {
      // The summary is the primary surface, so a failure to write it must be said out
      // loud — but it must not swallow the verdict itself, which the annotation and
      // the exit code still carry.
      process.stderr.write(
        `::warning::provider-coverage-verdict: could not write the run summary: ${error.message}\n`,
      );
    }
  }
  if (annotation) {
    const level = verdict.level === "uncovered" ? "error" : "warning";
    process.stderr.write(`::${level}::provider-coverage-verdict: ${annotation}\n`);
  }

  if (args.githubOutput) {
    try {
      fs.appendFileSync(
        args.githubOutput,
        [
          `level=${verdict.level}`,
          `unverified=${verdict.unverified.map((p) => p.provider).join(",")}`,
          `skipped=${verdict.skipped}`,
          `executed=${verdict.executed}`,
        ].join("\n") + "\n",
      );
    } catch (error) {
      process.stderr.write(
        `::warning::provider-coverage-verdict: could not write step outputs: ${error.message}\n`,
      );
    }
  }

  process.stdout.write(`${JSON.stringify(verdict)}\n`);
  process.exit(exitCodeFor(verdict.level, args.runOutcome));
}
