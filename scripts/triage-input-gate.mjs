#!/usr/bin/env node
/**
 * Decides whether `triage-dispatch.yml`'s propose job should start the triage
 * agent at all, from the report the triggering daily produced (#1178).
 *
 * ## Why this gate exists
 *
 * The propose job downloads the daily's `results.json` "best-effort" and, when
 * the artifact is missing, prints `no results.json — history-only` and runs the
 * agent anyway. On 2026-07-31 that cost the maximum: the daily's four shards all
 * failed without producing a blob, the merge job died on `No report files found
 * in .../all-blobs`, and no `results.json` was ever uploaded. The agent then
 * reconstructed the run from scratch through `Bash` — 28 of its 30 allowed turns,
 * on `claude-opus-5[1m]`, **$1.66** (its own log reports `num_turns` and
 * `total_cost_usd`) — to triage a run that had recorded **zero test results**.
 *
 * There is nothing to triage in that state: no failures to group, no clusters to
 * dedup against open issues. The decision is cheap and deterministic, so it
 * belongs before the agent, not inside it.
 *
 * ## Why it reuses `analyze()` rather than parsing the report itself
 *
 * `scripts/check-run-integrity.mjs` already owns "did this run actually produce
 * tests" for the daily's own `runguard` step (#1012), including the case that
 * makes a naive test-count check wrong: a **partial** run, where some shards
 * aborted in `globalSetup` while others executed (#1058, measured on run
 * 30444299314 — 205 tests recorded while ~184 never ran). A second
 * implementation here would be a second thing to keep in sync, and the two
 * disagreeing is exactly how a guard goes quietly wrong.
 *
 * ## The decision
 *
 * | Report state                          | Agent | Why |
 * |---------------------------------------|-------|-----|
 * | artifact absent                       | no    | the daily produced nothing |
 * | present, `testsTotal === 0`           | no    | infra abort, not a per-test day (#1012) |
 * | present, `partial`                    | YES   | real failures alongside an abort — the #1058 case worth triaging |
 * | present, healthy                      | YES   | ordinary red daily |
 * | present but unparseable               | ERROR | an undecidable verdict must not read as "nothing to triage" (#1035) |
 *
 * The skip path is **loud** — a `::warning::` plus a job-summary line naming the
 * state observed — so an abort day is visible rather than silent (#1012's rule).
 * It deliberately does not comment on the umbrella: on an abort there may be no
 * umbrella at all (none was opened for 2026-07-31), and creating one is the
 * agent's job behind the propose-confirm gate, not this script's.
 *
 * Run:
 *   node scripts/triage-input-gate.mjs [--results results.json]
 *
 * Output (stdout, JSON): { runAgent, verdict, reason, testsTotal }
 * Side effects: `should_run_agent` / `verdict` / `reason` on `$GITHUB_OUTPUT`,
 * one line on `$GITHUB_STEP_SUMMARY`.
 */

import fs from "node:fs";
import { analyze } from "./check-run-integrity.mjs";

const HELP = `usage: triage-input-gate.mjs [options]

  --results PATH   merged Playwright JSON report downloaded from the daily
                   (default: results.json)
`;

const DEFAULT_RESULTS = "results.json";

/**
 * Pure decision. `readReport` returns the parsed report, `null` when the file is
 * absent, and THROWS when the file exists but does not parse — the caller turns
 * that into a hard error rather than a skip.
 *
 * @returns {{ runAgent: boolean, verdict: string, reason: string, testsTotal: number }}
 */
export function decideTriageInput(resultsPath, readReport) {
  const report = readReport(resultsPath);

  if (report === null) {
    return {
      runAgent: false,
      verdict: "no-report",
      reason:
        `${resultsPath} was not produced by the triggering run — the daily ` +
        `uploaded no merged report, so there are no failures to group and ` +
        `nothing to dedup. Skipping the agent instead of letting it reconstruct ` +
        `the run through Bash (that path cost 28 turns / $1.66 on 2026-07-31).`,
      testsTotal: 0,
    };
  }

  const state = analyze(report);

  if (state.empty) {
    return {
      runAgent: false,
      verdict: "zero-tests",
      reason:
        `the triggering run recorded ZERO test results` +
        (state.aborted
          ? ` and carries ${state.reportErrors} top-level error(s) — the shards ` +
            `aborted before the first test`
          : ``) +
        `. That is an infra abort, not a per-test day (#1012), so there is ` +
        `nothing for the agent to triage.`,
      testsTotal: 0,
    };
  }

  if (state.partial) {
    return {
      runAgent: true,
      verdict: "partial",
      reason:
        `${state.testsTotal} test result(s) recorded alongside ` +
        `${state.reportErrors} top-level error(s) — some shards aborted while ` +
        `others ran (#1058). The recorded failures are worth triaging, and the ` +
        `abort is part of what the plan must say.`,
      testsTotal: state.testsTotal,
    };
  }

  return {
    runAgent: true,
    verdict: "usable",
    reason: `${state.testsTotal} test result(s) recorded — ordinary triage input.`,
    testsTotal: state.testsTotal,
  };
}

/**
 * Absent → `null`. Present-but-unparseable → throw, so the CLI can fail loudly
 * instead of reporting the healthy "nothing to triage" verdict for a state it
 * could not read.
 */
export function readReportOrThrow(resultsPath, io = {}) {
  const exists = io.exists ?? ((p) => fs.existsSync(p));
  const read = io.readFile ?? ((p) => fs.readFileSync(p, "utf8"));

  if (!exists(resultsPath)) return null;
  const raw = read(resultsPath);
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `${resultsPath} exists but does not parse as JSON (${error.message}) — ` +
        `refusing to report a verdict this gate could not derive`,
    );
  }
}

function parseArgs(argv) {
  const args = { results: DEFAULT_RESULTS };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--help" || flag === "-h") {
      args.help = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`missing value for ${flag}`);
    i++;
    if (flag === "--results") args.results = value;
    else throw new Error(`unknown flag: ${flag}`);
  }
  return args;
}

function appendLine(envVar, line) {
  const target = process.env[envVar];
  if (target) fs.appendFileSync(target, `${line}\n`);
}

if (process.argv[1] && process.argv[1].endsWith("triage-input-gate.mjs")) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`::error::triage-input-gate: ${error.message}\n`);
    process.exit(2);
  }
  if (args.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }

  let decision;
  try {
    decision = decideTriageInput(args.results, (p) => readReportOrThrow(p));
  } catch (error) {
    process.stderr.write(`::error::triage-input-gate: ${error.message}\n`);
    process.exit(2);
  }

  appendLine("GITHUB_OUTPUT", `should_run_agent=${decision.runAgent}`);
  appendLine("GITHUB_OUTPUT", `verdict=${decision.verdict}`);
  appendLine("GITHUB_OUTPUT", `reason=${decision.reason.replace(/\n/g, " ")}`);

  if (decision.runAgent) {
    process.stderr.write(
      `triage input OK (${decision.verdict}): ${decision.reason}\n`,
    );
    appendLine(
      "GITHUB_STEP_SUMMARY",
      `**Triage input:** \`${decision.verdict}\` — ${decision.reason}`,
    );
  } else {
    // Loud, never silent: an abort day must be distinguishable from a quiet
    // healthy one in the job log AND in the run summary.
    process.stderr.write(`::warning::triage-input-gate: ${decision.reason}\n`);
    appendLine(
      "GITHUB_STEP_SUMMARY",
      `**Triage agent SKIPPED** (\`${decision.verdict}\`) — ${decision.reason}`,
    );
  }

  process.stdout.write(`${JSON.stringify(decision)}\n`);
  process.exit(0);
}
