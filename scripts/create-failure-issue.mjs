#!/usr/bin/env node
// Open the daily-failure issue for a run of the @stable suite — the single home of
// the decision logic that `.github/workflows/daily-stable.yml` ("Create issue on
// failure") used to carry inline as an `actions/github-script` block.
//
// ## Why it is a script and not `gh issue create` in bash
//
// The body is DECISION LOGIC, not a template: three mutually exclusive shapes
// (zero tests / partial / per-test), each with its own title, its own triage
// instruction, and its own reason for existing. Reproducing that with bash
// heredocs is where the shapes quietly drift apart — and the shape is the whole
// point. An empty run rendered as a per-test day reads like a clean triage on a
// report that saw nothing (#1012); a partial run rendered as a normal day reports
// UNDER-COUNTED totals as if they were the day's numbers (#1058).
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
 * three shapes and the two lanes are testable without creating anything. The one
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
  runErrors = "0",
  firstError = "",
  runTests = "0",
  liveness = "",
  cc = CC_DEFAULT,
} = {}) {
  // Which lane rendered this. `RUN_URL` is the only honest discriminator: it is
  // the one input a VM run cannot have and an Actions run always does.
  const onActions = Boolean(runUrl);

  // Three shapes, most specific first.
  // 1. ZERO tests executed (#1012): there is no per-test evidence to triage, so
  //    say so instead of rendering the auto-removal line, which reads as a clean
  //    triage on an empty report.
  // 2. The auto-remove step acted — show what it did.
  // 3. Neither (it errored, or a guard skipped it) — manual triage.
  const section = empty
    ? [
        "### ⚠️ ZERO tests executed — infra abort, not a per-test failure",
        "",
        unreadable
          ? onActions
            ? "The merged report was **missing or unparseable** — the run produced no readable result at all. Suspect the `Merge blob reports` step and the per-shard blob artifacts first."
            : "The merged report was **missing or unparseable** — the run produced no readable result at all. Suspect the merge step and the per-shard blob files first."
          : `The merged report carries **no test results at all** (${runErrors} top-level report error(s)) — the shards aborted before the first test.`,
        "No spec failed and no `@stable` tag was touched, so there is **no per-test evidence to triage**.",
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

  // The title is what gets scanned in the issue list, so an empty run must not
  // claim that tests failed — none ran.
  const title = empty
    ? `[Daily Failure] @stable run executed ZERO tests on ${today} (${image})`
    : partial
      ? `[Daily Failure] @stable run was PARTIAL — a shard never ran on ${today} (${image})`
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
    runErrors: env.RUN_ERRORS || "0",
    firstError: env.RUN_FIRST_ERROR || "",
    runTests: env.RUN_TESTS || "0",
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
