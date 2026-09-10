#!/usr/bin/env node
/**
 * Says, on a surface a human already reads, **which providers a run did not verify**
 * because their key was down — and fails the lane only when none was usable (#1456).
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
 * ## The decision (#1456), and where the failing line is drawn
 *
 * A `::warning::` was ruled out at the outset: `mode=count` was printed in the daily's
 * prep log every run for weeks and read by nobody (#1252), and a second line in a
 * 2000-line log is the same artifact. So the verdict goes to the **run summary**, and
 * in one case to the **job status**:
 *
 *   covered    no provider-health skip                     → silent, exit 0
 *   degraded   a provider went unverified, and the account → SUMMARY HEADLINE naming
 *              still had a usable one                        the provider and the
 *                                                            reason; exit 0, SUCCESS
 *   uncovered  a provider went unverified and NO provider  → headline + exit 1
 *              was usable at all
 *
 * **The failing line is "was any provider usable", not "did any test run", and the
 * difference is the whole correctness of this file.** The first version counted tests
 * that executed in the spec files that produced a skip, which is wrong in both
 * directions and was caught in review before it ever ran:
 *
 *  - FALSE RED. A run with `rag-pipeline.spec.ts` (gated on google, wholly skipped)
 *    and `openai-provider.spec.ts` (two tests, both passed) scored `uncovered` and
 *    printed "no evidence about `google` or any other provider" while openai had just
 *    been verified in the same report — because a file that produces no skip is not a
 *    gated file and its passing tests were therefore invisible. Twelve spec files are
 *    wholly gated on one provider, so a PR editing any one of them during a drain
 *    would have gone red for a reason its author cannot fix — #980 inverted, on the
 *    lane a human is waiting on.
 *  - FALSE GREEN, on the lane the issue actually asked about. The daily runs all three
 *    `*-provider.spec.ts`, and each deliberately leaves its FIRST test on the
 *    env-presence gate so it still runs on a dry day. That test executes inside a
 *    gated file, so `uncovered` was unreachable on the daily even with all three
 *    providers down — the exact day the mechanism exists for.
 *
 * Asking whether the account had a usable provider fixes both, and it draws the line
 * where a re-run stops being able to help: with one provider left alive the lane can
 * still be re-dispatched into coverage, and with none it cannot until someone acts.
 * Note the consequence and do not mistake it for an oversight: a run whose selection
 * touched only the dead provider reports `degraded`, not `uncovered`, because another
 * provider WAS available. The headline still names what went unverified — the verdict
 * decides the colour, the headline decides what is known.
 *
 * ## What "usable" is read from, and what happens without it
 *
 * `providers.json`, the file `collect-models` writes and every gate in this repo
 * already reads. Usability is a property of the ACCOUNT, and the report cannot answer
 * it: a healthy provider leaves no trace in the report at all, which is exactly how
 * the first version got it wrong.
 *
 * With several files (the daily's shards each collect their own) a provider counts as
 * usable if ANY of them recorded it active — the fail-open direction, since one shard
 * reaching a provider proves the account could.
 *
 * With NO readable file, usability is UNKNOWN and the verdict degrades to `degraded`
 * with the gap stated in the summary. That is the one place this guard deliberately
 * does not fail closed: `uncovered` fails a lane, and failing it on the ABSENCE of a
 * file that is legitimately absent (a skipped sweep, a `continue-on-error` canary)
 * would redden runs for a missing optional input. It is never silent, which is the
 * part #1012 asks for.
 *
 * ## What counts as a skip, and the one marker deliberately left out
 *
 * The subject is **provider health**, and the only marker is the one string
 * `inactiveReason()` in `tests/helpers/provider-setup/provider-health.ts` produces:
 *
 *   Provider "openai" inactive — You have no credits remaining.
 *
 * It is a single source read by both the hardcoded gate (`providerSkipGate`) and the
 * parametrized resolvers (`providerSkipReasons`). `provider-health.test.ts` pins the
 * producer against this consumer's regex, so a reworded reason fails a unit test
 * instead of silently turning this verdict into a permanent `covered`. One nuance: a
 * record written by `degradeProviders()` (the credentials pre-flight, #1058) is a
 * STRUCTURAL failure rather than an outage and reads identically here — correctly, its
 * cost to coverage is the same.
 *
 * The sibling skip — `OPENAI_API_KEY required to run this test`, a key that is not
 * configured at all — is **excluded**, and not for lack of interest: it fires for keys
 * a lane legitimately does not carry. `composio.spec.ts` skips on `COMPOSIO_API_KEY`,
 * which no workflow sets. An unset secret is a real hole of the same family, and it is
 * #570's, not this one's.
 *
 * ## What the report IS for
 *
 * Everything the headline says: which providers went unverified, what `collect-models`
 * measured about each, how many tests it cost, and in which spec files. Those counts
 * are reported, never used as the verdict.
 *
 * The daily's OTHER coverage loss is invisible here and has its own reporter: when the
 * weekday rotation advances past a dry provider the specs are pinned to the substitute,
 * so nothing skips and this verdict is honestly `covered` while the day's slot went
 * unrun (`select-daily-model-target.mjs`).
 *
 * Measured on Playwright 1.58: a `test.skip(cond, reason)` — in a test body, a
 * `beforeEach`, a `describe` or at file level — lands as
 * `annotations: [{ type: "skip", description: reason }]` on the test, with
 * `status: "skipped"`, and `merge-reports --reporter=json` preserves it, so both the PR
 * lane's direct json run and the daily's merged report answer this. A `test.skip()`
 * with no description carries no `description` key and is ignored.
 *
 * ## Undecidable is not clean (#1012/#1035)
 *
 * A REPORT this cannot read is `unknown` — distinct from an unreadable providers.json,
 * which only costs the usability half. It exits 2 when the run it describes REPORTED
 * SUCCESS — a lane that says it passed and cannot show what it covered must not go
 * green on this guard's silence — and exits 0 when the run already failed, where the
 * missing report is a symptom of a failure that is already red and named.
 *
 * Run:
 *   node scripts/provider-coverage-verdict.mjs --report results.json \
 *     --providers tests/helpers/provider-setup/data/providers.json
 *
 * Outputs: a markdown block on `$GITHUB_STEP_SUMMARY` (or `--summary PATH`), one
 * annotation, `level` / `unverified` / `skipped` / `executed` on `$GITHUB_OUTPUT`, and
 * the full verdict as JSON on stdout.
 */

import fs from "node:fs";

import { appendSummary, tableCell } from "./lib/step-summary.mjs";

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
 * Whether the ACCOUNT had a usable provider, from one or more `providers.json` files.
 *
 * A provider counts as usable if ANY file recorded it `active`: the daily's shards
 * each collect their own health, and one shard reaching a provider proves the account
 * could. `known: false` means no file could be read at all — reported, never guessed.
 *
 * @param {Array<unknown>} payloads parsed providers.json contents
 * @returns {{known: boolean, active: string[]}}
 */
export function providerUsability(payloads = []) {
  const readable = payloads.filter((p) => Array.isArray(p));
  if (readable.length === 0) return { known: false, active: [] };

  const active = new Set();
  for (const records of readable) {
    for (const record of records) {
      if (record && typeof record === "object" && record.status === "active") {
        active.add(String(record.provider ?? ""));
      }
    }
  }
  return { known: true, active: [...active].filter(Boolean).sort() };
}

/**
 * The graded verdict for one run.
 *
 * The report decides WHAT went unverified and what it cost; `usability` decides the
 * LEVEL. Keeping those two apart is the fix for the review defect described in the
 * header — a healthy provider leaves no trace in the report, so no count taken from
 * the report can answer "was anything usable".
 *
 * @param {unknown} report parsed Playwright JSON report
 * @param {{known: boolean, active: string[]}} [usability]
 * @returns {{level: string, unverified: Array<{provider: string, reason: string, skipped: number}>, skipped: number, executed: number, gatedFiles: string[], totalTests: number, usableProviders: string[], usabilityKnown: boolean}}
 */
export function providerCoverageVerdict(report, usability = { known: false, active: [] }) {
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

  // Reported as context, never as the verdict: how much of the gated surface still
  // produced a result. It is the figure the first version failed the lane on.
  const executed = tests.filter(
    (t) => gatedFiles.has(t.file) && t.status !== "skipped",
  ).length;
  const unverified = [...byProvider.values()].sort((a, b) =>
    a.provider.localeCompare(b.provider),
  );
  const skipped = unverified.reduce((n, e) => n + e.skipped, 0);

  const known = Boolean(usability?.known);
  const active = usability?.active ?? [];

  const level =
    tests.length === 0
      ? "unknown"
      : unverified.length === 0
        ? "covered"
        : known && active.length === 0
          ? "uncovered"
          : "degraded";

  return {
    level,
    unverified,
    skipped,
    executed,
    gatedFiles: [...gatedFiles].sort(),
    totalTests: tests.length,
    usableProviders: active,
    usabilityKnown: known,
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

  const providers = verdict.unverified.map((p) => `\`${p.provider}\``).join(", ");
  const rows = verdict.unverified.map(
    (p) => `| \`${p.provider}\` | ${p.skipped} | ${tableCell(p.reason)} |`,
  );
  const table = [
    "| Provider | Tests skipped | What `collect-models` measured |",
    "| --- | --- | --- |",
    ...rows,
  ];
  const cost =
    `${verdict.skipped} test(s) skipped across ${verdict.gatedFiles.length} spec file(s)` +
    (verdict.executed > 0 ? `, where ${verdict.executed} other test(s) still ran` : "");

  if (verdict.level === "uncovered") {
    return {
      markdown: [
        `### 🚨 Provider coverage — NONE${lane}`,
        "",
        `**No provider was usable on this run.** \`collect-models\` recorded every configured ` +
          `provider as unusable, so ${cost} — and re-running changes nothing until the ` +
          `account(s) are restored.`,
        "",
        ...table,
        "",
        "This is why the run is RED with no test failure: a run that could not reach any",
        "provider must not report as a pass (#570/#1012). The specs are not implicated —",
        "the skips themselves are correct, a dead key cannot produce a verdict about Langflow.",
        "",
      ].join("\n"),
      annotation:
        `No provider was usable on this run (${providers} down, none active): ${cost}.`,
    };
  }

  const usability = verdict.usabilityKnown
    ? `\`${verdict.usableProviders.join("`, `")}\` ${
        verdict.usableProviders.length === 1 ? "was" : "were"
      } still usable, so the run could still cover something.`
    : "Whether any provider was usable could not be read (no `providers.json`), so this " +
      "is reported as degraded rather than failing — the gap is stated, not assumed away.";

  return {
    markdown: [
      `### ⚠️ Provider coverage — DEGRADED${lane}`,
      "",
      `${providers} ${verdict.unverified.length === 1 ? "was" : "were"} **not verified** by ` +
        `this run: ${cost}. ${usability}`,
      "",
      ...table,
      "",
      // The closing line follows what is KNOWN. Saying "the account was not down" on a
      // run where usability could not be read would state the very thing the paragraph
      // above just said could not be determined.
      ...(verdict.usabilityKnown
        ? [
            "The run is green because the account was not down — an ops outage must not redden work",
            "that cannot fix it (#980). It is **not** evidence about the provider(s) above, whichever",
            "specs did run.",
          ]
        : [
            "The run is green because this verdict does not fail a lane on an input it could not",
            "read (#980). It is **not** evidence about the provider(s) above, whichever specs did run.",
          ]),
      "",
    ].join("\n"),
    annotation:
      `${providers} not verified by this run (${cost}).`,
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

/**
 * Read every providers.json given. Unreadable files are skipped, not fatal: usability
 * is an optional input and its absence has its own reported outcome.
 * @returns {{payloads: unknown[], unread: string[]}}
 */
export function readProviderFiles(paths, { readFile, exists } = {}) {
  const fileExists = exists ?? ((p) => fs.existsSync(p));
  const read = readFile ?? ((p) => fs.readFileSync(p, "utf-8"));
  const payloads = [];
  const unread = [];
  for (const p of paths) {
    if (!fileExists(p)) {
      unread.push(p);
      continue;
    }
    try {
      payloads.push(JSON.parse(read(p)));
    } catch {
      unread.push(p);
    }
  }
  return { payloads, unread };
}

const HELP = `usage: provider-coverage-verdict.mjs [options]

  --report PATH        Playwright JSON report (default: results.json)
  --providers PATH     providers.json written by collect-models; repeatable, since the
                       daily's shards each write their own. Absent = usability UNKNOWN,
                       which degrades the verdict rather than failing the lane.
  --lane NAME          lane name, for the summary heading
  --summary PATH       markdown sink (default: $GITHUB_STEP_SUMMARY)
  --github-output PATH key=value sink (default: $GITHUB_OUTPUT)
  --run-outcome NAME   outcome of the run this describes (success|failure|…). Decides
                       how loud an unreadable REPORT is: on a run that claimed success
                       an undecidable verdict exits 2 (#1035).
`;

function parseArgs(argv) {
  const args = {
    report: "results.json",
    providers: [],
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
    else if (flag === "--providers") args.providers.push(value);
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
  const { payloads, unread } = readProviderFiles(args.providers);
  const usability = providerUsability(payloads);

  const verdict = report
    ? providerCoverageVerdict(report, usability)
    : {
        level: "unknown",
        unverified: [],
        skipped: 0,
        executed: 0,
        gatedFiles: [],
        totalTests: 0,
        usableProviders: usability.active,
        usabilityKnown: usability.known,
      };
  if (reason) verdict.reason = reason;
  if (verdict.level === "unknown" && !verdict.reason) {
    verdict.reason = "the report carried no test result at all";
  }
  if (!LEVELS.has(verdict.level)) verdict.level = "unknown";

  // Said out loud rather than folded into the verdict: a providers.json that was asked
  // for and could not be read is why a run might read `degraded` instead of `uncovered`.
  for (const path of unread) {
    process.stderr.write(
      `::warning::provider-coverage-verdict: ${path} is missing or unreadable, so it ` +
        `contributes nothing to whether any provider was usable\n`,
    );
  }

  const { markdown, annotation } = renderVerdict(verdict, { lane: args.lane });

  if (markdown && args.summary && !appendSummary(markdown, args.summary)) {
    // The summary is the primary surface, so a failure to write it must be said out
    // loud — but it must not swallow the verdict, which the annotation and the exit
    // code still carry.
    process.stderr.write(
      `::warning::provider-coverage-verdict: could not write the run summary to ${args.summary}\n`,
    );
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
