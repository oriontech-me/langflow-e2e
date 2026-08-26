#!/usr/bin/env node
// Open the daily-failure issue for a VM run — the port of the `actions/github-script`
// block in `.github/workflows/daily-stable.yml` ("Create issue on failure").
//
// ## Why it is a script and not `gh issue create` in bash
//
// The workflow's body is DECISION LOGIC, not a template: three mutually exclusive
// shapes (zero tests / partial / per-test), each with its own title, its own
// triage instruction, and its own reason for existing. Reproducing that with
// bash heredocs is where the shapes quietly drift apart — and the shape is the
// whole point. An empty run rendered as a per-test day reads like a clean triage
// on a report that saw nothing (#1012); a partial run rendered as a normal day
// reports UNDER-COUNTED totals as if they were the day's numbers (#1058).
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
//   IMAGE, RUN_ID, RUN_DIR
//   AUTO_REMOVE_STATUS, AUTO_REMOVE_SUMMARY
//   RUN_EMPTY, RUN_UNREADABLE, RUN_PARTIAL, RUN_ERRORS, RUN_FIRST_ERROR, RUN_TESTS
//   LIVENESS_MD
//   ISSUE_HOST (default github.com), ISSUE_REPO (default oriontech-me/langflow-e2e)
//   ISSUE_CC   (default the QA roster; set to "" to open the issue without a /cc)
//
// Always writes the rendered body to $RUN_DIR/issue-body.md, then creates the
// issue when `gh` is available. The file is the fallback: a missing token must
// leave the triage material on disk, not lose it.

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const env = process.env;
const today = new Date().toISOString().split("T")[0];
const image = env.IMAGE || "";
const runId = env.RUN_ID || "";
const runDir = env.RUN_DIR || ".";

const arStatus = env.AUTO_REMOVE_STATUS || "";
const arSummary = env.AUTO_REMOVE_SUMMARY || "";
const empty = env.RUN_EMPTY === "true";
const unreadable = env.RUN_UNREADABLE === "true";
const partial = env.RUN_PARTIAL === "true";
const runErrors = env.RUN_ERRORS || "0";
const firstError = env.RUN_FIRST_ERROR || "";
const runTests = env.RUN_TESTS || "0";

// Three shapes, most specific first — identical to the workflow.
const section = empty
  ? [
      "### ⚠️ ZERO tests executed — infra abort, not a per-test failure",
      "",
      unreadable
        ? "The merged report was **missing or unparseable** — the run produced no readable result at all. Suspect the merge step and the per-shard blob files first."
        : `The merged report carries **no test results at all** (${runErrors} top-level report error(s)) — the shards aborted before the first test.`,
      "No spec failed and no `@stable` tag was touched, so there is **no per-test evidence to triage**.",
      ...(firstError ? ["", "```", firstError, "```"] : []),
      "",
      "**Triage this as infrastructure**: find why nothing ran, not which test broke.",
      ...(unreadable
        ? ["Start from the merge step log and the per-shard blob files under `all-blobs/`."]
        : [
            "The shard logs (`logs/shard-N.log`) and the Langflow container logs are the evidence. This does",
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
          `1. Open the Playwright report on the VM: \`${join(runDir, "playwright-report/index.html")}\``,
          "2. Determine if the failure is a test bug or a Langflow regression",
          "3. If the test is incorrect or outdated: remove the `@stable` tag from the test and open a fix PR",
          "4. If it is a Langflow regression: flag it to the team and monitor upstream",
        ];

// Who gets pinged. Configurable rather than hardcoded: the handles are a team
// roster, which changes independently of this file, and a run that must NOT ping
// (a wiring test, a lane whose failures are already watched elsewhere) needs a way
// to say so that is not "edit the script". Empty = no /cc line at all.
const CC_DEFAULT = "@Victor-w-Madeira @daniellicnerski1 @rafaelgiln";
const cc = (env.ISSUE_CC === undefined ? CC_DEFAULT : env.ISSUE_CC).trim();

const liveness = (env.LIVENESS_MD || "").trim();
const livenessSection = liveness ? [liveness, ""] : [];

const title = empty
  ? `[Daily Failure] @stable run executed ZERO tests on ${today} (${image})`
  : partial
    ? `[Daily Failure] @stable run was PARTIAL — a shard never ran on ${today} (${image})`
    : `[Daily Failure] @stable tests failed on ${today} (${image})`;

// The run block replaces the workflow's Actions run link: on a VM the evidence is
// a path, and naming the host is what lets a reader find it at all.
const body = [
  "## Daily @stable E2E Failure",
  "",
  `- **Date:** ${today}`,
  `- **Langflow version:** \`${image}\``,
  `- **Run:** \`${runId}\` — executed on the QA VM (no GitHub Actions run to link)`,
  `- **Evidence:** \`${runDir}\` on \`${env.VM_HOSTNAME || process.env.HOSTNAME || "the QA VM"}\``,
  "",
  ...livenessSection,
  ...section,
  ...(cc ? ["", `/cc ${cc}`] : []),
].join("\n");

mkdirSync(runDir, { recursive: true });
const bodyPath = join(runDir, "issue-body.md");
writeFileSync(bodyPath, `${title}\n\n${body}\n`, "utf8");
console.log(`[issue] body written to ${bodyPath}`);

const host = env.ISSUE_HOST || "github.com";
const repo = env.ISSUE_REPO || "oriontech-me/langflow-e2e";

const gh = spawnSync(
  "gh",
  ["issue", "create", "--repo", repo, "--title", title, "--body", body,
   "--label", "daily-failure", "--label", "needs-triage"],
  { env: { ...process.env, GH_HOST: host }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
);

if (gh.error) {
  console.error(`::warning::gh not runnable (${gh.error.message}) — issue NOT created. Body kept at ${bodyPath}.`);
  process.exit(0);
}
if (gh.status !== 0) {
  console.error(`::warning::gh issue create failed (exit ${gh.status}) — issue NOT created. Body kept at ${bodyPath}.`);
  console.error(gh.stderr || "");
  process.exit(0);
}
const url = (gh.stdout || "").trim();
console.log(`[issue] created on ${host}/${repo}: ${url}`);
// Hand the URL to whatever runs next (the Slack notifier links it, so the two
// views of one verdict point at each other instead of being found separately).
if (url) writeFileSync(join(runDir, "issue-url.txt"), url, "utf8");
