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
 *                nothing. Whether it FAILS the lane is `shouldFail()`'s call, not
 *                this verdict's — see below.
 *
 * `degraded` staying green is #980's trade, unchanged: on the PR lane a drained
 * openai key makes the pin decline and the parametrized specs run on the remaining
 * providers, so the coverage that landed is real, just narrower and costlier. Failing
 * there would turn one dead account into a merge block for every PR that touches a
 * provider-dependent spec — including PRs whose specs passed on two other providers.
 *
 * `uncovered` names a run that received no evidence whatsoever — the all-skip green
 * #570, #1012 and #1010 wrote their rules against.
 *
 * ## What FAILS is a second question, and not the same one (#1800)
 *
 * `--fail-closed` originally failed on `uncovered`, and that proved too wide on the PR
 * lane, where the "run" is whatever the import graph selected — frequently ONE spec
 * file. A PR editing a single wholly-gated spec during a drain of that spec's provider
 * executes nothing and scores `uncovered`, so one dead key became a merge block for an
 * author who cannot fix it: #980 inverted, on the lane a human is waiting on.
 * TWELVE specs are wholly gated that way (measured) — eight on openai, two on google,
 * two on anthropic, and none on a pair — and all of them are provider-dependent, so the
 * sweep runs and the gate is armed. Not through their tags: `provider-dependent-specs.mjs`
 * also matches an AREA or a MARKER, and `provider-setup` is a marker that every one of
 * these files hits through the import that gives it `providerSkipGate`. The derivation
 * is recorded in `lib/provider-usability.mjs` because the count has been wrong twice.
 *
 * So the failing decision moved to `shouldFail()` and asks what a re-run can answer:
 * the ACCOUNT axis, read from `providers.json` rather than guessed from the report,
 * because a healthy provider leaves no trace in a report at all. See `shouldFail()`
 * for the matrix.
 *
 * ## What that leaves on each lane, stated because it is not symmetric
 *
 * On the DAILY this is a widening: `uncovered` needs zero executed tests, which a full
 * `@stable` run never produces, so the gate could not fire at all — and a dry account
 * now fails it. What the daily does NOT give up is the old rule: it passes
 * `--fail-on-uncovered`, because "the run covered nothing" means a suite defect there
 * (#1764's class) rather than a narrow selection, and a guard for a state this lane
 * calls unreachable costs nothing to keep.
 *
 * On the PR lane it is close to a removal, and pretending otherwise would be the
 * dishonest half. `dry` is all but unreachable there because `Collect models` is a HARD
 * gate that already fails on "no provider probed active" (collect-models.spec.ts), and
 * `unknown`-with-a-skip cannot occur because the same absent `providers.json` makes
 * `providerSkipReasons` fail OPEN, so no provider-health skip fires in the first place.
 * What is left failing on that lane is an unreadable report. That is the intended
 * end state — the account is already gated one step earlier, by a check that fails with
 * the cause named — but it means the PR lane's coverage verdict is now a REPORTING
 * surface, and #1456's gate there lives in `Collect models`, not here.
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
 *   account               dry | alive | unknown  — could ANY provider serve a call
 *   usable_providers      comma-separated providers recorded active ("" when none)
 *   fail_recommended      the shouldFail() decision, independent of --fail-closed
 *   executed              tests that produced a verdict (passed, failed or flaky)
 *   skipped_total         every skipped test, whatever the reason
 *   provider_skips        tests skipped for provider health
 *   providers             comma-separated providers that skipped ("" when none)
 *   lane_provider_skipped true when --provider is one of them
 *   headline              one display-safe line, the same text the summary leads with
 *
 * Exit codes:
 *   0  a verdict was produced (any verdict, unless --fail-closed says otherwise)
 *   1  --fail-closed and shouldFail() says the run deserves to fail
 *   2  usage error
 *
 * Run:
 *   PLAYWRIGHT_JSON=results.json node scripts/lane-coverage-verdict.mjs \
 *     --lane pr-validation --provider openai --fail-closed \
 *     --providers tests/helpers/provider-setup/data/providers.json
 *
 * Pure, dependency-free ESM: the daily's merge job runs it with plain `node`.
 */

import fs from "node:fs";
import { pathToFileURL } from "node:url";

import { parseProviderInactiveReason } from "./lib/provider-health-reason.mjs";
import {
  readUsability,
  readUsabilityDir,
  usabilityState,
} from "./lib/provider-usability.mjs";

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
  --providers PATH  providers.json written by collect-models; repeatable.
  --providers-dir D  read every providers-*.json in D and union them — the daily's
                    shards each write one. Absent (either flag) = the account axis is
                    UNKNOWN, which never fails on its own.
  --fail-on-uncovered  also fail an \`uncovered\` run on a LIVE account. For a lane
                    whose run is the whole suite (the daily), where covering nothing
                    is a suite defect the account cannot explain; NOT for a lane whose
                    run is an import-graph selection.
  --expect-shards N  with --providers-dir: warn when fewer than N files were read, so
                    a partial download cannot quietly bias the account toward \`dry\`.
  --fail-closed     exit 1 when the run deserves it (see shouldFail): an unreadable
                    report, a dry account, or a run that covered nothing with no
                    evidence that any provider was reachable
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
 * Strip what must not reach `$GITHUB_OUTPUT` or an `::error::` annotation.
 *
 * Same care as `check-run-integrity.mjs`'s `displaySignature`: the runner reads
 * `$GITHUB_OUTPUT` line-wise, so a newline inside a value could forge a second
 * `key=value` line — `verdict=covered` included. The reasons here come from a
 * provider's error body, which is not guaranteed to be one line.
 *
 * @param {string} value
 */
export function displaySafe(value) {
  return String(value ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The verdict for one run.
 *
 * @param {unknown} report parsed Playwright JSON report, or `null` when unreadable
 * @param {{
 *   lane?: string,
 *   laneProvider?: string|null,
 *   reportPath?: string,
 *   usability?: import("./lib/provider-usability.mjs").ProviderUsability,
 *   failOnUncovered?: boolean,
 * }} [options]
 */
export function laneCoverageVerdict(report, options = {}) {
  const lane = options.lane || "this lane";
  const laneProvider = options.laneProvider || null;
  const reportPath = options.reportPath || "the Playwright JSON report";
  const usability = options.usability ?? { known: false, active: [] };
  const account = usabilityState(usability);
  const usableProviders = usability.active ?? [];
  // Carried ON the result rather than passed to `shouldFail()`, so the three surfaces
  // that ask (the summary heading, the `fail_recommended` output and the exit code)
  // cannot answer differently — the drift #1045 names, one function down.
  const failOnUncovered = options.failOnUncovered === true;

  if (!report || typeof report !== "object" || !Array.isArray(report.suites)) {
    return {
      verdict: UNREADABLE,
      lane,
      laneProvider,
      laneProviderSkipped: false,
      account,
      usableProviders,
      failOnUncovered,
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

  // What to NAME as still usable, which is not the same set as what decides `dry` vs
  // `alive`. The decision is about the account and stays on the raw record; the
  // sentence is about this run, and a provider that skipped here is not evidence of
  // anything, so listing it produced "openai could not serve a call … openai was still
  // usable" in one line — measured while proving the fix. The two sets can legitimately
  // differ: the daily unions four shards, and one shard reaching a provider another
  // shard could not is exactly the disagreement the union exists to keep.
  const skippedNames = new Set(providers.map((p) => p.provider));
  const stillUsable = usableProviders.filter((p) => !skippedNames.has(p));

  // The account clause is appended rather than woven in, so the three verdict
  // sentences stay exactly what #1456 shipped and the new fact reads as the separate
  // axis it is: what the run covered, and whether anything COULD have covered it.
  const accountClause =
    providerSkips.length === 0
      ? ""
      : account === "dry"
        ? ". No provider was RECORDED usable, so re-running changes nothing until that is fixed"
        : account === "alive"
          ? stillUsable.length > 0
            ? `. ${stillUsable.join(", ")} ${stillUsable.length === 1 ? "was" : "were"} still usable`
            : `. The account was not down — collect-models recorded ${usableProviders.join(", ")} usable, and the same provider(s) skipped here, so the sweep and the run disagree`
          : ". Whether any provider was usable is UNKNOWN — no providers.json was readable";

  const headline =
    (verdict === COVERED
      ? `${lane}: no provider-health skip — all ${executed} executed test(s) ` +
        `produced a verdict`
      : verdict === UNCOVERED
        ? `${lane} produced NO verdict at all: ${providerSkips.length} test(s) ` +
          `skipped because ${names} could not serve a call, and 0 executed. This ` +
          `run is not evidence that anything works`
        : `${lane} did not cover ${names}: ${providerSkips.length} of ` +
          `${executed + skippedTotal} test(s) skipped on provider health` +
          (laneProviderSkipped
            ? `, including the provider this lane pins itself to (${laneProvider})`
            : "")) + accountClause;

  return {
    verdict,
    lane,
    laneProvider,
    laneProviderSkipped,
    account,
    usableProviders,
    failOnUncovered,
    executed,
    skippedTotal,
    providerSkips,
    providers,
    headline: displaySafe(headline),
  };
}

/**
 * Whether this verdict should FAIL the lane — the decision #1800 separates from the
 * verdict itself.
 *
 * `--fail-closed` used to mean "fail on `uncovered` or `unreadable`", and `uncovered`
 * is the wrong trigger on its own. It says the RUN produced no evidence, which on the
 * daily means the suite is broken and on the PR lane frequently means the import graph
 * selected one wholly-gated spec. Failing there turns one drained key into a merge
 * block for a PR whose author cannot fix it — #980 inverted, on the lane a human is
 * waiting on, and reachable today through twelve wholly-gated specs (#1800).
 *
 * What survives is the question a re-run can answer:
 *
 *   unreadable                    → fail. A verdict that could not look must not pass.
 *   account dry, any skip         → fail. Nothing could have served a call; a re-run
 *                                   changes nothing until someone acts, and the
 *                                   emptiness is not an artifact of a narrow selection.
 *   uncovered, account NOT alive  → fail. Nothing ran AND nothing says a provider was
 *                                   reachable: fail-closed on the unknown, because
 *                                   `uncovered` alone is already a strong signal.
 *   uncovered, account alive      → the LANE decides, via `--fail-on-uncovered`. Where
 *                                   the run is an import-graph selection it means the
 *                                   selection was narrow: reported loudly, not failed.
 *                                   Where the run is the whole suite it means something
 *                                   collected nothing, which the account cannot explain
 *                                   and which the pre-#1800 rule caught — so the daily
 *                                   asks for it and keeps that guard.
 *
 * Note what the second clause adds rather than removes: a `degraded` daily on a dry
 * account now fails, where the old rule could not reach it at all (a full `@stable` run
 * always executes hundreds of non-LLM tests, so `executed === 0` never held there).
 * That is a real widening of when the daily goes red, taken deliberately: the LLM
 * surface went unmeasured and nothing else on the run says so.
 *
 * @param {ReturnType<typeof laneCoverageVerdict>} result
 * @returns {boolean}
 */
export function shouldFail(result) {
  if (result.verdict === UNREADABLE) return true;
  if (result.providerSkips.length === 0) return false;
  if (result.account === "dry") return true;
  if (result.verdict !== UNCOVERED) return false;
  // `uncovered` on a demonstrably live account means one of two things, and WHICH one
  // is a property of the lane's unit of work, not of the run (#1800 review). Where the
  // "run" is an import-graph selection — frequently one spec file — it means the
  // selection was narrow, and failing is #980 inverted. Where the run is the whole
  // `@stable` suite it means something collected nothing (#1764's class), which is a
  // suite defect the account cannot explain and the one the old rule caught. So the
  // lane declares it with `--fail-on-uncovered` instead of the policy being guessed
  // from the account: a guard for a state the daily calls unreachable costs nothing
  // to keep, while removing it is what needed the argument.
  return result.failOnUncovered === true || result.account !== "alive";
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

  // The heading follows the FAIL decision, not the verdict (#1800 review). A red ❌
  // over a step that exits 0 is a summary contradicting its own check, and it was
  // measured on the exact run this fix exists for: "This run covered nothing" in red,
  // above a green check, above a line saying the run was narrow. `uncovered` is still
  // named in the body — what changes is which of the two facts leads.
  lines.push(
    result.verdict === UNCOVERED
      ? shouldFail(result)
        ? "### ❌ This run covered nothing — every test that could have produced a verdict was skipped"
        : "### ⚠️ This run covered nothing — every test in it was skipped on provider health"
      : shouldFail(result)
        ? // The `degraded` + dry-account case, which is the one the DAILY can actually
          // reach — and the first version of this fix left it a ⚠️ over an `exit 1`
          // and an `::error::`, i.e. the same contradiction as the finding above,
          // inverted. Its old text is wrong here too: "less than the check status
          // shows" was written for a check that is green.
          "### ❌ Provider-health skip — and NO provider was recorded usable, so the LLM surface went unmeasured"
        : "### ⚠️ Provider-health skip — this run covered less than the check status shows",
    "",
    result.headline,
    "",
    `| Provider | Reason \`collect-models\` measured | Tests not covered |`,
    `|---|---|---|`,
  );
  for (const provider of result.providers) {
    lines.push(
      `| \`${provider.provider}\`${
        provider.provider === result.laneProvider ? " (lane pin)" : ""
      } | ${provider.reasons.map((r) => displaySafe(r)).join(" — also: ")} | ${
        provider.tests.length
      } |`,
    );
  }
  lines.push("", `Executed: **${result.executed}** · skipped for provider health: **${result.providerSkips.length}** · skipped in total: **${result.skippedTotal}**`, "");

  // The account axis, always stated when anything skipped (#1800). It is what decides
  // whether this block is a red or a warning, so leaving the reader to infer it from
  // the colour is how the two get read as one fact.
  lines.push(
    result.account === "dry"
      ? "**No provider was recorded usable on this run** — not a narrow selection, and re-running " +
        "changes nothing until that is fixed. `providers.json` is written by the `collect-models` " +
        "sweep AND by `globalSetup`'s credential degradation (#1058), and this reads the record, " +
        "not the cause: a drained account and a sweep that never imported the keys both produce it."
      : result.account === "alive"
        ? // Same set difference as the headline, and for the same reason: a provider
          // that skipped here is not evidence that anything was covered.
          (() => {
            const skippedNames = new Set(result.providers.map((p) => p.provider));
            const stillUsable = result.usableProviders.filter((p) => !skippedNames.has(p));
            // NOT "narrow, not blind": on an `uncovered` run it was blind, and the
            // heading two lines above says so. What the live account establishes is
            // only that the account is not the thing to fix — and for a spec that
            // HARDCODES the dead provider (12 of them do) a re-dispatch recovers
            // nothing either, so this must not read as "just re-run it".
            const scope =
              result.verdict === UNCOVERED
                ? "This run still produced no verdict — a spec hardcoded to the dead provider does not recover by re-running."
                : "So this run is narrower than the check status shows, not blind.";
            return stillUsable.length > 0
              ? `Still usable: **${stillUsable.join(", ")}** — the account is up, so it is not what needs fixing. ${scope}`
              : `The account is up (**${result.usableProviders.join(", ")}** recorded usable) and the same provider(s) skipped here — the sweep and the run disagree, which the daily's per-shard union can produce. ${scope}`;
          })()
        : "Whether any provider was usable is **UNKNOWN** (no readable `providers.json`). Unknown is not clean (#1012).",
    "",
  );

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
    `providers=${displaySafe(result.providers.map((p) => p.provider).join(","))}`,
    `lane_provider_skipped=${result.laneProviderSkipped}`,
    // #1800. `account` is the state, `fail_recommended` is the DECISION — emitted so
    // the workflows read one computed answer instead of re-deriving the policy in a
    // YAML `if:`, which is where two lanes drift apart. Independent of --fail-closed:
    // that flag says whether this process exits non-zero, not what the run deserves.
    `account=${result.account}`,
    `usable_providers=${displaySafe(result.usableProviders.join(","))}`,
    `fail_recommended=${shouldFail(result)}`,
    `headline=${displaySafe(result.headline)}`,
  ];
}

/** The flags that take a value; every other flag is either a switch or unknown. */
const VALUE_FLAGS = new Set([
  "--lane",
  "--provider",
  "--report",
  "--providers",
  "--providers-dir",
  "--expect-shards",
]);

export function parseArgs(argv) {
  const args = {
    lane: "this lane",
    provider: null,
    report: process.env.PLAYWRIGHT_JSON || "results.json",
    // Repeatable: the daily's shards each write their own providers.json and the merge
    // job unions them. Not defaulted to the in-repo path — a caller that does not pass
    // one gets UNKNOWN and says so, which is the honest answer for a lane that never
    // ran the sweep.
    providers: [],
    // The daily's four shards land their files in one downloaded directory. Globbing
    // it HERE rather than in the workflow is what makes the wiring testable — see
    // `readUsabilityDir`.
    providersDir: null,
    // How many shard files the caller expects in `providersDir`. Reported, never
    // gated on: a partial download can only bias the union toward `dry`, which FAILS
    // a lane, so the reader must say it read three of four rather than leave the
    // count to be inferred from a verdict (#1012).
    expectShards: null,
    failOnUncovered: false,
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
    if (flag === "--fail-on-uncovered") {
      args.failOnUncovered = true;
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
    else if (flag === "--providers") args.providers.push(value);
    else if (flag === "--providers-dir") args.providersDir = value;
    else if (flag === "--expect-shards") args.expectShards = value;
    else args.report = value;
    i++;
  }
  // Refused rather than resolved: the CLI can only read one of the two, and silently
  // dropping the other would let the caller believe an input decided a verdict it
  // never reached (#1012). Nothing passes both today, which is exactly when to say so.
  if (args.providersDir && args.providers.length > 0) {
    throw new Error("--providers and --providers-dir are mutually exclusive");
  }
  if (args.expectShards !== null) {
    const n = Number(args.expectShards);
    if (!Number.isInteger(n) || n < 0) {
      throw new Error(`--expect-shards needs a non-negative integer, got "${args.expectShards}"`);
    }
    args.expectShards = n;
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

  const usability = args.providersDir
    ? readUsabilityDir(args.providersDir)
    : readUsability(args.providers);
  if (args.providersDir) {
    process.stdout.write(
      `Provider health read from ${usability.read} shard file(s) in ${args.providersDir}.\n`,
    );
    // A partial download is not neutral: the union only ever GAINS providers, so a
    // missing shard file can turn `alive` into `dry` and fail the day — never the
    // other way round. Said out loud, never gated on (#1012, and #980's trade: a
    // half-read axis must not be a second way to redden a run).
    if (args.expectShards !== null && usability.read < args.expectShards) {
      process.stderr.write(
        `::warning::lane-coverage-verdict: read ${usability.read} of ${args.expectShards} ` +
          `expected shard provider file(s) in ${args.providersDir}. The account axis is ` +
          `built from a UNION, so a missing file can only bias it toward \`dry\`\n`,
      );
    }
  }
  const result = laneCoverageVerdict(readReport(args.report), {
    lane: args.lane,
    laneProvider: args.provider,
    reportPath: args.report,
    usability,
    failOnUncovered: args.failOnUncovered,
  });

  // Said out loud rather than folded into the verdict: a providers.json that was asked
  // for and could not be read is why a run may read `unknown` instead of `dry`, and an
  // unknown account is the difference between failing and not (#1012).
  //
  // Only where the axis can CHANGE something, though — computed after the verdict for
  // exactly that reason. `Collect models` is skipped on every LLM-free PR, so warning
  // unconditionally put a yellow annotation on the majority of PRs, about a file that
  // was never meant to exist and an axis with nothing to decide: #1252's `mode=count`
  // re-created in the lane a human actually reads. With no provider-health skip the
  // verdict is `covered` and no account state can move it.
  if (result.providerSkips.length > 0) {
    for (const path of usability.unread ?? []) {
      process.stderr.write(
        `::warning::lane-coverage-verdict: ${path} is missing or unreadable, so it ` +
          `contributes nothing to whether any provider was usable\n`,
      );
    }
  }

  // Drift is reported UNCONDITIONALLY, unlike `unread` above, and the asymmetry is the
  // whole point of keeping the two lists apart. #1252's noise argument covers an absent
  // optional file, which is the normal state of every LLM-free PR; it does not cover a
  // file that exists, parses, and carries records this reader cannot interpret — that
  // is never routine. And the skip gate would make this warning unreachable in exactly
  // the scenario it was written for: a renamed `status` also defeats `providerSkipGate`'s
  // own `status === "inactive"` test, so NO provider-health skip fires, the verdict is
  // `covered`, and the one message naming the file and the expected fields would never
  // print (measured — the run was silent on the PR lane and, on the daily, said only
  // "a missing file" about a file that was present).
  for (const path of usability.unrecognised ?? []) {
    process.stderr.write(
      `::warning::lane-coverage-verdict: ${path} parsed but carries no record with a ` +
        `\`provider\` and an active/inactive \`status\` — the producer's shape may have ` +
        `drifted (collect-models.ts / provider-health.ts). Treated as UNKNOWN, never as dry\n`,
    );
  }

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
  // The annotation follows the FAIL decision, not the verdict (#1800): an `uncovered`
  // run on a live account is a narrow selection, and printing `::error::` for one that
  // does not fail the step is how an annotation stops being read.
  if (shouldFail(result)) {
    process.stderr.write(`::error::${result.headline}\n`);
  } else if (result.verdict !== COVERED) {
    process.stderr.write(`::warning::${result.headline}\n`);
  }

  process.exit(args.failClosed && shouldFail(result) ? 1 : 0);
}
