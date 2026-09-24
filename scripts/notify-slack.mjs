#!/usr/bin/env node
// Post the daily's verdict to Slack when it is bad.
//
// ## Why a script and not a curl in the runner
//
// Same reason `create-failure-issue.mjs` is a script: the message is a DECISION,
// not a template. A run can be bad in four mutually exclusive ways, and saying
// the wrong one is worse than saying nothing —
//
//   - MERGE failed: every shard ran and combining their blobs is what broke, so
//     there is no report to read. It looks exactly like the shape below — empty and
//     unreadable — and telling a reader to "find why nothing ran" would send them
//     after a run that ran in full (#1726).
//   - ZERO tests executed: an infra abort. A message reading "3 tests failed"
//     when nothing ran points triage at specs instead of at the backend (#1012).
//   - PARTIAL: a shard died before running its slice, so the totals are
//     UNDER-COUNTED. Reporting them as the day's numbers reads as an improvement
//     when it is a loss (#1058).
//   - Per-test failures: the normal red day, and the only one where a failure
//     list means anything.
//
// It deliberately mirrors the four shapes of the GitHub issue: the Slack message
// and the issue are two views of one verdict, and they must never disagree.
//
// A FIFTH shape exists here and has no counterpart in the issue, because the two
// scripts stand in different places: the issue is rendered from inputs the caller
// hands it, while this one READS the run's numbers off disk and can therefore fail
// to. That is `unknown` — announced, never rendered as zero.
//
// A SIXTH has no counterpart either, for a different reason: `green` is a day the
// issue does not exist on. It is OFF by default and off for everyone who does not ask
// (`SLACK_ANNOUNCE_GREEN=1`), because announcing a clean day is only worth the noise
// where the reader has no other way to see the run happened — the Actions lane has a
// run list, the VM lane has systemd and a log file behind a VPN (#1981). It is still a
// DECISION and not a template: a clean day and an unread one must not read alike, so
// green is held to the same evidence as the rest — see the gate below.
//
// ## Why it reads payload.json and not results.json
//
// `build-run-payload.mjs` already parses the merged report into totals + failures.
// A second parser here would be a second thing to keep in step with Playwright's
// report format, and the first day they disagreed nobody would know which was
// right. One parser, one source of truth.
//
// ## Two transports, detected from the URL
//
// A classic Incoming Webhook (`hooks.slack.com/services/…`, from a Slack app)
// takes Block Kit and renders exactly what this script builds. A Workflow Builder
// webhook (`hooks.slack.com/triggers/…`) does NOT: it takes a FLAT object whose
// keys are the variables declared on the trigger, and the layout is assembled in
// Slack's UI. Posting Block Kit to it is silently accepted and renders nothing
// useful, so the shape has to match the URL.
//
// The mode is derived from the URL path rather than configured, because a wrong
// knob and a right URL is the failure nobody catches: the POST returns 200 either
// way. SLACK_MODE overrides it if Slack ever changes the paths.
//
// Workflow Builder mode posts three variables — `headline`, `body`, `links` —
// deliberately few and deliberately coarse. Every extra variable is manual UI work
// for whoever maintains the workflow, and keeping the formatting HERE means a
// change to the message is a code change with a test, not a trip through a
// web form.
//
// ## Contract
//
// Fail-soft by construction, exactly like the QA Platform POST it sits next to:
// no webhook configured, an unreachable Slack, a 500 — all print and exit 0. A
// notifier must never be the reason a run reports failure.
//
// Inputs (env):
//   SLACK_WEBHOOK_URL   Incoming Webhook OR Workflow Builder trigger URL.
//                       ABSENT = skip, quietly and cleanly.
//   SLACK_MODE          "blockkit" | "workflow". Default: derived from the URL.
//                       An unrecognised value warns and keeps the derived mode.
//   SLACK_TIMEOUT_MS    per-request deadline (default 15000)
//   PAYLOAD_JSON        path to the run payload (default: payload.json)
//   RUN_EMPTY / RUN_PARTIAL / RUN_UNREADABLE / RUN_ERRORS / RUN_TESTS / RUN_FIRST_ERROR
//   MERGE_OK             "false" = the shards ran and merging them failed (#1726).
//                        Absent = the caller does not track it, i.e. a working merge.
//   LIVENESS_MEASURED / LIVENESS_WEDGED / LIVENESS_OUTAGES / LIVENESS_DOWN_SECONDS
//   ISSUE_URL           the triage issue this run opened, if any
//   REPORT_URL          where the Playwright report lives
//   RUN_ID, VM_HOSTNAME
//   SLACK_DRY_RUN=1     render and print the payload, post nothing
//   SLACK_ANNOUNCE_GREEN=1  announce a CLEAN day too, as its own shape. Default: off.
//   TEST_JOB_FAILED     "1" = the RUNNER failed this run, for a reason that may not be
//                       in the report at all. It can never be announced as green.
//   MIRROR_SUMMARY      one plain-text line on the suite's mirror, from
//                       scripts/mirror-freshness-summary.mjs. Absent = no line.
//   SLACK_FORCE=1       post even when the run reported nothing bad (wiring test).
//                       Implies SLACK_ANNOUNCE_GREEN — it posts the green message, not
//                       a red one with a zero in it.
//
// Run: node scripts/notify-slack.mjs

import { readFileSync, existsSync } from "node:fs";

const env = process.env;
const webhook = env.SLACK_WEBHOOK_URL || "";
const dryRun = env.SLACK_DRY_RUN === "1";

if (!webhook && !dryRun) {
  console.log("[slack] SLACK_WEBHOOK_URL not set — skipping the notification.");
  process.exit(0);
}

// Slack's own limits, not guesses: a section's text caps at 3000 characters and a
// header's at 150, and a payload that breaks either is rejected whole — so the
// message would be lost precisely on the noisiest day.
//
// Those are BLOCK KIT's documented limits. A Workflow Builder trigger publishes no
// per-variable limit, so the same cap is applied there — conservative rather than
// derived, which is worth saying because a variable over the real limit would fail
// the way everything fails on that transport: HTTP 200 and an empty channel.
// Checked against a live trigger on 2026-09-03 with 40 failures: the budget listed
// 9 and elided 31, the body rendered at 2718 characters, and the channel showed all
// of it including the closing notice. So 2900 is safe on both at this order of
// magnitude — measured, not assumed, and re-measure before raising it.
const HEADER_MAX = 150;
const SECTION_MAX = 2900;
const MAX_FAILURES_LISTED = 10;
const SIGNATURE_MAX = 160;

const truncate = (s, n) => {
  const t = String(s ?? "");
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
};

const payloadPath = env.PAYLOAD_JSON || "payload.json";
let run = {};
// Whether the run's own numbers were READ, as opposed to defaulted. Everything
// downstream of `totals` is unknown when this is false, and "unknown" and "zero"
// must not render as the same sentence — see the headline below.
let payloadRead = false;
if (existsSync(payloadPath)) {
  try {
    run = JSON.parse(readFileSync(payloadPath, "utf8"));
    payloadRead = true;
  } catch (e) {
    console.error(`[slack] ${payloadPath} is unreadable (${e.message}) — reporting what the guards saw instead.`);
  }
} else {
  console.error(`[slack] no ${payloadPath} — reporting what the guards saw instead.`);
}

const empty = env.RUN_EMPTY === "true";
const partial = env.RUN_PARTIAL === "true";
const unreadable = env.RUN_UNREADABLE === "true";
const mergeFailed = env.MERGE_OK === "false";
const reportErrors = env.RUN_ERRORS || "0";
const firstError = env.RUN_FIRST_ERROR || "";
const testsTotal = env.RUN_TESTS || "0";

const totals = run.totals || {};
const failures = Array.isArray(run.failures) ? run.failures : [];
const image = run.langflow_image || env.LANGFLOW_IMAGE || "unknown";
const version = run.langflow_version || env.LANGFLOW_VERSION || "";
const date = run.date || new Date().toISOString().slice(0, 10);
const runId = run.run_id || env.RUN_ID || "local";
const host = env.VM_HOSTNAME || env.HOSTNAME || "the QA VM";

// ---------------------------------------------------------------------------
// The shapes — the four of create-failure-issue.mjs, in its order and for its
// reasons, plus `unknown` for a payload this script could not read.
// ---------------------------------------------------------------------------

// A fifth outcome, and it is NOT one of the four: the run's own numbers could
// not be read at all. Kept separate because "unknown" and "zero" are different
// sentences — see the headline below.
const failedCount = totals.failed;
const countKnown = failedCount !== undefined && failedCount !== null;
const verdictUnknown = !countKnown && failures.length === 0;

// `merge_failed` leads, exactly as it does in the issue. A failed merge leaves no
// report, so the integrity guard reports the run empty and unreadable and this
// message would have headlined "executed ZERO tests" on a day when every shard
// finished — pointing triage at the backend instead of at the merge step (#1726).
let shape = mergeFailed
  ? "merge_failed"
  : empty
    ? "empty"
    : partial
      ? "partial"
      : verdictUnknown
        ? "unknown"
        : "failures";

// A GREEN day is not one of the four shapes, and this script has to say so
// itself. Its header claims it "fires on the SAME condition as the triage issue",
// but that condition lives in the caller — and the caller is the runner, the one
// piece still being written. Without this, a run that is neither empty nor partial
// and failed nothing renders "🔴 Daily @stable failed — 0 test(s)": the #1012
// defect pointed the other way, announcing a verdict the report does not support.
// The gate belongs HERE because here is where the verdict is decided; a caller
// that forgets it is a caller, and there will be more than one.
//
// Deliberately narrow: it fires only when EVERY signal agrees the day was clean —
// not empty, not partial, a failed count that was actually READ and is exactly
// zero, and an empty failure list. An absent or unreadable payload leaves
// `totals.failed` undefined, which is UNKNOWN rather than zero: it takes the
// `unknown` shape above, is still announced (#1012 again), and never reaches this
// gate. SLACK_FORCE=1 posts anyway, which is how the webhook wiring gets tested
// against a green run without editing this file.
const nothingFailed =
  shape === "failures" &&
  (failedCount === 0 || failedCount === "0") &&
  failures.length === 0;

// Whether a clean day is ANNOUNCED or passed over is the CALLER's call, because it
// turns on what else the reader can see — and it is the only thing the caller gets to
// decide here. The evidence above is not relaxed by it: `nothingFailed` is still the
// same narrow conjunction, so an unread payload takes the `unknown` shape before this
// line and can never be announced as a clean one. The knob chooses between saying the
// green sentence and saying nothing; it cannot make a green sentence out of a day that
// was not green. SLACK_FORCE implies it, so the wiring test posts what a green day
// would really look like instead of "🔴 Daily @stable failed — 0 test(s)" (#1981).
const announceGreen = env.SLACK_ANNOUNCE_GREEN === "1" || env.SLACK_FORCE === "1";

// A clean REPORT is not a clean RUN, and the two come apart in ways this file cannot
// see from `payload.json` alone. Both were live before they were guarded:
//
//   - THE RUNNER FAILED THE RUN. A shard whose subshell dies never writes its blob:
//     the merged report holds the survivors, carries no top-level error, and is
//     therefore neither empty nor partial — while `phase_merge` sets SHARD_COMPLETE
//     false and the verdict exits 1. The surviving specs passed, so the payload reads
//     exactly like a green day. Same for the listing gate and the version gate: they
//     fail a run over something no test result mentions. On such a day the umbrella
//     IS opened, so announcing green here does not merely overstate the day — it
//     contradicts, in the same channel, the issue this message is a second view of.
//   - NOTHING PASSED. `tests_total` counts skipped, so a run whose specs skip at
//     RUNTIME — expired provider credentials, an entitlement gate — is not empty, not
//     partial, and fails nothing. That is the green-all-skip #1010 and #1012 exist to
//     prevent, and it renders `0 failed · 0 flaky · 0 passed · 735 skipped`.
//
// Neither is a reason to say something ELSE: the refusal is a refusal, and the day is
// still reported by the umbrella and by the missed-run alarm. This restores the
// silence that preceded the green shape for exactly these two days, and says why on
// stderr so the log carries the reason.
const runnerFailed = env.TEST_JOB_FAILED === "1";
const passedRaw = totals.passed;
const somethingPassed =
  passedRaw !== undefined && passedRaw !== null && passedRaw !== "" && Number(passedRaw) > 0;

if (nothingFailed && !announceGreen) {
  console.log(
    "[slack] the run reported no failures and neither the empty nor the partial verdict — nothing to announce. " +
      "(SLACK_ANNOUNCE_GREEN=1 announces the clean day as its own message; SLACK_FORCE=1 posts anyway, " +
      "e.g. to test the webhook wiring.)",
  );
  process.exit(0);
}

if (nothingFailed && (runnerFailed || !somethingPassed)) {
  const why = [
    runnerFailed ? "the runner reported this run as FAILED, for a reason the per-test report does not carry" : "",
    somethingPassed ? "" : `not one test passed (${totals.skipped ?? "?"} skipped)`,
  ].filter(Boolean).join("; and ");
  console.error(
    `[slack] ::warning:: the report lists no failures, but ${why} — refusing to announce a clean day. ` +
      "Nothing was posted; the run's own verdict and the umbrella stand.",
  );
  process.exit(0);
}

// From here the day is green AND the caller asked for it. Its own shape, not
// `failures` with a zero in it — every sentence below keys off this.
if (nothingFailed) shape = "green";

// Keyed on the PATH segment, not on the host. `/triggers/` vs `/services/` is what
// actually distinguishes the two, and requiring `hooks.slack.com` as well makes the
// detection fail silently behind a proxy or a relay — falling back to Block Kit,
// which a Workflow Builder trigger accepts with a 200 and renders as nothing.
const derivedMode = /\/triggers\//.test(webhook) ? "workflow" : "blockkit";

// The override is CHECKED, not trusted. `mode === "workflow" ? … : blockkit` reads
// every value that is not exactly "workflow" as Block Kit, so `SLACK_MODE=workflows`
// or `SLACK_MODE=Workflow` silently posted Block Kit to a trigger — accepted with a
// 200, rendered as nothing, which is the one failure this whole derivation exists to
// avoid. An unrecognised value falls back to what the URL says and SAYS SO; it does
// not fail the run, because the fail-soft contract above outranks it.
const MODES = ["blockkit", "workflow"];
let mode = derivedMode;
if (env.SLACK_MODE) {
  if (MODES.includes(env.SLACK_MODE)) {
    mode = env.SLACK_MODE;
  } else {
    console.error(
      `[slack] ::warning:: SLACK_MODE="${env.SLACK_MODE}" is not one of ${MODES.join("|")} — ` +
        `using "${derivedMode}", derived from the webhook URL.`,
    );
  }
}

// mrkdwn is a Block Kit feature. A Workflow Builder message step is a RICH-TEXT
// editor, and whatever arrives through a variable is inserted as plain text: `*bold*`
// renders as asterisks, `<url|label>` renders as itself. Verified against a real
// trigger on 2026-09-03 — the POST returned 200 and the channel showed the markup,
// which is the same class of silent wrongness the mode derivation above exists to
// avoid, one layer further in.
//
// So the DECORATION is mode-aware while the WORDS stay a single construction — that
// is what keeps the two transports from drifting apart. Generated plain rather than
// stripped afterwards, because stripping cannot tell our markers from content: a
// spec named `model_provider_base_url_ssrf` would lose half its name to a regex
// hunting underscores, and the failure list is exactly where those names live.
const rich = mode !== "workflow";
const bold = (s) => (rich ? `*${s}*` : `${s}`);
const code = (s) => (rich ? `\`${s}\`` : `${s}`);
const italic = (s) => (rich ? `_${s}_` : `${s}`);
const fence = (s) => (rich ? "```\n" + s + "\n```" : s);
// A bare URL is auto-linked by Slack in both transports, so the plain form loses the
// label's placement but never the destination.
const linkTo = (url, label) => (rich ? `<${url}|${label}>` : `${label}: ${url}`);

const headline = {
  merge_failed: `⚠️ Daily @stable could not MERGE its shard reports — ${date}`,
  empty: `⚠️ Daily @stable executed ZERO tests — ${date}`,
  partial: `⚠️ Daily @stable was PARTIAL — a shard never ran — ${date}`,
  // Never "failed — 0 test(s)". That sentence is read as "zero tests failed", i.e.
  // as a clean day, on a run where nobody could tell — the same false verdict as
  // announcing failures on an empty report, pointed the other way (#1012).
  unknown: `⚠️ Daily @stable — verdict UNKNOWN, the run's report could not be read — ${date}`,
  failures: `🔴 Daily @stable failed — ${totals.failed ?? failures.length} test(s) — ${date}`,
  // No warning glyph and no number that could be misread as a loss: this one is read
  // at a glance, every weekday, and its whole job is to be distinguishable from the
  // five above without being read word by word.
  green: `✅ Daily @stable is green — ${totals.passed ?? 0} passed — ${date}`,
}[shape];

const diagnosis = {
  merge_failed: [
    `${bold("The shards RAN and the merge FAILED")} — every shard finished and wrote its blob; combining them into one report is what broke.`,
    `There is no merged report, so any number here is ${bold("unread, not zero")}, and no spec is implicated — the failure happened after every test had finished.`,
    `${bold("Triage the merge step")}: read the run's ${code("logs/merge.log")}. The blobs are kept under ${code("all-blobs/")} and can be merged again by hand.`,
  ].join("\n"),
  empty: [
    unreadable
      ? `${bold("The merged report was missing or unparseable")} — the run produced no readable result at all.`
      : `${bold("The merged report carries no test results at all")} (${reportErrors} top-level report error(s)) — the shards aborted before the first test.`,
    `No spec failed and no ${code("@stable")} tag was touched, so there is ${bold("no per-test evidence to triage")}.`,
    `${bold("Triage this as infrastructure")}: find why nothing ran, not which test broke.`,
  ].join("\n"),
  partial: [
    bold(`${testsTotal} test result(s) but ${reportErrors} top-level report error(s).`),
    `A shard aborted before running the tests assigned to it, so the totals are ${bold("UNDER-COUNTED")} — the dead shard's specs are neither passed nor failed, they never ran.`,
    `${code("@stable")} auto-removal and the duration refresh were both skipped. ${bold("Triage the abort first")} — a large drop against the last green run is the abort, not a fix.`,
  ].join("\n"),
  unknown: [
    payloadRead
      ? `${bold("The run payload carried no totals")} (${code(truncate(payloadPath, 120))}) — it parsed, but the numbers this message reports are not in it.`
      : `${bold("The run payload was missing or unreadable")} (${code(truncate(payloadPath, 120))}) — the numbers this message reports were never produced.`,
    `The guards reported neither the empty nor the partial verdict, so ${bold("nothing can be said about what passed or failed")} — this is not a clean day, it is an unread one.`,
    `${bold("Start from the run directory and the merge step")}: find out why the payload is not there, then re-read the verdict from the report itself.`,
  ].join("\n"),
  failures: null,
  green: [
    `${bold("Nothing to triage.")} Every spec that ran passed, and the guards reported neither the empty nor the partial verdict — the totals above were read from the run's own payload, not defaulted.`,
    `${italic("Sent on a clean day on purpose: this lane has no run list to open, so silence would mean both \u201cgreen\u201d and \u201cnobody is looking\u201d.")}`,
  ].join("\n\n"),
}[shape];

// ---------------------------------------------------------------------------
// The message, as text — computed ONCE and shared by both transports, so the
// Workflow Builder message and the Block Kit message can never drift apart.
// ---------------------------------------------------------------------------

const wedged = env.LIVENESS_MEASURED === "true" && env.LIVENESS_WEDGED === "true";
// The backend-outage verdict LEADS the per-test material when it fired: the cause
// has to be read before the collateral, or triage starts from the wrong specs
// (#1030). Gated on `measured` — `wedged` is also "false" when nothing was probed.
// On a GREEN day the same measurement is true and the instruction is not: there are no
// failing specs to read as collateral, and telling a reader to "read the outage first"
// sends them hunting for a triage that does not exist. The number still goes out —
// the wedge (#1030) is a trend, and a green day that measured one is a data point the
// channel should have — but as a note, not as a lead.
const outageNote = !wedged
  ? ""
  : shape === "green"
    ? `⚡ ${bold("The backend went down mid-run")} — ${env.LIVENESS_OUTAGES || "?"} outage(s), ` +
      `${env.LIVENESS_DOWN_SECONDS || "?"}s unreachable in total — and ${bold("nothing failed around it")}.\n` +
      `Recorded because the mid-run wedge (#1030) is a trend, not because this day needs triage.`
    : `⚡ ${bold("The backend went down mid-run")} — ${env.LIVENESS_OUTAGES || "?"} outage(s), ` +
      `${env.LIVENESS_DOWN_SECONDS || "?"}s unreachable in total.\n` +
      `Specs that failed inside those windows are ${bold("collateral, not per-test failures")}. Read the outage first.`;

const elisionNotice = (n) => `\n${italic(`… and ${n} more not listed here — see the report.`)}`;

/**
 * The failure list, built to FIT — `budget` is what Slack's section cap leaves
 * after everything that cannot be dropped has taken its share.
 *
 * NAME what was elided rather than silently cutting: a list that stops at 10 reads
 * as "10 failures" when it was 40. That was already true of the 10-item cap, but
 * not of the character cap underneath it: the notice is the LAST line, so a body
 * truncated at SECTION_MAX cut the notice off first and the message ended mid-entry
 * with an ellipsis — the same silent cut, one layer down. Measured before the fix:
 * 22 failures with realistic titles and signatures rendered a 2900-char body ending
 * inside the 9th entry, with no count. It had not fired yet — the worst day in
 * `reports/daily-history.jsonl` (2026-07-22, 22 failures) renders ~2140 — so this is
 * a floor under a margin of roughly three long entries, not a fix for a live defect.
 *
 * So the notice is BUDGETED, not appended: each entry is admitted only if it still
 * leaves room for the notice that stopping after it would require. At least one
 * entry is always kept — an empty list under a tight budget says even less than a
 * short one, and the final truncate() is still there as a backstop.
 */
const failureList = (budget) => {
  if (!failures.length) return "";
  const rendered = failures.slice(0, MAX_FAILURES_LISTED).map((f) => {
    const file = String(f.file || "").split("/").pop() || f.file || "?";
    return `• ${code(file)} — ${truncate(f.test || "?", 120)}\n   ${italic(truncate(f.error_signature || "unknown", SIGNATURE_MAX))}`;
  });

  const kept = [];
  let used = 0;
  for (const entry of rendered) {
    const cost = (kept.length ? 1 : 0) + entry.length; // 1 = the "\n" join
    const leftIfStopHere = failures.length - (kept.length + 1);
    const reserve = leftIfStopHere > 0 ? 1 + elisionNotice(leftIfStopHere).length : 0;
    if (kept.length && used + cost + reserve > budget) break;
    kept.push(entry);
    used += cost;
  }

  const left = failures.length - kept.length;
  return (left > 0 ? [...kept, elisionNotice(left)] : kept).join("\n");
};

// How long the run took, which only the green message carries. On a bad day it is
// noise beside the diagnosis; on a clean one it is half of what a reader is checking —
// a green day that took twice as long as usual is worth a second look, and nothing
// else in this message would show it.
// Rounded to minutes, EXCEPT under one: `Math.round` renders a 40-second run as
// "0 min", and the one number here whose job is to make an abnormal green day worth a
// second look would read as a formatting artefact on exactly such a day.
const durationText = !Number.isFinite(run.duration_ms) || run.duration_ms <= 0
  ? null
  : run.duration_ms < 60_000
    ? `${Math.max(1, Math.round(run.duration_ms / 1000))} s`
    : `${Math.round(run.duration_ms / 60_000)} min`;

const countsLine = `${bold(`${totals.failed ?? 0} failed`)} · ${totals.flaky ?? 0} flaky · ${totals.passed ?? 0} passed · ${totals.skipped ?? 0} skipped`;

const totalsLine =
  shape === "failures"
    ? countsLine
    : shape === "green"
      ? [countsLine, durationText ?? ""].filter(Boolean).join("  ·  ")
      : "";

// Truncate the quoted cause BEFORE it is fenced, not after. The body as a whole is
// capped at SECTION_MAX, and a cut that lands inside the fence leaves it unclosed
// and elides the diagnosis with nothing but an ellipsis to show for it — a silent
// cap, which is the thing this file refuses to do for the failure list two blocks
// up. check-run-integrity.mjs already caps `first_error` to a single line, so this
// is a floor under an assumption about another script, not a fix for a live defect.
const ERROR_MAX = 600;
const errorBlock = firstError ? fence(truncate(firstError, ERROR_MAX)) : "";

// Everything that cannot be dropped, in order. The failure list is the only part
// that gets to shrink, so it is the only part that has to know what is left.
//
// The outage note LEADS on a bad day and TRAILS on a green one, and that is the same
// rule stated twice rather than two rules: whatever the reader has to act on comes
// first. On a red day that is the cause; on a green day there is nothing to act on, so
// the verdict leads and the measurement is a footnote to it.
const fixedText = [
  `${bold("Langflow")} ${code(truncate(version || image, 200))}  ·  ${bold("Run")} ${code(truncate(runId, 200))} on ${host}`,
  totalsLine,
  shape === "green" ? "" : outageNote,
  diagnosis || "",
  shape === "green" ? outageNote : "",
  // Not on a green day, whatever the caller passed: a quoted cause under "nothing to
  // triage" is a contradiction, and the two would be read in the wrong order.
  diagnosis && shape !== "green" ? errorBlock : "",
]
  .filter(Boolean)
  .join("\n\n");

// Last, on every shape, after the failure list: it qualifies the whole message (was the
// suite current?) and it is the only place the mirror's overnight stalls are written
// down, since the freshness alarm posts at most once a day. It cannot be dropped, so its
// length comes out of the list's budget like the fixed text's does. Plain text in,
// decorated here.
const mirrorText = env.MIRROR_SUMMARY ? `${bold("Mirror")}: ${truncate(env.MIRROR_SUMMARY, 300)}` : "";

const tail = diagnosis
  ? ""
  : failureList(SECTION_MAX - fixedText.length - 2 - (mirrorText ? mirrorText.length + 2 : 0));

const body = [fixedText, tail, mirrorText].filter(Boolean).join("\n\n");

const links = [];
if (env.ISSUE_URL) links.push(linkTo(env.ISSUE_URL, "Triage issue"));
if (env.REPORT_URL) {
  // A `file://` report is not a link anyone can click from Slack — say where it
  // is instead of rendering a link that silently does nothing.
  links.push(
    env.REPORT_URL.startsWith("file://")
      ? `Report: ${code(env.REPORT_URL.replace(/^file:\/\//, ""))} on ${host}`
      : linkTo(env.REPORT_URL, "Playwright report"),
  );
}
const linksText = links.join("  ·  ");

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

// The transport is resolved ABOVE, before the message text is built: what markup
// that text may carry depends on which transport will carry it.

const requestBody =
  mode === "workflow"
    ? // Flat variables. The trigger must declare `headline`, `body` and `links`
      // as Text — a key the trigger does not know is dropped, and a declared
      // variable the POST omits fails the trigger outright, so all three are
      // always sent even when empty.
      {
        headline: truncate(headline, SECTION_MAX),
        body: truncate(body, SECTION_MAX),
        links: truncate(linksText, SECTION_MAX),
      }
    : {
        // `text` is the notification/fallback string — what a phone shows and what
        // a screen reader reads. Without it Slack pushes a blank notification.
        text: headline,
        blocks: [
          { type: "header", text: { type: "plain_text", text: truncate(headline, HEADER_MAX), emoji: true } },
          { type: "section", text: { type: "mrkdwn", text: truncate(body, SECTION_MAX) } },
          ...(linksText
            ? [{ type: "context", elements: [{ type: "mrkdwn", text: truncate(linksText, SECTION_MAX) }] }]
            : []),
        ],
      };

if (dryRun) {
  console.log(`[slack] mode=${mode}`);
  console.log(JSON.stringify(requestBody, null, 2));
  process.exit(0);
}

try {
  const res = await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(requestBody),
    // Bounded, and configurable: a VM behind a slow corporate proxy may need
    // longer, and a test needs it far shorter than a 15 s default.
    signal: AbortSignal.timeout(Number(env.SLACK_TIMEOUT_MS) || 15000),
  });
  const text = (await res.text()).trim();
  if (res.ok) {
    console.log(`[slack] posted (${mode}, HTTP ${res.status}).`);
  } else {
    console.error(`[slack] ::warning:: post failed (HTTP ${res.status}: ${truncate(text, 300)}) — the run's verdict is unaffected.`);
  }
} catch (e) {
  console.error(`[slack] ::warning:: post failed (${e.message}) — the run's verdict is unaffected.`);
}
process.exit(0);
