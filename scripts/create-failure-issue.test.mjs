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
//  1. THE SHAPE. Mutually exclusive verdicts — failed-merge / zero-tests /
//     partial / zero-verdicts / per-test. Announcing "tests failed" on a run that
//     executed ZERO points triage at specs instead of at the backend (#1012);
//     rendering a partial run as a normal day reports UNDER-COUNTED totals as the
//     day's numbers (#1058); and a run whose every result was a provider-health
//     skip must not render the per-test shape, because the specs never ran (#1456).
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
import { spawnSync } from "node:child_process";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { renderIssue, apiUrlFor, createIssue, CC_DEFAULT } from "./create-failure-issue.mjs";
import { makeTempDir } from "./lib/tmp-dir.mjs";

/** The script itself, for the handful of assertions that must go through `main()`. */
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "create-failure-issue.mjs");

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

test("a failed MERGE outranks `empty`, and never says nothing ran", () => {
  // The two are indistinguishable in the inputs on purpose — that is the defect. A
  // merge that fails leaves no report, so the integrity guard reports the run empty
  // AND unreadable, and every one of those flags is true here too. What separates
  // them is MERGE_OK, and if the shape did not lead, this issue would tell whoever
  // opens it at 06:00 to find out why nothing ran on a day everything did (#1726).
  const merged = renderIssue({ ...VM, mergeFailed: true, empty: true, unreadable: true, runErrors: "0" });
  assert.match(merged.title, /could not MERGE its shard reports/);
  assert.doesNotMatch(merged.title, /ZERO tests/, "every shard ran — the title is what gets scanned in the list");
  assert.match(merged.body, /The shards RAN — the MERGE failed/);
  assert.match(merged.body, /unread, not zero/, "the zeros above it are unread numbers, not a measurement");
  assert.doesNotMatch(merged.body, /find why nothing ran/, "that is the true sentence pointing at the wrong repair");
  assert.match(merged.body, /logs\/merge\.log/, "the VM lane names the log a human can open");
  assert.match(merged.body, /all-blobs/, "and the blobs, which can be merged again by hand");

  // On Actions the same shape names the step and the artifacts instead of paths.
  const onActions = renderIssue({ ...ACTIONS, mergeFailed: true, empty: true, unreadable: true });
  assert.match(onActions.body, /`Merge blob reports` step log/);

  // Absent means a working merge: the Actions lane never passes the flag, and its
  // empty-run body must not have moved.
  const stillEmpty = renderIssue({ ...ACTIONS, empty: true, unreadable: true });
  assert.match(stillEmpty.title, /executed ZERO tests/);
});

test("the four verdict shapes get four titles, and an empty run never claims tests failed", () => {
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

// --- the zero-verdicts shape (#1456) ----------------------------------------
// The second way a GREEN test job can mean no coverage. `empty` and `partial`
// describe a run that broke; this one describes a run that worked and proved
// nothing, which is why it needs a shape of its own rather than the per-test one.

test("a run whose every result was a provider skip gets its own title and shape", () => {
  const { title, body } = renderIssue({
    ...ACTIONS,
    uncovered: true,
    runTests: "3",
    coverageProviders: "openai",
    coverageSkips: "3",
    coverageHeadline: "daily-stable produced NO verdict at all: 3 test(s) skipped",
  });
  assert.match(title, /ZERO verdicts/);
  assert.doesNotMatch(title, /tests failed/, "no spec failed — none ran");
  assert.doesNotMatch(title, /dead provider/, "the title cannot diagnose either (#1801)");
  assert.doesNotMatch(title, /executed ZERO tests/, "tests DID execute — as skips");
  assert.match(body, /ZERO verdicts/);
  assert.match(body, /openai/);
  assert.match(body, /3 test\(s\)/);
  // The BODY's heading and its causal sentence, not only the title. Those are the two
  // strings #1801 changed for this shape, and both reverted silently under mutation:
  // the title pin two lines up does not reach them.
  assert.match(body, /recorded `inactive` by `collect-models`/, "the body quotes what was RECORDED");
  // A blocklist, and the reason it is one is worth stating: a literal `doesNotMatch`
  // on the old wording is a revert detector, not a pin. Measured — re-diagnosing the
  // heading as "a drained provider account skipped every test that ran", or appending
  // "— the account is out of credit" to the sentence, both left the whole lane green.
  // The positive `match` above is the load-bearing half; this catches the wordings
  // that have actually been written here, which is what a blocklist can honestly do.
  //
  // TWO SCOPES, because scoping all of it was a loosening. The triage paragraph
  // legitimately ENUMERATES the possible repairs — that enumeration IS what #1801
  // asked for — so the words it uses can only be refused before it. Every other
  // wording has no business anywhere in the body, and two of them were body-wide
  // before this test was rewritten: measured, putting "The provider could not serve a
  // call." in the triage paragraph passed while the assertion it replaced caught it.
  const headingAt = body.indexOf("### ⚠️ ZERO verdicts");
  const triageAt = body.indexOf("**Triage");
  // Both markers, not one: `slice(a, -1)` on a missing `**Triage` returns the whole
  // rest of the body, which passes a length check and then trips the blocklist on the
  // triage paragraph's own correct prose — failing for the wrong reason while the
  // guard written for this case stays silent.
  assert.ok(headingAt > -1, "the uncovered heading moved — this pin is scoped to it");
  assert.ok(triageAt > headingAt, "the triage paragraph moved — this pin is scoped to it");
  // The shape's OWN PROSE, which is what "may not diagnose" is a rule about — not the
  // whole body. The body also carries regions copied verbatim from inputs: the fenced
  // `coverageHeadline` and the liveness block above the heading. A body-wide rule
  // asserts something the code cannot honour, because the headline is a QUOTATION of
  // the provider's error: `lane-coverage-verdict` exists to put that text there, and
  // OpenAI's own 429 body reads "…please check your plan and billing details." — an
  // account that has drained twice here (#772/#1450). Asserting "nothing in this shape
  // may assert /billing/" over a quotation is the same over-claim #1801 is about, one
  // level up.
  const ownProse = (region) => region.replace(/```[\s\S]*?```/g, "");
  const statedFact = ownProse(body.slice(headingAt, triageAt));
  const triageParagraph = ownProse(body.slice(triageAt));
  // Vocabulary the enumeration needs, refused only in the statement of fact.
  for (const diagnosis of [/drained/i, /revoked/i, /spend cap/i]) {
    assert.doesNotMatch(
      statedFact,
      diagnosis,
      `the shape states what was recorded; it cannot diagnose ${diagnosis} from a skip (#1801)`,
    );
  }
  // Vocabulary that is a DIAGNOSIS wherever this shape writes it, including in the
  // paragraph a triager acts on.
  for (const diagnosis of [/dead provider/, /could not serve a call/, /out of credit/i, /billing/i]) {
    for (const [where, region] of [
      ["the statement of fact", statedFact],
      ["the triage paragraph", triageParagraph],
    ]) {
      assert.doesNotMatch(
        region,
        diagnosis,
        `${where} may not assert ${diagnosis} from a skip alone (#1801)`,
      );
    }
  }
  // Triage points at the REASON, not at a diagnosis (#1801). The same `inactive`
  // record is written for a key that was never imported as a Langflow global
  // variable (#1058), where the repair is the import and not the billing page.
  assert.match(body, /Triage the reason above, not the suite/);
  assert.match(body, /never imported the/, "the other repair must be named too");
  assert.doesNotMatch(
    body,
    /restore the key or the credit/,
    "that is a diagnosis this shape cannot make from a skip alone",
  );
  assert.match(body, /no per-test evidence to/);
  // The distinction from `empty` has to be in the body: the shards worked, and a
  // reader sent to the merge step would find nothing wrong with it.
  assert.match(body, /NOT the `empty` shape/);
});

test("the structural shapes outrank zero-verdicts, and it outranks the per-test one", () => {
  // A dead shard is what triage starts from even if the survivors were all skips.
  const partialWins = renderIssue({ ...ACTIONS, partial: true, uncovered: true, runTests: "3" });
  assert.match(partialWins.title, /PARTIAL/);
  const emptyWins = renderIssue({ ...ACTIONS, empty: true, uncovered: true });
  assert.match(emptyWins.title, /executed ZERO tests/);
  const mergeWins = renderIssue({ ...ACTIONS, mergeFailed: true, uncovered: true });
  assert.match(mergeWins.title, /could not MERGE/);

  // And it must beat the auto-removal summary: that section reads as a triaged day.
  const overAutoRemove = renderIssue({
    ...ACTIONS,
    uncovered: true,
    runTests: "3",
    arStatus: "ok",
    arSummary: "removed 3 tags",
  });
  assert.match(overAutoRemove.body, /ZERO verdicts/);
  assert.doesNotMatch(overAutoRemove.body, /removed 3 tags/);
});

test("an unset coverage verdict cannot pick the shape", () => {
  // Fail-closed belongs on the run's GATE, not on the issue's LABEL: an unknown
  // verdict fails the scheduled run (daily-stable.yml's last step) but must not
  // open an issue claiming a dead provider. Mislabelling a day is worse than not
  // labelling it.
  for (const verdict of [undefined, "", "covered", "degraded", "unreadable", "banana"]) {
    const { title } = renderIssue({ ...ACTIONS, uncovered: verdict === "uncovered" });
    assert.doesNotMatch(title, /ZERO verdicts/, `verdict ${JSON.stringify(verdict)} picked the shape`);
  }
});

test("the zero-verdicts body survives a run that reported no headline", () => {
  // `continue-on-error` on the guard means the outputs can be missing while the
  // final gate still fires. The shape must still render something usable.
  const { body } = renderIssue({ ...ACTIONS, uncovered: true, runTests: "3" });
  assert.match(body, /ZERO verdicts/);
  assert.doesNotMatch(body, /undefined/);
  assert.doesNotMatch(body, /Providers that went uncovered/, "no list when nothing was reported");
});

test("the daily fires the umbrella on the coverage DECISION and hands it the verdict", () => {
  // The wiring half, which no render test can reach: this step is gated on the
  // TEST job, and a coverage day is green there. Without the extra clause the
  // job's last step reddens the run and nothing opens an issue naming the cause —
  // a red day with no triage attached, which is #1176 in the direction that costs
  // the evidence rather than the gate.
  //
  // #1800 moved the clause from `verdict == 'uncovered'` to `fail_recommended`,
  // because `uncovered` requires ZERO executed tests and a full `@stable` run always
  // executes hundreds of non-LLM ones — so the clause could not fire on this lane at
  // all. What fires now is the reachable case: a complete report and NO usable
  // provider.
  const wf = readFileSync(join(REPO, ".github/workflows/daily-stable.yml"), "utf8");
  const step = wf.slice(wf.indexOf("- name: Create issue on failure"));
  const block = step.slice(0, step.indexOf("\n      - name:", 10));

  assert.match(
    block.slice(0, block.indexOf("\n", block.indexOf("if:"))),
    /steps\.coverage\.outputs\.fail_recommended == 'true'/,
    "a coverage day leaves the test job GREEN, so the umbrella needs its own clause",
  );
  // `!= 'success'`, not `== 'failure'`: a CANCELLED test job is not "came back green"
  // either, and the dry shape's body says that in so many words.
  assert.match(block, /TESTS_FAILED: \$\{\{ needs\.test\.result != 'success' \}\}/);
  for (const key of [
    "COVERAGE_VERDICT",
    "COVERAGE_HEADLINE",
    "COVERAGE_PROVIDERS",
    "COVERAGE_SKIPS",
    "COVERAGE_ACCOUNT",
    // Deleting this one line from the workflow left the whole lane green while
    // restoring the defect the previous round was opened for — the dry shape taking
    // the title on a day with real per-test failures (#1800 review).
    "TESTS_FAILED",
  ]) {
    assert.match(block, new RegExp(`${key}: `), `the umbrella cannot render the shape without ${key}`);
  }
});

// --- the dry-account shape (#1800) ------------------------------------------
// The reachable sibling of the zero-verdicts shape. `uncovered` needs ZERO executed
// tests, which a full `@stable` run never produces; a DRY account is what the daily
// can actually hit — hundreds of green non-LLM tests and no provider reachable at all.

test("a dry account gets its own title and does not claim nothing ran", () => {
  const { title, body } = renderIssue({
    ...ACTIONS,
    accountDry: true,
    runTests: "412",
    coverageProviders: "openai, anthropic, google",
    coverageSkips: "31",
    coverageHeadline: "daily-stable did not cover openai, anthropic, google",
  });

  assert.match(title, /NO usable provider/);
  assert.doesNotMatch(title, /ZERO verdicts/, "tests DID produce verdicts — just not LLM ones");
  assert.doesNotMatch(title, /tests failed/);
  assert.match(body, /no provider was\n?\s*recorded usable/i);
  assert.match(body, /The rest of the suite did run/);
  assert.match(body, /31 test\(s\)/);
  // Its own triage line, not the zero-verdicts one: `providers.json` is written by the
  // sweep AND by `globalSetup`'s credential degradation (#1058), so "restore the key
  // or the credit" would misdirect on half the states that produce this shape.
  assert.match(body, /provider configuration, not the suite/);
  assert.match(body, /whether the sweep imported them/);
  assert.match(body, /globalSetup/);
  // It must NOT borrow the zero-verdicts claims, which are false here.
  assert.doesNotMatch(body, /not one of them is a/);
  assert.doesNotMatch(body, /no per-test evidence to/);
  assert.doesNotMatch(body, /restore the key or the credit/);

  // And it may not DIAGNOSE either — the rule is the shape's, not the uncovered
  // shape's, and this is the one the daily can actually reach. It had no blocklist at
  // all: measured, injecting "the provider could not serve a call, the account is out
  // of credit; check billing" into this branch left the whole lane green.
  //
  // ONE region, not two: the four patterns below are refused everywhere this shape
  // writes prose, so the statement of fact and the triage paragraph need no separate
  // treatment. (The uncovered test splits them because three further patterns are its
  // enumeration's own vocabulary; this shape's enumeration word, `drained`, is simply
  // left out — see below.)
  //
  // BOUNDED at the auto-removal section, and the fenced blocks stripped, for the same
  // reason the uncovered scope excludes them: both are ECHOED INPUT. `arSummary`
  // renders each removed test's own error verbatim in a code SPAN, which the fence
  // strip does not touch, so a 429 body quoted there would trip `/billing/i` with a
  // message that is false of the code. That section is unreachable on this shape in
  // production (it needs `arStatus`, which needs a failed test job, which makes
  // `testsFailed` true and routes the day elsewhere) — but it is kept deliberately as
  // belt and braces, and an assertion must not depend on a branch staying dead.
  const dryHeadingAt = body.indexOf("### ⚠️ NO usable provider");
  const dryTriageAt = body.indexOf("**Triage");
  assert.ok(dryHeadingAt > -1, "the dry heading moved — this pin is scoped to it");
  assert.ok(dryTriageAt > dryHeadingAt, "the dry triage paragraph moved — this pin is scoped to it");
  const autoRemoveAt = body.indexOf("### `@stable` auto-removal", dryHeadingAt);
  const dryProse = body
    .slice(dryHeadingAt, autoRemoveAt > -1 ? autoRemoveAt : undefined)
    .replace(/```[\s\S]*?```/g, "");
  // `/drained/i` is deliberately NOT in this set: the dry shape's own prose ENUMERATES
  // the two causes ("a drained account and a sweep that never imported the keys both
  // produce it"), which is the same enumeration #1801 asked the uncovered shape for,
  // and refusing it here would refuse the fix. The four below are diagnosis wherever
  // they appear.
  for (const diagnosis of [/dead provider/, /could not serve a call/, /out of credit/i, /billing/i]) {
    assert.doesNotMatch(
      dryProse,
      diagnosis,
      `the dry shape reports what providers.json RECORDED; it cannot diagnose ${diagnosis} (#1801)`,
    );
  }
});

// Review finding: the account says nothing about whether tests ALSO failed, and this
// shape sits above the per-test one — so a real failure day with a dry account took a
// title that omitted the failures and a body that told the triager to ignore the
// suite, with no failure list and (when the mass-failure guard leaves `arStatus`
// empty, which is exactly the >5-failure outage day) no auto-removal block either.
// The shape is now gated on the test job being GREEN.
test("a dry account that ALSO had failures keeps the per-test shape", () => {
  const { title, body } = renderIssue({
    ...ACTIONS,
    accountDry: true,
    testsFailed: true,
    runTests: "412",
    coverageProviders: "openai",
    coverageSkips: "31",
    arStatus: "success",
    arSummary: "Removed @stable from 3 tests: a, b, c",
  });

  assert.match(title, /@stable tests failed/, "the failures own the title");
  assert.doesNotMatch(title, /NO usable provider/);
  assert.match(body, /### `@stable` auto-removal/);
  assert.match(body, /Removed @stable from 3 tests/);
  assert.doesNotMatch(body, /Triage this as provider configuration/);
});

// And the belt: if the auto-remove step somehow ran on a green test job, its summary
// is carried rather than dropped — the shape must never assert that no tag was
// touched while one was.
test("a dry account carries an unexpected auto-removal instead of hiding it", () => {
  const { title, body } = renderIssue({
    ...ACTIONS,
    accountDry: true,
    runTests: "412",
    arStatus: "success",
    arSummary: "Removed @stable from 3 tests: a, b, c",
  });
  assert.match(title, /NO usable provider/);
  assert.match(body, /Removed @stable from 3 tests/);
  assert.match(body, /Unexpected on this shape/);
});

test("the structural shapes outrank the dry-account one too", () => {
  for (const flag of ["partial", "empty", "mergeFailed"]) {
    const { title } = renderIssue({ ...ACTIONS, [flag]: true, accountDry: true, runTests: "3" });
    assert.doesNotMatch(title, /NO usable provider/, `${flag} must win the title`);
  }
  // And zero-verdicts outranks it: if nothing ran at all, that is the stronger fact.
  // `arStatus` is populated on purpose: without it this case could not see the
  // `!uncovered` guard on the auto-removal block, and dropping that guard survived the
  // whole lane — rendering "### `@stable` auto-removal" directly under the sentence
  // "No spec failed, no `@stable` tag was touched", which is the self-contradicting
  // body #1456 deliberately avoids.
  const bothCoverage = renderIssue({
    ...ACTIONS,
    uncovered: true,
    accountDry: true,
    runTests: "3",
    arStatus: "ok",
    arSummary: "Removed @stable from 2 tests",
  });
  assert.match(bothCoverage.title, /ZERO verdicts/);
  assert.doesNotMatch(bothCoverage.body, /auto-removal/);
  assert.doesNotMatch(bothCoverage.body, /Removed @stable/);
});

test("an alive account never selects the dry shape", () => {
  // The discriminator is the account state, not the presence of unverified providers:
  // a `degraded` day on a live account is an ordinary umbrella.
  const { title, body } = renderIssue({
    ...ACTIONS,
    accountDry: false,
    coverageProviders: "openai",
    coverageSkips: "3",
  });
  assert.match(title, /tests failed/);
  assert.doesNotMatch(body, /NO usable provider|no provider at all/);
});

test("a dry account on a FAILURE day keeps the per-test shape and still names the outage", () => {
  // The per-test shape wins the title — the fix for the dry shape hijacking a real
  // failure day — but the first version of that fix traded one information loss for
  // its mirror image: every coverage input is rendered inside the dry/uncovered
  // section, so routing the day elsewhere dropped the outage entirely. Measured on the
  // exact day the finding names: >5 failures, so the mass-failure guard leaves
  // `arStatus` empty and the body carried neither the failures nor the account.
  const { title, body } = renderIssue({
    ...ACTIONS,
    accountDry: true,
    testsFailed: true,
    runTests: "412",
    arStatus: "",
    coverageProviders: "openai, anthropic, google",
    coverageSkips: "31",
    coverageHeadline: "daily-stable did not cover openai, anthropic, google",
  });
  assert.match(title, /@stable tests failed on/);
  assert.doesNotMatch(title, /NO usable provider/);
  assert.match(body, /NO usable provider on this run/);
  assert.match(body, /openai, anthropic, google/);
  assert.match(body, /31 test\(s\)/);
  assert.match(body, /daily-stable did not cover openai/);
  // It leads the body for the same reason the liveness block does: the failures below
  // are plausibly collateral, and triage that starts from them starts wrong.
  assert.ok(
    body.indexOf("NO usable provider on this run") < body.indexOf("### Next steps"),
    "the outage must precede the per-test material",
  );
});

test("a LIVE account on a failure day carries no outage banner", () => {
  const { body } = renderIssue({
    ...ACTIONS,
    accountDry: false,
    testsFailed: true,
    runTests: "412",
    coverageProviders: "openai",
    coverageSkips: "3",
  });
  assert.doesNotMatch(body, /NO usable provider on this run/);
});

test("main() reads TESTS_FAILED as the string 'true', and only that", async () => {
  // The env→props mapping the render tests cannot reach: inverting this one comparison
  // left the whole lane green while restoring the hijack. Rendered through the real
  // process so the mapping, not a re-declaration of it, is what is asserted.
  // RUN_DIR, because `main()` always writes `$RUN_DIR/issue-body.md` and the default
  // is the CWD — a test that leaves a file in the repo root is its own defect.
  const runDir = makeTempDir("issue-body-");
  const base = {
    ...process.env,
    ISSUE_DRY_RUN: "1",
    RUN_DIR: runDir,
    COVERAGE_ACCOUNT: "dry",
    COVERAGE_VERDICT: "degraded",
    RUN_TESTS: "412",
    RUN_ID: "1",
    RUN_URL: "https://example.invalid/1",
    LANGFLOW_IMAGE: "nightly",
    AUTO_REMOVE_STATUS: "",
    LIVENESS_MD: "",
  };
  const failed = spawnSync(process.execPath, [SCRIPT], {
    encoding: "utf-8",
    env: { ...base, TESTS_FAILED: "true" },
  });
  const green = spawnSync(process.execPath, [SCRIPT], {
    encoding: "utf-8",
    env: { ...base, TESTS_FAILED: "false" },
  });
  assert.equal(failed.status, 0, failed.stderr);
  assert.equal(green.status, 0, green.stderr);
  assert.match(green.stdout, /NO usable provider on/);
  assert.doesNotMatch(failed.stdout, /@stable run had NO usable provider on/);
  assert.match(failed.stdout, /@stable tests failed on/);
});

test("the outage banner stays off the shapes that have no failures below it", () => {
  // Reachable on the #1058 day, not exotic: `Collect models` failing to import a key
  // aborts shards (`partial`) while the same sweep records every provider `inactive`
  // (`accountDry`). The banner says "read the failures below against it" and those
  // bodies say there are none — one of them four lines under its own "Triage the
  // abort first".
  for (const flag of ["empty", "partial", "mergeFailed", "uncovered"]) {
    const { body } = renderIssue({
      ...ACTIONS,
      [flag]: true,
      accountDry: true,
      testsFailed: true,
      runTests: "3",
      coverageProviders: "openai",
      coverageSkips: "12",
      coverageHeadline: "daily-stable did not cover openai",
    });
    assert.doesNotMatch(
      body,
      /NO usable provider on this run — read the failures below/,
      `${flag} has no per-test material for the banner to point at`,
    );
    // And the coverage material must not be rendered twice on the shape that owns it.
    if (flag === "uncovered") {
      assert.equal(body.match(/Providers that went uncovered/g)?.length, 1);
    }
    // ...but the FACT must survive where nothing else reports it. On `empty` and
    // `mergeFailed` the run's own `::error::` needs a provider-health skip an aborted
    // run never produced, and the summary block is empty on a `covered` verdict, so
    // dropping it here dropped it everywhere.
    if (flag === "empty" || flag === "mergeFailed") {
      assert.match(body, /no provider was \*\*recorded\*\* usable on this run/);
    }
    // The CAUSE hint is `empty`'s alone. #1058 aborts the shards, which is a cause
    // `mergeFailed` demonstrably does not have — its own text says every shard
    // finished and no spec is implicated, so the hint would contradict it three lines
    // down, which is the defect this whole PR keeps removing from other messages.
    if (flag === "mergeFailed") {
      assert.doesNotMatch(body, /can abort the shards/);
    }
    if (flag === "empty") {
      assert.match(body, /can abort the shards in the same run/);
    }
  }

  // ...and the note must be ABSENT on a live account, or it becomes a false claim on
  // every aborted run — the #1012 class it exists to satisfy, inverted.
  for (const flag of ["empty", "mergeFailed"]) {
    const { body } = renderIssue({ ...ACTIONS, [flag]: true, accountDry: false, runTests: "3" });
    assert.doesNotMatch(body, /no provider was \*\*recorded\*\* usable/, `${flag} on a live account`);
  }
});

test("the dry shape never renders its own material twice", () => {
  // Dropping `testsFailed` from the banner gate makes it fire on the dry shape itself,
  // which already renders every one of these lines — measured: "NO usable provider"
  // and "Providers that went uncovered" both appeared twice.
  const { body } = renderIssue({
    ...ACTIONS,
    accountDry: true,
    testsFailed: false,
    runTests: "412",
    coverageProviders: "openai, anthropic, google",
    coverageSkips: "31",
    coverageHeadline: "daily-stable did not cover openai",
  });
  assert.equal(body.match(/NO usable provider/g)?.length, 1);
  assert.equal(body.match(/Providers that went uncovered/g)?.length, 1);
  assert.doesNotMatch(body, /read the failures below/);
});
