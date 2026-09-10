#!/usr/bin/env node
/**
 * Does a lane's green mean it covered the providers it was supposed to cover?
 * (issue #1456)
 *
 * ## The gap this closes
 *
 * When `collect-models` probes a provider `inactive`, `providerSkipGate()` and the
 * provider-parametrized resolvers do the right thing per test: they **skip**, quoting
 * the reason the sweep measured. What no per-test decision can change is how the
 * LANE reports. Measured on PR #1381's E2E lane, run 31698035402 (2026-08-13):
 * **3 skipped / 5 passed / 1 flaky**, check status **SUCCESS**. The three skips were
 * the openai targets of `agent-multi-tool-selection.spec.ts` — openai being the
 * provider `pr-validation.yml` pins itself to (#1169) — and nothing in the check
 * distinguished that run from one where those three ran and passed.
 *
 * Every individual decision there is defensible: the skips are correct (a dead key
 * cannot produce a verdict about Langflow), the reason IS printed in the log, and the
 * lane is right not to hard-fail — #980's trade says a drained provider key must not
 * kill the specs that never touch it. The aggregate is what lies, and only something
 * that reads the whole run can tell.
 *
 * ## Why the report and not a prediction
 *
 * The same verdict could be guessed before the run from `providers.json` plus the
 * impacted-spec list. It is computed from the run's own Playwright JSON report
 * instead, because a prediction answers "which specs we expect to skip" and the
 * question is "what did this run actually cover". The two diverge exactly where it
 * matters: a spec that never got collected at all (#1764), one that skipped for a
 * capability reason, one whose provider recovered between the sweep and the run.
 *
 * The substrate is the `skip` annotation Playwright records for
 * `test.skip(condition, description)` — measured on 1.58.2, for both the
 * suite-level gate (`providerSkipGate`) and the in-body one the parametrized specs
 * use, and distinguishable from `fixme` (no description) and from every other skip
 * reason. `lane-coverage-verdict.test.mjs` pins that against the installed version by
 * running the real CLI, because the whole design rests on it.
 *
 * ## The three verdicts, and why they are not one
 *
 *   `covered`    no provider-health skip. Nothing to say.
 *   `degraded`   at least one test skipped for provider health, and at least one
 *                other test EXECUTED. The lane keeps reporting success and states
 *                what it did not cover in the run summary.
 *   `uncovered`  at least one provider-health skip and ZERO tests executed. The run
 *                produced no verdict about Langflow at all; its green is worth
 *                nothing. Fail-closed with `--fail-closed`.
 *
 * `degraded` staying green is #980's trade, unchanged: on the PR lane a drained
 * openai key makes the pin decline and the parametrized specs run on the remaining
 * providers, so the coverage that landed is real, just narrower and costlier. Failing
 * there would turn one dead account into a merge block for every PR that touches a
 * provider-dependent spec — including PRs whose specs passed on two other providers.
 *
 * `uncovered` failing is the rule #570, #1012 and #1010 already wrote for this repo,
 * arriving by a route none of them covered: an all-skip run that reads as coverage.
 * It is also the narrowest gate that closes it — it fires only when the lane received
 * no evidence whatsoever, which is precisely the case where nothing is lost by
 * refusing to call it a pass.
 *
 * Weighed and DECLINED: failing whenever the lane's pinned provider is among the
 * skipped ones. It is the same fact with a much wider blast radius — see `degraded`
 * above — and the pin is an optimisation the lane applies to itself, not a promise it
 * made to the PR. The pinned provider is still reported (`lane_provider_skipped`), so
 * the decision can be revisited on evidence rather than on argument.
 *
 * ## What this cannot see, stated so it is not read as covered
 *
 *  - **The destructive lane.** `pr-validation.yml` runs it with `--reporter=github`,
 *    which replaces the reporter list, so it writes no JSON report to read. A
 *    `@destructive` spec is barred from `@stable` (#1010) and the lane runs only
 *    impacted specs, so the exposure is small — but it is not zero.
 *  - **A spec that was never collected.** Zero tests from a file is absent, not
 *    skipped, and no report says so; that class is #1764's collection gate.
 *  - **A missing env key**, which produces a different skip reason on purpose — see
 *    `scripts/lib/provider-health-reason.mjs` for why it is out of scope here.
 *
 * Inputs (env, matching the repo's existing report consumers):
 *   PLAYWRIGHT_JSON     path to the Playwright JSON report (default: results.json)
 *   GITHUB_OUTPUT       when set, step outputs are appended as key=value lines
 *   GITHUB_STEP_SUMMARY when set, the summary block is appended there
 *
 * Outputs ($GITHUB_OUTPUT + a readable block on stdout):
 *   verdict               covered | degraded | uncovered | unreadable
 *   executed              tests that produced a verdict (passed, failed or flaky)
 *   skipped_total         every skipped test, whatever the reason
 *   provider_skips        tests skipped for provider health
 *   providers             comma-separated providers that skipped ("" when none)
 *   lane_provider_skipped true when --provider is one of them
 *   headline              one display-safe line, the same text the summary leads with
 *
 * Exit codes:
 *   0  a verdict was produced (any verdict, unless --fail-closed says otherwise)
 *   1  --fail-closed and the verdict is `uncovered` or `unreadable`
 *   2  usage error
 *
 * Run:
 *   PLAYWRIGHT_JSON=results.json node scripts/lane-coverage-verdict.mjs \
 *     --lane pr-validation --provider openai --fail-closed
 *
 * Pure, dependency-free ESM: the daily's merge job runs it with plain `node`.
 */

import fs from "node:fs";
import { pathToFileURL } from "node:url";

import { parseProviderInactiveReason } from "./lib/provider-health-reason.mjs";
import { displaySafe, tableCell } from "./lib/display-text.mjs";

// Re-exported: this module owned both until #1801 moved them next to the SECOND
// consumer that needed them, and the call sites (and tests) read them from here.
export { displaySafe, tableCell };

export const COVERED = "covered";
export const DEGRADED = "degraded";
export const UNCOVERED = "uncovered";
export const UNREADABLE = "unreadable";

/** How many skipped tests the summary names one by one before it says "and N more". */
const TEST_LIST_CAP = 25;

const HELP = `usage: lane-coverage-verdict.mjs [options]

  --lane NAME       lane label used in the messages (default: "this lane")
  --provider NAME   the provider this lane pinned itself to; reported, never gated on
  --report PATH     Playwright JSON report (default: $PLAYWRIGHT_JSON or results.json)
  --fail-closed     exit 1 when the verdict is \`uncovered\` or \`unreadable\`
  --json            print the full result as JSON instead of the readable block
  -h, --help        this text
`;

/**
 * Every test result in a Playwright JSON report, with the identity a human needs.
 *
 * The report nests `suites` inside `suites`, and the title of a test is only complete
 * with its describes: the parametrized specs put the provider in the describe title
 * (`Agent Multi-Tool Selection [openai / gpt-4o-mini]`), so a bare `spec.title` would
 * name three indistinguishable tests on the day it matters most. The file-level suite
 * carries the path as its title and is left out of the chain.
 *
 * @param {unknown} report parsed Playwright JSON report
 * @returns {Array<{ file: string, title: string, tests: any[] }>}
 */
export function flattenSpecs(report) {
  const out = [];
  const walk = (suite, titles) => {
    if (!suite || typeof suite !== "object") return;
    const file = suite.file ?? "";
    // A file-level suite titles itself with the path; a describe does not.
    const chain =
      suite.title && suite.title !== file ? [...titles, suite.title] : [...titles];
    for (const spec of Array.isArray(suite.specs) ? suite.specs : []) {
      out.push({
        file: spec.file ?? file,
        title: [...chain, spec.title].filter(Boolean).join(" › "),
        tests: Array.isArray(spec.tests) ? spec.tests : [],
      });
    }
    for (const child of Array.isArray(suite.suites) ? suite.suites : []) {
      walk(child, chain);
    }
  };
  for (const suite of Array.isArray(report?.suites) ? report.suites : []) {
    walk(suite, []);
  }
  return out;
}

/**
 * The provider-health reason a skipped test carries, or `null`.
 *
 * Reads `test.annotations`, which is where Playwright puts the description of every
 * `test.skip(condition, reason)` that fired — suite-level and in-body alike. A test
 * can carry several: `agent-multi-tool-selection.spec.ts` gates on provider health
 * AND on the model being resolvable, so the FIRST annotation that parses as a
 * provider-health reason decides. Order follows the report, which follows the order
 * the modifiers ran in.
 *
 * @param {any} test one entry of `spec.tests`
 * @returns {{ provider: string, error: string }|null}
 */
export function providerHealthSkip(test) {
  const annotations = Array.isArray(test?.annotations) ? test.annotations : [];
  for (const annotation of annotations) {
    if (annotation?.type !== "skip") continue;
    const parsed = parseProviderInactiveReason(annotation.description);
    if (parsed) return parsed;
  }
  return null;
}

/**
 * Split a report into what produced a verdict and what did not.
 *
 * `test.status` is Playwright's OUTCOME (`expected`, `unexpected`, `flaky`,
 * `skipped`), not the last result's status, so a test that failed once and passed on
 * retry counts as executed exactly once. A `flaky` test executed — it produced a
 * verdict about Langflow, which is the only property this counts.
 *
 * @param {unknown} report parsed Playwright JSON report
 */
export function classifyRun(report) {
  let executed = 0;
  let skippedTotal = 0;
  const providerSkips = [];

  for (const spec of flattenSpecs(report)) {
    for (const test of spec.tests) {
      if (test?.status !== "skipped") {
        executed += 1;
        continue;
      }
      skippedTotal += 1;
      const health = providerHealthSkip(test);
      if (health) {
        providerSkips.push({
          file: spec.file,
          title: spec.title,
          provider: health.provider,
          error: health.error,
        });
      }
    }
  }

  return { executed, skippedTotal, providerSkips };
}

/**
 * Group the skips by provider, preserving first-seen order per provider.
 *
 * One reason per provider: `collect-models` measures the provider once per run and
 * every target of that provider quotes the same string, so listing it per test would
 * repeat one fact N times. A second, different reason for the same provider would be
 * a signal of its own — it means two records disagreed — so it is kept and counted
 * rather than collapsed.
 *
 * @param {Array<{ provider: string, error: string, title: string, file: string }>} skips
 */
export function groupByProvider(skips) {
  const grouped = new Map();
  for (const skip of skips) {
    const entry = grouped.get(skip.provider) ?? {
      provider: skip.provider,
      reasons: [],
      tests: [],
    };
    if (!entry.reasons.includes(skip.error)) entry.reasons.push(skip.error);
    entry.tests.push(skip.title);
    grouped.set(skip.provider, entry);
  }
  return [...grouped.values()];
}



/**
 * `provider ("the reason the sweep measured")`, capped (#1801).
 *
 * The headline used to assert a cause — "could not serve a call" — from the mere
 * fact of a skip. It cannot: the same `inactive` record is written for a key that
 * was never imported as a Langflow global variable (`degradeProviders`, #1058), and
 * on that day the repair is the import, not the account. So the headline quotes what
 * was measured and leaves the diagnosis to the reader.
 *
 * Capped because this string reaches a step output and the umbrella issue's body: a
 * provider error body is not bounded, and one long reason must not push the counts
 * off the line. 140 rather than a rounder 90 — and the figure behind that choice was
 * MEASURED after this comment first guessed it (#1801): `globalSetup`'s structural
 * reason is **249** characters, not the ~130 originally claimed here. 140 still
 * truncates it, and that is fine: the clause naming the repair ("never imported as
 * a Langflow global variable") lands inside the first 90, whereas a 90-char cap cut
 * it at "…global vari…" — keeping the quote and dropping its only useful part.
 */
export function providerPhrase(entry, reasonCap = 140) {
  const reason = displaySafe(entry.reasons?.[0] ?? "");
  if (!reason) return entry.provider;
  const short = reason.length > reasonCap ? `${reason.slice(0, reasonCap - 1)}…` : reason;
  return `${entry.provider} ("${short}")`;
}

/**
 * The verdict for one run.
 *
 * @param {unknown} report parsed Playwright JSON report, or `null` when unreadable
 * @param {{ lane?: string, laneProvider?: string|null, reportPath?: string }} [options]
 */
export function laneCoverageVerdict(report, options = {}) {
  const lane = options.lane || "this lane";
  const laneProvider = options.laneProvider || null;
  const reportPath = options.reportPath || "the Playwright JSON report";

  if (!report || typeof report !== "object" || !Array.isArray(report.suites)) {
    return {
      verdict: UNREADABLE,
      lane,
      laneProvider,
      laneProviderSkipped: false,
      executed: 0,
      skippedTotal: 0,
      providerSkips: [],
      providers: [],
      headline:
        `no readable Playwright report at ${reportPath}, so whether ${lane} covered ` +
        `anything is UNKNOWN — a coverage verdict must not go green because it ` +
        `could not look`,
    };
  }

  const { executed, skippedTotal, providerSkips } = classifyRun(report);
  const providers = groupByProvider(providerSkips);
  const laneProviderSkipped =
    !!laneProvider && providers.some((p) => p.provider === laneProvider);

  let verdict = COVERED;
  if (providerSkips.length > 0) verdict = executed === 0 ? UNCOVERED : DEGRADED;

  const names = providers.map((p) => p.provider).join(", ");
  // QUOTED, never diagnosed (#1801) — see `providerPhrase`.
  const quoted = providers.map((p) => providerPhrase(p)).join("; ");
  const headline =
    verdict === COVERED
      ? `${lane}: no provider-health skip — all ${executed} executed test(s) ` +
        `produced a verdict`
      : verdict === UNCOVERED
        ? `${lane} produced NO verdict at all: ${providerSkips.length} test(s) ` +
          `skipped on provider health and 0 executed — ${quoted}. This run is not ` +
          `evidence that anything works`
        : `${lane} did not cover ${names}: ${providerSkips.length} of ` +
          `${executed + skippedTotal} test(s) skipped on provider health — ${quoted}` +
          (laneProviderSkipped
            ? `; including the provider this lane pins itself to (${laneProvider})`
            : "");

  return {
    verdict,
    lane,
    laneProvider,
    laneProviderSkipped,
    executed,
    skippedTotal,
    providerSkips,
    providers,
    headline: displaySafe(headline),
  };
}

/**
 * The run-summary block — the whole point of the exercise (#1252).
 *
 * `mode=count` was printed on every daily run for weeks and read by nobody, so a
 * `::warning::` here would be the same artifact. This lands in `$GITHUB_STEP_SUMMARY`,
 * which renders at the top of the run page a reviewer already opens, and it leads
 * with what was NOT covered rather than with a count of what was.
 *
 * `covered` renders nothing: a lane that has nothing to report must not train the
 * reader to scroll past this block.
 *
 * @param {ReturnType<typeof laneCoverageVerdict>} result
 */
export function renderSummary(result) {
  if (result.verdict === COVERED) return "";

  const lines = [];
  if (result.verdict === UNREADABLE) {
    lines.push("### ❌ Coverage verdict UNKNOWN — no report to read", "");
    lines.push(result.headline, "");
    return `${lines.join("\n")}\n`;
  }

  lines.push(
    result.verdict === UNCOVERED
      ? "### ❌ This run covered nothing — every test that could have produced a verdict was skipped"
      : "### ⚠️ Provider-health skip — this run covered less than the check status shows",
    "",
    result.headline,
    "",
    `| Provider | Reason \`collect-models\` measured | Tests not covered |`,
    `|---|---|---|`,
  );
  for (const provider of result.providers) {
    lines.push(
      `| \`${tableCell(provider.provider)}\`${
        provider.provider === result.laneProvider ? " (lane pin)" : ""
      } | ${provider.reasons.map((r) => tableCell(r)).join(" — also: ")} | ${
        provider.tests.length
      } |`,
    );
  }
  lines.push("", `Executed: **${result.executed}** · skipped for provider health: **${result.providerSkips.length}** · skipped in total: **${result.skippedTotal}**`, "");

  // Named one by one, capped, and never silently — #1012's rule. Which tests lost
  // their coverage is what decides whether the day needs a re-run.
  const titles = result.providerSkips.map((s) => `${s.title}`);
  lines.push("<details><summary>The tests that did not run</summary>", "");
  for (const title of titles.slice(0, TEST_LIST_CAP)) lines.push(`- ${displaySafe(title)}`);
  if (titles.length > TEST_LIST_CAP) {
    lines.push(
      "",
      `…and ${titles.length - TEST_LIST_CAP} more (listed in full in this step's log).`,
    );
  }
  lines.push("", "</details>", "");
  return `${lines.join("\n")}\n`;
}

/** The `$GITHUB_OUTPUT` lines for one verdict — every value single-line by construction. */
export function outputLines(result) {
  return [
    `verdict=${result.verdict}`,
    `executed=${result.executed}`,
    `skipped_total=${result.skippedTotal}`,
    `provider_skips=${result.providerSkips.length}`,
    // displaySafe per NAME, not on the joined string: the parser's capture is
    // `([^"]+)`, which matches a newline, so a provider name carrying one could
    // forge a second `key=value` line — `verdict=covered` included, which is what
    // the daily's fail-closed gate reads (#1801). Sanitising here rather than
    // tightening the capture is deliberate: a name the parser rejected would stop
    // being a provider-health skip at all, which is the silent-green direction.
    `providers=${result.providers.map((p) => displaySafe(p.provider)).join(",")}`,
    `lane_provider_skipped=${result.laneProviderSkipped}`,
    `headline=${displaySafe(result.headline)}`,
  ];
}

/** The flags that take a value; every other flag is either a switch or unknown. */
const VALUE_FLAGS = new Set(["--lane", "--provider", "--report"]);

export function parseArgs(argv) {
  const args = {
    lane: "this lane",
    provider: null,
    report: process.env.PLAYWRIGHT_JSON || "results.json",
    failClosed: false,
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "-h" || flag === "--help") {
      args.help = true;
      continue;
    }
    if (flag === "--fail-closed") {
      args.failClosed = true;
      continue;
    }
    if (flag === "--json") {
      args.json = true;
      continue;
    }
    // Flag name first, value second: `--fail-on-uncovered` (an early name for
    // --fail-closed) has no value after it, and reporting that as "needs a value"
    // would point a reader at the call site instead of at the flag that no longer
    // exists.
    if (!VALUE_FLAGS.has(flag)) throw new Error(`unknown flag: ${flag}`);
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    if (flag === "--lane") args.lane = value;
    else if (flag === "--provider") args.provider = value;
    else args.report = value;
    i++;
  }
  return args;
}

/** Read the report, or `null` when it is absent or unparseable — never throw. */
export function readReport(reportPath) {
  try {
    return JSON.parse(fs.readFileSync(reportPath, "utf-8"));
  } catch {
    return null;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`::error::lane-coverage-verdict: ${error.message}\n`);
    process.exit(2);
  }
  if (args.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }

  const result = laneCoverageVerdict(readReport(args.report), {
    lane: args.lane,
    laneProvider: args.provider,
    reportPath: args.report,
  });

  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`${result.headline}\n`);
    for (const skip of result.providerSkips) {
      process.stdout.write(`  skipped [${skip.provider}] ${displaySafe(skip.title)}\n`);
    }
  }

  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `${outputLines(result).join("\n")}\n`);
  }
  const summary = renderSummary(result);
  if (summary && process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  }

  // The annotation is a SECOND surface, not the signal — the summary block above is
  // the one a reviewer reads. It exists so the failing case names its cause in the
  // log too, where a red step is read.
  if (result.verdict === UNCOVERED || result.verdict === UNREADABLE) {
    process.stderr.write(`::error::${result.headline}\n`);
  } else if (result.verdict === DEGRADED) {
    process.stderr.write(`::warning::${result.headline}\n`);
  }

  const failing =
    args.failClosed && (result.verdict === UNCOVERED || result.verdict === UNREADABLE);
  process.exit(failing ? 1 : 0);
}
