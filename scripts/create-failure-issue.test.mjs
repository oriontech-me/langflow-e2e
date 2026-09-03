#!/usr/bin/env node
// Guards for `scripts/create-failure-issue.mjs`.
//
// This script's one irreversible act is opening a GitHub issue, and until it was
// split into a pure `renderIssue()` there was no way to exercise it that did not
// perform that act — which is why it shipped untested, and why reviewing it opened
// a real `[Daily Failure]` issue on this repo by accident. The decision is now
// reachable without the consequence, and these tests are what that split is for.
//
// Three things are pinned:
//
//  1. THE SHAPE. Three mutually exclusive verdicts — zero-tests / partial /
//     per-test. Announcing "tests failed" on a run that executed ZERO points
//     triage at specs instead of at the backend (#1012); rendering a partial run
//     as a normal day reports UNDER-COUNTED totals as the day's numbers (#1058).
//  2. THE ACTIONS BODY IS UNCHANGED. The workflow now calls this script instead of
//     rendering its own copy, so the body it produces on the Actions lane is
//     asserted byte-for-byte against what the inline `actions/github-script` block
//     emitted. A "port" that quietly reworded the umbrella is not a port.
//  3. THE INLINE COPY IS GONE. Two copies of one decision is the shape #1045
//     names, so the workflow is checked for the absence of the block — keyed on
//     the marker the copy cannot exist without, not on `gh`/`issues.create`, which
//     other steps legitimately use.
//
// Run: npm run test:scripts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { renderIssue, apiUrlFor, createIssue, CC_DEFAULT } from "./create-failure-issue.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");

const ACTIONS = {
  today: "2026-08-26",
  image: "langflowai/langflow-nightly:latest",
  runId: "30809091241",
  runUrl: "https://github.com/oriontech-me/langflow-e2e/actions/runs/30809091241",
};
const VM = {
  today: "2026-08-26",
  image: "langflowai/langflow-nightly:latest",
  runId: "20260826T080000Z",
  runDir: "/root/e2e-qa/runs/20260826T080000Z",
  hostname: "qa-runner.internal.example",
};

test("the Actions body is byte-for-byte what the inline workflow block rendered", () => {
  const { title, body } = renderIssue(ACTIONS);

  assert.equal(title, "[Daily Failure] @stable tests failed on 2026-08-26 (langflowai/langflow-nightly:latest)");
  assert.equal(
    body,
    [
      "## Daily @stable E2E Failure",
      "",
      "- **Date:** 2026-08-26",
      "- **Langflow version:** `langflowai/langflow-nightly:latest`",
      "- **Run:** [30809091241](https://github.com/oriontech-me/langflow-e2e/actions/runs/30809091241)",
      "",
      "### Next steps",
      "1. Open the Playwright report in the artifact from the run above",
      "2. Determine if the failure is a test bug or a Langflow regression",
      "3. If the test is incorrect or outdated: remove the `@stable` tag from the test and open a fix PR",
      "4. If it is a Langflow regression: flag it to the team and monitor upstream",
      "",
      `/cc ${CC_DEFAULT}`,
    ].join("\n"),
  );
});

test("the three verdict shapes get three titles, and an empty run never claims tests failed", () => {
  const empty = renderIssue({ ...ACTIONS, empty: true, runErrors: "4" });
  assert.match(empty.title, /executed ZERO tests/);
  assert.doesNotMatch(empty.title, /tests failed/, "an empty run must not claim tests failed");
  assert.match(empty.body, /infra abort, not a per-test failure/);
  assert.match(empty.body, /no per-test evidence to triage/);

  const partial = renderIssue({ ...ACTIONS, partial: true, runTests: "180", runErrors: "2" });
  assert.match(partial.title, /was PARTIAL — a shard never ran/);
  assert.match(partial.body, /UNDER-COUNTED/, "a partial run must say its totals are under-counted");
  assert.match(partial.body, /\*\*180 test result\(s\)\*\*/);

  const failures = renderIssue(ACTIONS);
  assert.match(failures.title, /@stable tests failed/);
});

test("`empty` outranks `partial`, and both outrank the auto-removal summary", () => {
  // All three flags at once is not hypothetical: a report can be empty AND carry
  // an auto-removal status left over from a previous step's output. Rendering the
  // auto-removal line on an empty report reads as a clean triage on a report that
  // saw nothing — the #1012 failure exactly.
  const all = renderIssue({ ...ACTIONS, empty: true, partial: true, arStatus: "ok", arSummary: "removed 3 tags" });
  assert.match(all.title, /executed ZERO tests/);
  assert.doesNotMatch(all.body, /removed 3 tags/);

  const partialWins = renderIssue({ ...ACTIONS, partial: true, arStatus: "ok", arSummary: "removed 3 tags" });
  assert.match(partialWins.title, /PARTIAL/);
  assert.doesNotMatch(partialWins.body, /removed 3 tags/);

  const ar = renderIssue({ ...ACTIONS, arStatus: "ok", arSummary: "removed 3 tags" });
  assert.match(ar.body, /### `@stable` auto-removal/);
  assert.match(ar.body, /removed 3 tags/);
  assert.doesNotMatch(ar.body, /### Next steps/);
});

test("the VM lane names the run directory and the host instead of a dead run link", () => {
  const { body } = renderIssue(VM);
  assert.doesNotMatch(body, /actions\/runs/, "there is no Actions run to link on a VM");
  assert.match(body, /- \*\*Evidence:\*\* `\/root\/e2e-qa\/runs\/20260826T080000Z` on `qa-runner\.internal\.example`/);
  assert.match(body, /Open the Playwright report on the VM: `\/root\/e2e-qa\/runs\/20260826T080000Z\/playwright-report\/index\.html`/);

  // The unreadable-empty branch points at artifacts on Actions and at files on a VM
  // — a reader told to "check the artifacts" on a machine that uploads none is
  // being sent nowhere.
  const vmEmpty = renderIssue({ ...VM, empty: true, unreadable: true });
  assert.match(vmEmpty.body, /per-shard blob files under `all-blobs\/`/);
  const actionsEmpty = renderIssue({ ...ACTIONS, empty: true, unreadable: true });
  assert.match(actionsEmpty.body, /per-shard blob artifacts/);
});

test("the liveness verdict leads the body, ahead of the per-test material (#1030)", () => {
  const { body } = renderIssue({ ...ACTIONS, liveness: "### Backend liveness\nThe backend went down." });
  assert.ok(
    body.indexOf("Backend liveness") < body.indexOf("### Next steps"),
    "the cause has to be read before the collateral",
  );
});

test("ISSUE_CC='' opens the issue with no /cc line at all", () => {
  assert.doesNotMatch(renderIssue({ ...ACTIONS, cc: "" }).body, /\/cc/);
  assert.doesNotMatch(renderIssue({ ...ACTIONS, cc: "   " }).body, /\/cc/, "whitespace is not a roster");
  assert.match(renderIssue(ACTIONS).body, /\/cc @Victor-w-Madeira/);
});

test("the REST endpoint follows the host — github.com vs a GitHub Enterprise instance", () => {
  assert.equal(apiUrlFor("github.com", "o/r"), "https://api.github.com/repos/o/r/issues");
  assert.equal(apiUrlFor("", "o/r"), "https://api.github.com/repos/o/r/issues");
  assert.equal(apiUrlFor("ghe.internal.example", "o/r"), "https://ghe.internal.example/api/v3/repos/o/r/issues");
});

test("a dry run creates nothing and says so", async () => {
  const r = await createIssue({ title: "t", body: "b", repo: "o/r", dryRun: true });
  assert.deepEqual(r, { ok: true, url: "", how: "dry-run", reason: "" });
});

test("createIssue reports a transport failure instead of throwing", async () => {
  // The caller decides whether this is fatal (ISSUE_STRICT), so it must always get
  // a verdict back — a throw here would take out the body-on-disk fallback too.
  //
  // PATH is emptied for the duration so the `gh` fallback resolves to nothing: the
  // test must be offline and deterministic, and must never reach a real `gh` that
  // could create a real issue — which is how this script got reviewed into opening
  // one (#1616).
  const path = process.env.PATH;
  process.env.PATH = "";
  let r;
  try {
    r = await createIssue({
      title: "t", body: "b", repo: "o/r",
      host: "127.0.0.1:1", token: "not-a-real-token",
    });
  } finally {
    process.env.PATH = path;
  }
  assert.equal(r.ok, false);
  assert.ok(r.reason, "the reason must name what went wrong");

  // A token that is PRESENT is not a token that WORKS. On a VM where a human is
  // logged into `gh`, a stale GITHUB_TOKEN in the environment must not consume the
  // only attempt at creating the issue — so a failed API call still tries `gh`.
  assert.equal(r.how, "api+gh", "a failed token path must still fall through to gh");
  // And the report must carry BOTH causes: "gh not runnable" alone points triage at
  // a missing CLI on a lane (the daily's container) that never wanted one.
  assert.match(r.reason, /^api: /, "the API failure is the one that explains the lane");
  assert.match(r.reason, /gh: /, "and the fallback's own failure is named too");
});

test("daily-stable.yml calls the script and no longer carries its own copy", () => {
  const wf = readFileSync(join(REPO, ".github/workflows/daily-stable.yml"), "utf8");

  assert.match(wf, /node scripts\/create-failure-issue\.mjs/, "the workflow must call the script");
  // Keyed on the inline copy's own marker — the section array it cannot be written
  // without — rather than on `issues.create`, so this fails on a resurrected copy
  // and not on some other step that legitimately opens an issue (#1045).
  assert.doesNotMatch(
    wf,
    /\[Daily Failure\] @stable/,
    "the issue title is rendered by the script; a copy in the workflow is how the shapes diverge",
  );
  // The two inputs that decide which lane the script thinks it is on, and whether a
  // failed creation is loud. Losing either is silent: no RUN_URL renders the
  // Actions umbrella with a VM path in it, and no ISSUE_STRICT turns a missing
  // umbrella into a warning nobody reads.
  assert.match(wf, /RUN_URL:/, "RUN_URL is what selects the Actions lane wording");
  assert.match(wf, /ISSUE_STRICT: *"1"/, "on Actions a failed creation must fail the step");
});

// The step being CORRECT is worth nothing if it is never reached, and for a total
// shard abort it was not (#1176). A step `if:` with no status function gets an
// implicit `success()` over every preceding step — and a total abort is guaranteed to
// fail `Merge blob reports`, since there are no blobs to merge. So the one failure
// mode with no per-test evidence to fall back on was the one that opened no issue,
// while everything downstream (the ZERO-tests title and body, tested above) already
// existed and simply could not be run.
//
// This is a structural assertion, which #1226 established cannot pin a behaviour — a
// workflow `if:` has no other reachable surface from a unit test, so it is scoped to
// exactly what it can prove: that the guard is still spelled there.
test("#1176 the umbrella step survives an earlier failed step in the merge job", () => {
  const wf = readFileSync(join(REPO, ".github/workflows/daily-stable.yml"), "utf8");

  const step = wf.slice(wf.indexOf("- name: Create issue on failure"));
  const ifLine = step.slice(0, step.indexOf("\n", step.indexOf("if:")));
  assert.match(
    ifLine,
    /if: *always\(\)/,
    "without a status function the implicit success() skips the umbrella on the one day it matters",
  );
  // The empty-report clause is what #1012 added for a run that goes green with zero
  // tests. It is only reachable because of the guard above, so the two are pinned
  // together rather than separately.
  assert.match(ifLine, /runguard\.outputs\.empty == 'true'/);
  assert.match(ifLine, /github\.event_name == 'schedule'/, "still scheduled-only");
});
