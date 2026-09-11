#!/usr/bin/env node
// Open the daily-failure issue for a run of the @stable suite — the single home of
// the decision logic that `.github/workflows/daily-stable.yml` ("Create issue on
// failure") used to carry inline as an `actions/github-script` block.
//
// ## Why it is a script and not `gh issue create` in bash
//
// The body is DECISION LOGIC, not a template: four mutually exclusive shapes
// (failed merge / zero tests / partial / zero verdicts / per-test), each with its own title, its
// own triage instruction, and its own reason for existing. Reproducing that with
// bash heredocs is where the shapes quietly drift apart — and the shape is the
// whole point. An empty run rendered as a per-test day reads like a clean triage on
// a report that saw nothing (#1012); a partial run rendered as a normal day reports
// UNDER-COUNTED totals as if they were the day's numbers (#1058); and a run whose
// merge failed, rendered as an empty one, sends triage after a run that ran in
// full (#1726).
//
// ## Why it is ONE copy and not two
//
// It was written as a port, with the workflow keeping its inline block — which is
// the shape #1045 names: "a copy-pasted step is how the gates diverge". The
// workflow now CALLS this script, so the Actions lane and the VM lane render from
// the same source, and the Actions lane exercises it every red day instead of the
// VM being its first run ever. `renderIssue()` is pure and `RUN_URL` is what tells
// it which lane it is on: set (Actions) → the run link and the artifact wording;
// unset (VM) → the run directory and the on-disk wording. The Actions body is
// unchanged byte-for-byte, which `create-failure-issue.test.mjs` pins directly.
//
// ## Two creation paths, because `gh` is not always there
//
// The daily's `merge` job runs inside `mcr.microsoft.com/playwright:v1.58.2-noble`,
// which does NOT ship the GitHub CLI (verified in the image, not assumed). A
// `gh`-only script would therefore have degraded to "body on disk, exit 0" on
// every red daily — the silent loss #1012 exists to prevent. So a token, when one
// is present, creates the issue over the REST API and `gh` is the fallback for a
// VM where a human is logged in. `gh` is tried even when a token was present and
// FAILED: a stale variable in a VM's environment must not consume the only attempt.
// Which path ran is always printed, and a failure that tried both reports both.
//
// ## Why the issue lands on this repo by default
//
// The code's home is moving to an internal GitHub Enterprise instance, but the
// triage ecosystem has not moved with it: the `daily-failure` / `needs-triage`
// labels, the umbrella-issue history the triage dataset is built from
// (`build-triage-dataset.mjs`), and the `langflow-e2e-triage` / `-issues` skills
// all point at oriontech-me/langflow-e2e. Splitting the issues from that history
// would silently break the triage input, so the default stays here until the
// triage side follows. Override with ISSUE_HOST / ISSUE_REPO.
//
// Inputs (env), mirroring the workflow step's `env:` block:
//   IMAGE, RUN_ID, RUN_DIR, RUN_URL (set on Actions, absent on the VM)
//   AUTO_REMOVE_STATUS, AUTO_REMOVE_SUMMARY
//   RUN_EMPTY, RUN_UNREADABLE, RUN_PARTIAL, RUN_ERRORS, RUN_FIRST_ERROR, RUN_TESTS
//   COVERAGE_VERDICT, COVERAGE_HEADLINE, COVERAGE_PROVIDERS, COVERAGE_SKIPS (#1456)
//   COVERAGE_ACCOUNT="dry" — no provider was recorded usable (#1800)
//   TESTS_FAILED="true" — the `test` job failed, so the dry-account shape must not
//     take the title away from the per-test one (#1800)
//   MERGE_OK="false" — the shards ran and merging them failed (VM lane, #1726)
//   LIVENESS_MD
//   ISSUE_HOST (default github.com), ISSUE_REPO (default oriontech-me/langflow-e2e)
//   ISSUE_CC   (default the QA roster; set to "" to open the issue without a /cc)
//   GITHUB_TOKEN / GH_TOKEN  used for the REST path; absent = fall back to `gh`
//   ISSUE_STRICT=1   exit 1 when the issue could NOT be created (see below)
//   ISSUE_DRY_RUN=1  render, write the body, create nothing
//
// Always writes the rendered body to $RUN_DIR/issue-body.md, then creates the
// issue. The file is the fallback: a missing token must leave the triage material
// on disk, not lose it.
//
// ISSUE_STRICT exists because the two lanes want opposite failure modes. On a VM,
// a notifier that fails the run is worse than one that leaves the body on disk. On
// Actions the run is ALREADY red when this step runs, so a failure here costs
// nothing but tells us the umbrella is missing — and an umbrella that silently
// fails to open is how a red day ends up with no triage attached to it. The
// workflow sets ISSUE_STRICT=1; the VM leaves it unset.

import { writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

// Who gets pinged. Configurable rather than hardcoded: the handles are a team
// roster, which changes independently of this file, and a run that must NOT ping
// (a wiring test, a lane whose failures are already watched elsewhere) needs a way
// to say so that is not "edit the script". Empty = no /cc line at all.
export const CC_DEFAULT = "@Victor-w-Madeira @daniellicnerski1 @rafaelgiln";

/**
 * Render the issue's title and body. PURE — no env, no clock, no I/O — so the
 * four shapes and the two lanes are testable without creating anything. The one
 * thing this script does that cannot be undone is open an issue, so the decision
 * that picks the shape must be reachable without reaching that.
 */
export function renderIssue({
  today,
  image = "",
  runId = "",
  runDir = ".",
  runUrl = "",
  hostname = "the QA VM",
  arStatus = "",
  arSummary = "",
  empty = false,
  unreadable = false,
  partial = false,
  mergeFailed = false,
  uncovered = false,
  accountDry = false,
  testsFailed = false,
  // #1812: the shard matrix's own completeness. `true` means the listing the
  // matrix was built from contained every spec file declaring an @stable test;
  // anything else — including "the check could not run" — is not that.
  listingVerified = true,
  listingMissing = [],
  coverageHeadline = "",
  coverageProviders = "",
  coverageSkips = "0",
  runErrors = "0",
  firstError = "",
  runTests = "0",
  liveness = "",
  cc = CC_DEFAULT,
} = {}) {
  // Which lane rendered this. `RUN_URL` is the only honest discriminator: it is
  // the one input a VM run cannot have and an Actions run always does.
  const onActions = Boolean(runUrl);

  // EIGHT shapes, most specific first. The count has been stale three times — it
  // read "four" while there were six, "six" while omitting `partial`, and "seven"
  // while omitting the listing shape — so it is enumerated exhaustively below.
  // 0. The shards RAN and the MERGE failed (#1726). It has to precede `empty`,
  //    because a failed merge leaves no report and the integrity guard therefore
  //    reports the run as empty and unreadable. "Find why nothing ran" is then a
  //    true sentence pointing at the wrong repair: everything ran.
  // 1. ZERO tests executed (#1012): there is no per-test evidence to triage, so
  //    say so instead of rendering the auto-removal line, which reads as a clean
  //    triage on an empty report.
  // 2. NO VERDICT (#1456): the report is complete and carries results, but every
  //    one of them was a provider-health SKIP — nothing executed. It sits below the
  //    three structural shapes and above the per-test ones because it is the second
  //    way a GREEN test job can mean no coverage: `partial` and `empty` describe a
  //    run that broke, this one describes a run that worked and proved nothing.
  //    Ranked under `partial` deliberately: when a shard also died, the abort is
  //    what triage must start from.
  // 2b. PARTIAL (#1726): a shard never ran its tests, so the report under-counts.
  //    Above the coverage shapes for the same reason `empty` is: triage must start
  //    from the abort, not from what the surviving shards happened to cover.
  // 3. NO USABLE PROVIDER (#1800): the report is complete and hundreds of tests DID
  //    execute, but nothing was recorded usable, so the whole LLM surface went
  //    unmeasured — the shape this lane can actually reach, where `uncovered` cannot
  //    fire. Gated on `!testsFailed`, because the account says nothing about whether
  //    specs also failed and a day with real per-test failures must keep its own
  //    title and body; on such a day the outage is carried as a banner instead.
  // 3b. A spec file NEVER ENTERED THE SHARD MATRIX (#1812), or the matrix could not
  //    be shown complete. LAST among the green-test shapes on purpose: every one
  //    above is a bigger story, and this one reports information the run never had
  //    rather than a run that went wrong. It needs a shape at all because the
  //    daily's final gate reddens the day for it while the `test` job is GREEN —
  //    without one, the run goes red with a single annotation and nothing durable
  //    names why, which is #1176 on a fourth axis. On every other shape it is
  //    carried as a banner instead (see `listingBanner`).
  // 4. The auto-remove step acted — show what it did.
  // 5. Neither (it errored, or a guard skipped it) — manual triage.
  // The account fact, without the banner's framing. On `empty` and `mergeFailed` the
  // dry account is reported by nothing else at all: the banner is scoped away (there
  // are no failures to read against it), the run's own `::error::` needs a
  // provider-health skip that an aborted run never produced, and `renderSummary`
  // returns "" for the `covered` verdict such a report yields. So the FACT is carried
  // on both — as a note rather than a heading, since neither shape is about it
  // (#1012: it has to exist somewhere a human reads).
  //
  // The CAUSE HINT is `empty`'s alone, and the split is the point. #1058 is one sweep
  // that can record every provider `inactive` AND abort the shards, which makes the
  // hint worth printing where the shards aborted — and false where they did not:
  // `mergeFailed`'s own text says every shard finished and no spec is implicated, so
  // offering "can abort the shards in the same run" three lines below it names a cause
  // that shape does not have. The same defect this round removed from the daily's dry
  // `::error::`, in the umbrella.
  const dryAccountFact =
    "Note: no provider was **recorded** usable on this run (`providers.json`).";
  const dryAccountNote = accountDry ? ["", dryAccountFact] : [];
  const dryAccountNoteWithCause = accountDry
    ? [
        "",
        `${dryAccountFact} Possibly the same cause —`,
        "`Collect models` failing to import the keys records every provider `inactive` and",
        "can abort the shards in the same run (#1058/#1800).",
      ]
    : [];

  // #1812. A spec file that never entered the shard matrix is the one failure
  // this lane can have that leaves NO trace in the merged report: no skip, no
  // failure, no row to be missing from. It is therefore reported from `prep`'s
  // verdict rather than derived here — and it has to be reported at all, because
  // the daily's final gate reddens the day for it while `Create issue on failure`
  // would otherwise open nothing (the `test` job is green on exactly this shape).
  // That is #1176's defect, on a fourth axis.
  const listingLost = Array.isArray(listingMissing) ? listingMissing.filter(Boolean) : [];
  const listingIncomplete = listingLost.length > 0 || listingVerified !== true;
  // Whether the listing gap TAKES the title, computed once and read twice. The
  // first version derived the banner as "incomplete and not the shape", spelled
  // as the negation of the shape's own two clauses — which silently reduced to
  // `incomplete && testsFailed` and dropped the banner on every OTHER green-test
  // shape (an abort, a dry account, a partial run). It is last among the
  // green-test shapes because every one of those is a bigger story: this one
  // reports information the run never had, not a run that went wrong.
  const listingShape =
    listingIncomplete && !testsFailed && !empty && !partial && !mergeFailed && !uncovered && !accountDry;
  const listingLines = [
    ...(listingLost.length
      ? [
          `**${listingLost.length} spec file(s)** declaring an \`@stable\` test were **absent from`,
          "this run's listing**, so the shard matrix never contained them and no shard ran them.",
          "Not skipped, not red — **absent** (#1764/#1812):",
          "",
          ...listingLost.slice(0, 30).map((f) => `- \`${f}\``),
          ...(listingLost.length > 30 ? [`- … and ${listingLost.length - 30} more`] : []),
        ]
      : [
          "The shard matrix **could not verify** that its listing contained every spec file",
          "declaring an `@stable` test, so whether a file left the matrix on this run is",
          "**unknown** — which is not the same as no (#1012/#1812).",
        ]),
    "",
    "The usual cause is the listing environment missing something a spec gates its",
    "**collection** on — `provider-invalid-auth-error.spec.ts` generates every one of its",
    "tests from `hasProviderEnvKeys` at collection time, which is how three `@stable` tests",
    "went unexecuted from this lane's first day (#1764). Start from the",
    "`Compute duration-balanced shard matrix` step in the `prep` job, which prints the",
    "verdict in full — including whether a named file has a TITLE the check cannot",
    "evaluate (one built from a variable, on the test or on an enclosing `test.describe`),",
    "in which case a lane tag reaching that title at run time would look identical to a",
    "lost file and should be ruled out first (#1812).",
  ];

  const mergeFailedSection = [
    "### ⚠️ The shards RAN — the MERGE failed",
    "",
    "Every shard finished and wrote its blob. What failed is combining them into one",
    "report, so this run has **no merged report at all** — which is why the totals above",
    "are zeros. They are **unread, not zero**, and no spec is implicated: the failure",
    "happened after every test had already finished.",
    ...(firstError ? ["", "```", firstError, "```"] : []),
    "",
    onActions
      ? "**Triage this as the merge step**: start from the `Merge blob reports` step log and the per-shard blob artifacts. The blobs are intact and can be merged again by hand."
      : `**Triage this as the merge step**: start from \`${join(runDir, "logs/merge.log")}\`. The blobs are kept under \`${join(runDir, "all-blobs")}\` and can be merged again by hand.`,
    "Known cause of this shape: per-shard working copies recording different `testDir`",
    "values, which `merge-reports` refuses to combine — #1726.",
    ...dryAccountNote,
  ];

  const section = mergeFailed
    ? mergeFailedSection
    : empty
    ? [
        "### ⚠️ ZERO tests executed — infra abort, not a per-test failure",
        "",
        unreadable
          ? onActions
            ? "The merged report was **missing or unparseable** — the run produced no readable result at all. Suspect the `Merge blob reports` step and the per-shard blob artifacts first."
            : "The merged report was **missing or unparseable** — the run produced no readable result at all. Suspect the merge step and the per-shard blob files first."
          : `The merged report carries **no test results at all** (${runErrors} top-level report error(s)) — the shards aborted before the first test.`,
        "No spec failed and no `@stable` tag was touched, so there is **no per-test evidence to triage**.",
        ...dryAccountNoteWithCause,
        ...(firstError ? ["", "```", firstError, "```"] : []),
        "",
        "**Triage this as infrastructure**: find why nothing ran, not which test broke.",
        ...(unreadable
          ? onActions
            ? ["Start from the `Merge blob reports` step log and the per-shard blob artifacts."]
            : ["Start from the merge step log and the per-shard blob files under `all-blobs/`."]
          : [
              onActions
                ? "The shard logs and the Langflow service container logs are the evidence. This does"
                : "The shard logs (`logs/shard-N.log`) and the Langflow container logs are the evidence. This does",
              "*not* clear Langflow — a wedged or unreachable backend fails the pre-flight before",
              "any test starts. Known cause of this shape: the post-`collect-models` backend wedge — #1011.",
            ]),
      ]
    : partial
      ? [
          "### ⚠️ PARTIAL run — some shards never ran their tests",
          "",
          `The merged report carries **${runTests} test result(s)** but also **${runErrors} top-level report error(s)**.`,
          "A top-level error means a shard aborted before running the tests assigned to it, so",
          "the totals above are **UNDER-COUNTED** — the specs of the dead shard are neither",
          "passed nor failed, they simply never ran.",
          ...(firstError ? ["", "```", firstError, "```"] : []),
          "",
          "`@stable` auto-removal and the spec-duration refresh were **both skipped**: a tag must",
          "not be judged, nor a timing baseline rebuilt, on a report that never saw half the suite.",
          "",
          "**Triage the abort first.** Compare the recorded total against the last green run — a",
          "large drop is the abort, not a fix. The cause above is quoted from the shard that died;",
          "the shard logs hold the rest. Known cause of this shape: `Collect models` failing without",
          "importing a provider key as a Langflow global variable — #1058.",
        ]
      : uncovered || (accountDry && !testsFailed)
      ? [
          uncovered
            ? "### ⚠️ ZERO verdicts — provider health skipped every test that ran"
            : "### ⚠️ NO usable provider — the LLM surface of this run went unmeasured",
          "",
          ...(uncovered
            ? [
                `The report is complete and carries **${runTests} result(s)**, and **not one of them is a`,
                "verdict about Langflow**: every test that produced a result was skipped because a",
                // QUOTED, never diagnosed (#1801) — `inactive` is what was RECORDED, and
                // the record does not say which of its two causes produced it.
                "provider it needed was recorded `inactive` by `collect-models`.",
              ]
            : [
                `The report is complete and carries **${runTests} result(s)**, and **no provider was`,
                "recorded usable** — so every test that needs one was skipped and this run is not",
                "evidence about any of them. The rest of the suite did run (#1800).",
              ]),
          ...(coverageProviders
            ? ["", `Providers that went uncovered: **${coverageProviders}** (${coverageSkips} test(s)).`]
            : []),
          ...(coverageHeadline ? ["", "```", coverageHeadline, "```"] : []),
          "",
          ...(uncovered
            ? [
                "No spec failed, no `@stable` tag was touched and there is **no per-test evidence to",
                "triage** — the specs never ran. This is NOT the `empty` shape: the shards worked and",
                "the report is intact, which is exactly why the run would otherwise have read as a",
                "clean day (#1456).",
              ]
            : [
                "No spec failed on this run — this shape is only chosen when the `test` job came",
                "back green, so a day with real per-test failures keeps its own title and body.",
                "`providers.json` is written by the `collect-models` sweep AND by `globalSetup`'s",
                "credential degradation (#1058), so this says what was RECORDED, not why: a drained",
                "account and a sweep that never imported the keys both produce it.",
              ]),
          "",
          ...(uncovered
            ? [
                // The reason is QUOTED and the diagnosis left to the reader (#1801).
                // This used to read "restore the key or the credit", which is wrong for
                // one of the two ways a provider gets recorded `inactive`: a key that
                // exists but was never imported as a Langflow global variable is
                // degraded through the same record (#1058), and there the repair is the
                // import, not the billing page. Sending triage to the wrong repair in
                // the one place it reads on that day is worse than saying less.
                `**Triage ${coverageHeadline ? "the reason above" : "the reason the coverage-verdict step recorded"}, not the suite**: the specs never ran, so`,
                "none of them is implicated. The repair is whatever that reason names — a drained",
                "account, a revoked key, a spend cap, or a `Collect models` that never imported the",
                "key as a Langflow global variable (#1058, whose degraded record reads the same way",
                "here). Then re-run the day: a green run that skipped everything is not evidence that",
                "anything works (#570/#1012).",
              ]
            : [
                "**Triage this as provider configuration, not the suite**: check whether the keys are",
                "live AND whether the sweep imported them, then re-run the day. Re-running before that",
                "changes nothing, and a green run that skipped the whole LLM surface is not evidence",
                "that it works (#570/#1012).",
              ]),
          // Only on the dry-account branch. `uncovered` deliberately DROPS a stale
          // auto-removal summary (#1456): nothing ran there, so nothing failed, and
          // rendering that section reads as a triaged day. Here the shape is gated on
          // the test job being green so the step cannot have run either — belt and
          // braces — but if it somehow did, dropping the summary would tell the triager
          // the specs were not implicated on a day tags had just been stripped.
          ...(accountDry && !uncovered && arStatus
            ? [
                "",
                "### `@stable` auto-removal",
                "",
                arSummary,
                "",
                "Unexpected on this shape (it is chosen only when the test job was green) — weigh",
                "the removal against the outage above before accepting it.",
              ]
            : []),
        ]
      : listingShape
      ? [
          listingLost.length
            ? "### ⚠️ Spec file(s) never entered the shard matrix — they ran nowhere"
            : "### ⚠️ The shard matrix could not be shown complete",
          "",
          ...listingLines,
          "",
          "No spec failed on this run — this shape is only chosen when the `test` job came",
          "back green, so a day with real per-test failures keeps its own title and body and",
          "carries this as a banner instead. Nothing below is collateral of it: a file that",
          "never entered the matrix cannot have influenced the files that did.",
          "",
          "**Triage this as the listing, not the suite.** Re-running changes nothing until the",
          "`prep` job collects the missing file; and a green day that silently ran 246 of 247",
          "files is not evidence about the 247th (#1012).",
        ]
      : arStatus
        ? ["### `@stable` auto-removal", "", arSummary]
        : [
            "### Next steps",
            onActions
              ? "1. Open the Playwright report in the artifact from the run above"
              : `1. Open the Playwright report on the VM: \`${join(runDir, "playwright-report/index.html")}\``,
            "2. Determine if the failure is a test bug or a Langflow regression",
            "3. If the test is incorrect or outdated: remove the `@stable` tag from the test and open a fix PR",
            "4. If it is a Langflow regression: flag it to the team and monitor upstream",
          ];

  // The liveness section leads the body when the backend went down: the cause has
  // to be the first thing read, ahead of the per-test material, or triage starts
  // from the collateral specs again (#1030). Empty when the reporting step
  // produced no output at all.
  const livenessSection = liveness.trim() ? [liveness.trim(), ""] : [];

  // A dry account on a day that ALSO had per-test failures keeps the per-test title
  // and body — the fix for the shape hijacking a real failure day — but the first
  // version of that fix traded one information loss for its mirror image: every
  // coverage input is rendered inside the dry/uncovered section, so routing the day
  // elsewhere dropped the outage entirely, and the umbrella is the triage artifact
  // (the run's `::error::` lives in a step log nobody opens twice). It leads the body
  // for the same reason the liveness block does (#1030): the failures below are
  // plausibly collateral of the outage, and triage that starts from them starts wrong.
  //
  // Scoped to the shapes that actually carry per-test material. On `empty`, `partial`
  // and `mergeFailed` there ARE no failures below — those bodies say so themselves
  // ("no per-test evidence to triage", "no spec is implicated") — and the banner's
  // "start here" would sit above the section's own "Triage the abort first". The
  // combination is not exotic: `Collect models` failing to import a key (#1058) aborts
  // shards (`partial`) while the same sweep records every provider `inactive`
  // (`accountDry`), and the shard-side copy runs under `if: always()`, so the file
  // reaches the merge job even from a dead shard. `uncovered` is excluded too, since
  // its own section already renders every one of these lines.
  const accountBanner =
    accountDry && testsFailed && !empty && !partial && !mergeFailed && !uncovered
      ? [
          "### ⚠️ NO usable provider on this run — read the failures below against it",
          "",
          "No provider was **recorded** usable while these tests ran, so every test that needs",
          "one was skipped and the failures below may be collateral rather than causes.",
          "`providers.json` is written by the `collect-models` sweep AND by `globalSetup`'s",
          "credential degradation (#1058), so this says what was recorded, not why.",
          ...(coverageProviders
            ? ["", `Providers that went uncovered: **${coverageProviders}** (${coverageSkips} test(s)).`]
            : []),
          ...(coverageHeadline ? ["", "```", coverageHeadline, "```"] : []),
          "",
        ]
      : [];

  // #1812, the other half. When some OTHER shape took the title — a real failure
  // day, an abort, a dry account — the listing gap still has to be recorded, and
  // this is the only artifact a triager reads twice (the run's `::error::` lives in
  // a step log). Unlike `accountBanner` it is NOT scoped away from `empty` /
  // `partial` / `mergeFailed`: those bodies say no spec is implicated, and a file
  // that never entered the matrix is a fact about the RUN'S INPUT rather than about
  // the report, so it is true and unreported on exactly those shapes. It sits below
  // the account banner because it explains nothing below it — it is information
  // loss, never a cause.
  const listingBanner =
    listingIncomplete && !listingShape
      ? [
          listingLost.length
            ? "### ⚠️ Spec file(s) never entered the shard matrix on this run"
            : "### ⚠️ The shard matrix could not be shown complete on this run",
          "",
          ...listingLines,
          "",
        ]
      : [];

  // The title is what gets scanned in the issue list, so an empty run must not
  // claim that tests failed — none ran. Nor may a failed merge claim that nothing
  // ran: every shard did, and the title is the only part most people read (#1726).
  const title = mergeFailed
    ? `[Daily Failure] @stable run could not MERGE its shard reports on ${today} (${image})`
    : empty
    ? `[Daily Failure] @stable run executed ZERO tests on ${today} (${image})`
    : partial
      ? `[Daily Failure] @stable run was PARTIAL — a shard never ran on ${today} (${image})`
      : uncovered
        ? `[Daily Failure] @stable run produced ZERO verdicts — provider health skipped every test on ${today} (${image})`
        : accountDry && !testsFailed
          ? `[Daily Failure] @stable run had NO usable provider on ${today} (${image})`
          : listingShape
            ? listingLost.length
              ? `[Daily Failure] ${listingLost.length} @stable spec file(s) never entered the shard matrix on ${today} (${image})`
              : `[Daily Failure] @stable shard matrix could not be shown complete on ${today} (${image})`
            : `[Daily Failure] @stable tests failed on ${today} (${image})`;

  // On Actions the run link IS the evidence. On a VM the evidence is a path, and
  // naming the host is what lets a reader find it at all.
  const runLines = onActions
    ? [`- **Run:** [${runId}](${runUrl})`]
    : [
        `- **Run:** \`${runId}\` — executed on the QA VM (no GitHub Actions run to link)`,
        `- **Evidence:** \`${runDir}\` on \`${hostname}\``,
      ];

  const body = [
    "## Daily @stable E2E Failure",
    "",
    `- **Date:** ${today}`,
    `- **Langflow version:** \`${image}\``,
    ...runLines,
    "",
    ...livenessSection,
    ...accountBanner,
    ...listingBanner,
    ...section,
    ...(cc.trim() ? ["", `/cc ${cc.trim()}`] : []),
  ].join("\n");

  return { title, body };
}

/** The REST endpoint for a host — github.com vs a GitHub Enterprise instance. */
export function apiUrlFor(host, repo) {
  const base =
    host === "github.com" || host === "" || host === undefined
      ? "https://api.github.com"
      : `https://${host}/api/v3`;
  return `${base}/repos/${repo}/issues`;
}

const LABELS = ["daily-failure", "needs-triage"];

/**
 * Create the issue. Returns `{ ok, url, how, reason }` and NEVER throws — the
 * caller decides whether a failure is fatal (ISSUE_STRICT), because the two lanes
 * want opposite answers.
 */
export async function createIssue({ title, body, repo, host = "github.com", token = "", dryRun = false }) {
  if (dryRun) return { ok: true, url: "", how: "dry-run", reason: "" };

  // Token first: it is the deterministic path and the only one available inside
  // the daily's Playwright container, which ships no `gh`.
  let apiReason = "";
  if (token) {
    try {
      const res = await fetch(apiUrlFor(host, repo), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
          "User-Agent": "langflow-e2e-daily",
        },
        body: JSON.stringify({ title, body, labels: LABELS }),
      });
      const text = await res.text();
      if (res.ok) {
        let url = "";
        try {
          url = JSON.parse(text).html_url || "";
        } catch {
          /* a 2xx with an unparseable body still created the issue */
        }
        return { ok: true, url, how: "api", reason: "" };
      }
      apiReason = `HTTP ${res.status}: ${text.slice(0, 300)}`;
    } catch (e) {
      apiReason = e.message;
    }
    // A token that is PRESENT is not a token that WORKS. On a VM where a human is
    // logged into `gh`, a stale or wrongly-scoped GITHUB_TOKEN in the environment
    // would otherwise take the only shot at creating the issue and lose it — the
    // umbrella missing because of a variable nobody set on purpose. Inside the
    // daily's container there is no `gh`, so this costs a `gh not runnable` line
    // and the API reason is still what gets reported.
    console.error(`[issue] the API path failed (${apiReason}) — trying \`gh\`.`);
  }

  const gh = spawnSync(
    "gh",
    ["issue", "create", "--repo", repo, "--title", title, "--body", body,
     ...LABELS.flatMap((l) => ["--label", l])],
    { env: { ...process.env, GH_HOST: host }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  // When the API was tried first, its reason is the one that explains the failure —
  // "gh not runnable" alone would point triage at a missing CLI on a lane that never
  // wanted one.
  const withApi = (reason) => (apiReason ? `api: ${apiReason}; gh: ${reason}` : reason);
  const how = apiReason ? "api+gh" : "gh";
  if (gh.error) return { ok: false, url: "", how, reason: withApi(`gh not runnable (${gh.error.message})`) };
  if (gh.status !== 0) {
    return { ok: false, url: "", how, reason: withApi(`gh issue create failed (exit ${gh.status}): ${(gh.stderr || "").slice(0, 300)}`) };
  }
  return { ok: true, url: (gh.stdout || "").trim(), how: "gh", reason: "" };
}

/**
 * `LISTING_MISSING` as the daily writes it: a JSON array of spec paths (#1812).
 *
 * Guarded, and not because the producer is untrusted — because this script runs
 * with `ISSUE_STRICT=1` on an ALREADY RED day, so a throw here costs the umbrella
 * for whatever really failed. A value it cannot read is reported as "the check
 * could not be verified", which is the honest reading and the one the shape
 * already renders.
 */
export function parseListingMissing(raw) {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((f) => typeof f === "string" && f) : [];
  } catch {
    return [];
  }
}

async function main() {
  const env = process.env;
  const runDir = env.RUN_DIR || ".";
  const strict = env.ISSUE_STRICT === "1";

  const { title, body } = renderIssue({
    today: new Date().toISOString().split("T")[0],
    image: env.IMAGE || "",
    runId: env.RUN_ID || "",
    runDir,
    runUrl: env.RUN_URL || "",
    hostname: env.VM_HOSTNAME || env.HOSTNAME || "the QA VM",
    arStatus: env.AUTO_REMOVE_STATUS || "",
    arSummary: env.AUTO_REMOVE_SUMMARY || "",
    empty: env.RUN_EMPTY === "true",
    unreadable: env.RUN_UNREADABLE === "true",
    partial: env.RUN_PARTIAL === "true",
    // Absent means "the caller does not track it", which is a working merge — the
    // Actions lane never passes it, and it has never had this failure mode.
    mergeFailed: env.MERGE_OK === "false",
    runErrors: env.RUN_ERRORS || "0",
    firstError: env.RUN_FIRST_ERROR || "",
    runTests: env.RUN_TESTS || "0",
    // #1456. Absent means "the caller does not track it" — the VM lane passes
    // nothing today, and an unset verdict must never pick this shape: a shape is
    // chosen by POSITIVE identification, unlike the run's gate, which is
    // fail-closed. Mislabelling a day is worse than not labelling it.
    uncovered: env.COVERAGE_VERDICT === "uncovered",
    // #1800. The account axis, which the verdict cannot carry: a run can be
    // `degraded` — hundreds of tests executed — while no provider was reachable at
    // all, and that is the shape this lane can actually reach.
    accountDry: env.COVERAGE_ACCOUNT === "dry",
    // Whether SPECS also failed, which the coverage axis cannot tell (#1800 review).
    // Without it a dry account took the title on a day with real per-test failures and
    // rendered a body carrying neither the failures nor — when the mass-failure guard
    // left `arStatus` empty, which is exactly the >5-failure outage day — an
    // auto-removal block its own hedge pointed at.
    testsFailed: env.TESTS_FAILED === "true",
    // #1812. `!== "false"` would be wrong here for the reason the run's GATE reads
    // it the other way round: the gate must fail on an unknown, this must not LABEL
    // on one — a shape is chosen by positive identification. So an absent
    // `LISTING_VERIFIED` (the VM lane, which does not run the check) means "not
    // tracked" and selects nothing, while an explicit "false" is reported.
    listingVerified: env.LISTING_VERIFIED === undefined ? true : env.LISTING_VERIFIED === "true",
    listingMissing: parseListingMissing(env.LISTING_MISSING),
    coverageHeadline: env.COVERAGE_HEADLINE || "",
    coverageProviders: env.COVERAGE_PROVIDERS || "",
    coverageSkips: env.COVERAGE_SKIPS || "0",
    liveness: env.LIVENESS_MD || "",
    cc: env.ISSUE_CC === undefined ? CC_DEFAULT : env.ISSUE_CC,
  });

  mkdirSync(runDir, { recursive: true });
  const bodyPath = join(runDir, "issue-body.md");
  writeFileSync(bodyPath, `${title}\n\n${body}\n`, "utf8");
  console.log(`[issue] body written to ${bodyPath}`);

  const host = env.ISSUE_HOST || "github.com";
  const repo = env.ISSUE_REPO || "oriontech-me/langflow-e2e";
  const result = await createIssue({
    title,
    body,
    repo,
    host,
    token: env.GITHUB_TOKEN || env.GH_TOKEN || "",
    dryRun: env.ISSUE_DRY_RUN === "1",
  });

  if (result.how === "dry-run") {
    console.log(`[issue] ISSUE_DRY_RUN=1 — nothing created. Would have opened on ${host}/${repo}:`);
    console.log(`[issue] title: ${title}`);
    return 0;
  }

  if (!result.ok) {
    // Never a bare warning on a lane that wanted the issue: `strict` is what turns
    // "the umbrella is missing" from a line nobody reads into a red step.
    console.error(
      `::${strict ? "error" : "warning"}::issue NOT created via ${result.how} — ${result.reason}. Body kept at ${bodyPath}.`,
    );
    return strict ? 1 : 0;
  }

  console.log(`[issue] created on ${host}/${repo} via ${result.how}: ${result.url || "(url not reported)"}`);
  // Hand the URL to whatever runs next (the Slack notifier links it, so the two
  // views of one verdict point at each other instead of being found separately).
  if (result.url) writeFileSync(join(runDir, "issue-url.txt"), result.url, "utf8");
  return 0;
}

const invokedDirectly = (() => {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (invokedDirectly) process.exit(await main());
