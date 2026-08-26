#!/usr/bin/env node
// Post the daily's verdict to Slack when it is bad.
//
// ## Why a script and not a curl in the runner
//
// Same reason `create-failure-issue.mjs` is a script: the message is a DECISION,
// not a template. A run can be bad in three mutually exclusive ways, and saying
// the wrong one is worse than saying nothing —
//
//   - ZERO tests executed: an infra abort. A message reading "3 tests failed"
//     when nothing ran points triage at specs instead of at the backend (#1012).
//   - PARTIAL: a shard died before running its slice, so the totals are
//     UNDER-COUNTED. Reporting them as the day's numbers reads as an improvement
//     when it is a loss (#1058).
//   - Per-test failures: the normal red day, and the only one where a failure
//     list means anything.
//
// It deliberately mirrors the three shapes of the GitHub issue: the Slack message
// and the issue are two views of one verdict, and they must never disagree.
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
//   SLACK_TIMEOUT_MS    per-request deadline (default 15000)
//   PAYLOAD_JSON        path to the run payload (default: payload.json)
//   RUN_EMPTY / RUN_PARTIAL / RUN_UNREADABLE / RUN_ERRORS / RUN_TESTS / RUN_FIRST_ERROR
//   LIVENESS_MEASURED / LIVENESS_WEDGED / LIVENESS_OUTAGES / LIVENESS_DOWN_SECONDS
//   ISSUE_URL           the triage issue this run opened, if any
//   REPORT_URL          where the Playwright report lives
//   RUN_ID, VM_HOSTNAME
//   SLACK_DRY_RUN=1     render and print the payload, post nothing
//   SLACK_FORCE=1       post even when the run reported nothing bad (wiring test)
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
if (existsSync(payloadPath)) {
  try {
    run = JSON.parse(readFileSync(payloadPath, "utf8"));
  } catch (e) {
    console.error(`[slack] ${payloadPath} is unreadable (${e.message}) — reporting what the guards saw instead.`);
  }
} else {
  console.error(`[slack] no ${payloadPath} — reporting what the guards saw instead.`);
}

const empty = env.RUN_EMPTY === "true";
const partial = env.RUN_PARTIAL === "true";
const unreadable = env.RUN_UNREADABLE === "true";
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
// The three shapes — same order and same reasoning as create-failure-issue.mjs
// ---------------------------------------------------------------------------

const shape = empty ? "empty" : partial ? "partial" : "failures";

// A GREEN day is not one of the three shapes, and this script has to say so
// itself. Its header claims it "fires on the SAME condition as the triage issue",
// but that condition lives in the caller — and the caller is the runner, the one
// piece still being written. Without this, a run that is neither empty nor partial
// and failed nothing renders "🔴 Daily @stable failed — 0 test(s)": the #1012
// defect pointed the other way, announcing a verdict the report does not support.
// The gate belongs HERE because here is where the verdict is decided; a caller
// that forgets it is a caller, and there will be more than one.
//
// Deliberately narrow: it fires only when EVERY signal agrees the day was clean —
// not empty, not partial, a failed count of exactly zero, and an empty failure
// list. An absent or unreadable payload leaves `totals.failed` undefined, which is
// UNKNOWN rather than zero, and an unknown verdict must still be announced (#1012
// again). SLACK_FORCE=1 posts anyway, which is how the webhook wiring gets tested
// against a green run without editing this file.
const failedCount = totals.failed;
const nothingFailed =
  shape === "failures" &&
  (failedCount === 0 || failedCount === "0") &&
  failures.length === 0;

if (nothingFailed && env.SLACK_FORCE !== "1") {
  console.log(
    "[slack] the run reported no failures and neither the empty nor the partial verdict — nothing to announce. " +
      "(SLACK_FORCE=1 posts anyway, e.g. to test the webhook wiring.)",
  );
  process.exit(0);
}

const headline = {
  empty: `⚠️ Daily @stable executed ZERO tests — ${date}`,
  partial: `⚠️ Daily @stable was PARTIAL — a shard never ran — ${date}`,
  failures: `🔴 Daily @stable failed — ${totals.failed ?? failures.length} test(s) — ${date}`,
}[shape];

const diagnosis = {
  empty: [
    unreadable
      ? "*The merged report was missing or unparseable* — the run produced no readable result at all."
      : `*The merged report carries no test results at all* (${reportErrors} top-level report error(s)) — the shards aborted before the first test.`,
    "No spec failed and no `@stable` tag was touched, so there is *no per-test evidence to triage*.",
    "*Triage this as infrastructure*: find why nothing ran, not which test broke.",
  ].join("\n"),
  partial: [
    `*${testsTotal} test result(s) but ${reportErrors} top-level report error(s).*`,
    "A shard aborted before running the tests assigned to it, so the totals are *UNDER-COUNTED* — the dead shard's specs are neither passed nor failed, they never ran.",
    "`@stable` auto-removal and the duration refresh were both skipped. *Triage the abort first* — a large drop against the last green run is the abort, not a fix.",
  ].join("\n"),
  failures: null,
}[shape];

// ---------------------------------------------------------------------------
// The message, as text — computed ONCE and shared by both transports, so the
// Workflow Builder message and the Block Kit message can never drift apart.
// ---------------------------------------------------------------------------

const wedged = env.LIVENESS_MEASURED === "true" && env.LIVENESS_WEDGED === "true";
// The backend-outage verdict LEADS the per-test material when it fired: the cause
// has to be read before the collateral, or triage starts from the wrong specs
// (#1030). Gated on `measured` — `wedged` is also "false" when nothing was probed.
const outageNote = wedged
  ? `⚡ *The backend went down mid-run* — ${env.LIVENESS_OUTAGES || "?"} outage(s), ` +
    `${env.LIVENESS_DOWN_SECONDS || "?"}s unreachable in total.\n` +
    "Specs that failed inside those windows are *collateral, not per-test failures*. Read the outage first."
  : "";

const failureList = () => {
  if (!failures.length) return "";
  const shown = failures.slice(0, MAX_FAILURES_LISTED);
  const lines = shown.map((f) => {
    const file = String(f.file || "").split("/").pop() || f.file || "?";
    return `• \`${file}\` — ${truncate(f.test || "?", 120)}\n   _${truncate(f.error_signature || "unknown", SIGNATURE_MAX)}_`;
  });
  // NAME what was elided rather than silently cutting: a list that stops at 10
  // reads as "10 failures" when it was 40.
  if (failures.length > shown.length) {
    lines.push(`\n_… and ${failures.length - shown.length} more not listed here — see the report._`);
  }
  return lines.join("\n");
};

const totalsLine =
  shape === "failures"
    ? `*${totals.failed ?? 0} failed* · ${totals.flaky ?? 0} flaky · ${totals.passed ?? 0} passed · ${totals.skipped ?? 0} skipped`
    : "";

// Truncate the quoted cause BEFORE it is fenced, not after. The body as a whole is
// capped at SECTION_MAX, and a cut that lands inside the fence leaves it unclosed
// and elides the diagnosis with nothing but an ellipsis to show for it — a silent
// cap, which is the thing this file refuses to do for the failure list two blocks
// up. check-run-integrity.mjs already caps `first_error` to a single line, so this
// is a floor under an assumption about another script, not a fix for a live defect.
const ERROR_MAX = 600;
const errorBlock = firstError ? "```\n" + truncate(firstError, ERROR_MAX) + "\n```" : "";

const body = [
  `*Langflow* \`${truncate(version || image, 200)}\`  ·  *Run* \`${truncate(runId, 200)}\` on ${host}`,
  totalsLine,
  outageNote,
  diagnosis || "",
  diagnosis ? errorBlock : failureList(),
]
  .filter(Boolean)
  .join("\n\n");

const links = [];
if (env.ISSUE_URL) links.push(`<${env.ISSUE_URL}|Triage issue>`);
if (env.REPORT_URL) {
  // A `file://` report is not a link anyone can click from Slack — say where it
  // is instead of rendering a link that silently does nothing.
  links.push(
    env.REPORT_URL.startsWith("file://")
      ? `Report: \`${env.REPORT_URL.replace(/^file:\/\//, "")}\` on ${host}`
      : `<${env.REPORT_URL}|Playwright report>`,
  );
}
const linksText = links.join("  ·  ");

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

// Keyed on the PATH segment, not on the host. `/triggers/` vs `/services/` is what
// actually distinguishes the two, and requiring `hooks.slack.com` as well makes the
// detection fail silently behind a proxy or a relay — falling back to Block Kit,
// which a Workflow Builder trigger accepts with a 200 and renders as nothing.
const mode =
  env.SLACK_MODE || (/\/triggers\//.test(webhook) ? "workflow" : "blockkit");

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
