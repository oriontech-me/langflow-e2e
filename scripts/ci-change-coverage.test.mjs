// Unit tests for the CI-only change classifier (issue #1159).
//
// Two halves. The synthetic ones pin the decision rules; the ones against the
// REAL repo pin the two things that make the canary worth having — that its specs
// still exist and still qualify, and that `pr-validation.yml` actually consumes
// the verdict. A canary wired to a renamed spec, or a verdict nothing reads,
// would restore the silent `skipping` this issue is about.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

import {
  CANARY_SPECS,
  PR_LANE,
  buildCiReferences,
  classifyCiChange,
  dispatchAdvice,
  parseWorkflowStates,
  readWorkflowTriggers,
  workflowDispatchability,
} from "./ci-change-coverage.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

// A miniature .github: the PR lane uses one action, another lane uses a second.
// Each workflow carries a real `on:` block, because since #1609 the verdict's
// wording depends on it — a fixture without one would exercise only the
// "triggers unreadable" branch and pin none of the advice.
const FIXTURE = {
  workflows: new Map([
    [
      PR_LANE,
      `on:
  pull_request:
    branches: [main]

steps:
  - uses: ./.github/actions/setup-playwright
  - uses: ./.github/actions/wait-for-backend
  - run: node scripts/impacted-specs-by-import.mjs --stdin`,
    ],
    [
      ".github/workflows/daily-stable.yml",
      `on:
  schedule:
    - cron: "0 8 * * 1-5"
  workflow_dispatch:

steps:
  - uses: ./.github/actions/auto-remove-stable
  - run: node scripts/partition-shards.mjs matrix
  - uses: ./.github/actions/wait-for-backend`,
    ],
    // The #1609 case: a lane that runs a script, and that no branch can dispatch.
    [
      ".github/workflows/update-coverage-summary.yml",
      `on:
  push:
    branches: [main]

steps:
  - run: npx ts-node scripts/coverage-summary.ts`,
    ],
    // A workflow whose triggers this cannot read at all.
    [
      ".github/workflows/opaque.yml",
      `steps:
  - run: node scripts/opaque-only.mjs`,
    ],
  ]),
  actions: new Map([
    ["setup-playwright", "runs:\n  steps:\n    - run: npx playwright install"],
    ["wait-for-backend", "runs:\n  steps:\n    - run: node scripts/wait-for-backend.mjs"],
    ["auto-remove-stable", "runs:\n  steps:\n    - run: npx ts-node scripts/remove-stable-from-failures.ts"],
  ]),
};

const refs = buildCiReferences(FIXTURE);
const classify = (...changed) => classifyCiChange({ changed, refs });

// ── Reference graph ─────────────────────────────────────────────────────────

test("a workflow reaches a script THROUGH the action it uses", () => {
  // The indirection #1045 shipped: `wait-for-backend.mjs` is named nowhere in
  // pr-validation.yml, only inside the action. A direct-refs-only graph would
  // have classified that change as `none` and skipped the lane again.
  assert.ok(refs.workflowScripts.get(PR_LANE).has("scripts/wait-for-backend.mjs"));
  assert.ok(refs.workflowScripts.get(PR_LANE).has("scripts/impacted-specs-by-import.mjs"));
  assert.ok(!refs.workflowScripts.get(PR_LANE).has("scripts/partition-shards.mjs"));
});

// ── canary ──────────────────────────────────────────────────────────────────

test("a change to the PR lane's own workflow runs the canary", () => {
  const r = classify(PR_LANE);
  assert.equal(r.verdict, "canary");
  assert.deepEqual(r.canarySpecs, CANARY_SPECS);
});

test("a change to an action the PR lane uses runs the canary", () => {
  const r = classify(".github/actions/wait-for-backend/action.yml");
  assert.equal(r.verdict, "canary");
  assert.match(r.reasons.join(" "), /used by the PR lane/);
});

test("a change to a script the PR lane reaches through an action runs the canary", () => {
  const r = classify("scripts/wait-for-backend.mjs");
  assert.equal(r.verdict, "canary");
});

test("canary wins over dispatch, and the dispatch advice survives", () => {
  // The #1045 diff exactly: an action this lane uses PLUS another lane's workflow.
  const r = classify(".github/actions/wait-for-backend/action.yml", ".github/workflows/daily-stable.yml");
  assert.equal(r.verdict, "canary");
  assert.deepEqual(r.dispatchWorkflows, [".github/workflows/daily-stable.yml"]);
});

// ── dispatch ────────────────────────────────────────────────────────────────

test("another lane's workflow yields dispatch naming that workflow", () => {
  const r = classify(".github/workflows/daily-stable.yml");
  assert.equal(r.verdict, "dispatch");
  assert.deepEqual(r.dispatchWorkflows, [".github/workflows/daily-stable.yml"]);
  assert.deepEqual(r.canarySpecs, [], "a canary here would imply coverage it cannot give");
});

test("an action only another lane uses yields dispatch naming its users", () => {
  const r = classify(".github/actions/auto-remove-stable/action.yml");
  assert.equal(r.verdict, "dispatch");
  assert.deepEqual(r.dispatchWorkflows, [".github/workflows/daily-stable.yml"]);
});

test("a script only another lane runs yields dispatch, not a canary", () => {
  const r = classify("scripts/partition-shards.mjs");
  assert.equal(r.verdict, "dispatch");
  assert.deepEqual(r.dispatchWorkflows, [".github/workflows/daily-stable.yml"]);
});

test("an action no workflow references is reported rather than passed over", () => {
  const r = classify(".github/actions/orphan/action.yml");
  assert.match(r.reasons.join(" "), /referenced by NO workflow/);
  assert.deepEqual(r.ciFiles, [".github/actions/orphan/action.yml"]);
});

// ── none ────────────────────────────────────────────────────────────────────

test("a non-CI diff is silent — no verdict, no noise", () => {
  const r = classify("docs/foo.md", "ROADMAP.md", "tests/helpers/ui/click.ts");
  assert.equal(r.verdict, "none");
  assert.deepEqual(r.ciFiles, []);
  assert.deepEqual(r.reasons, []);
});

test("a script no workflow runs is not CI surface", () => {
  // Test files and unreferenced helpers under scripts/ are covered by the unit
  // lanes; treating them as CI surface would boot a Langflow for nothing.
  const r = classify("scripts/wait-for-backend.test.mjs", "scripts/some-local-helper.mjs");
  assert.equal(r.verdict, "none");
  assert.deepEqual(r.ciFiles, []);
});

// ── Reading a workflow's triggers (#1609) ───────────────────────────────────

const triggers = (text) => readWorkflowTriggers(text).events;

test("the block form yields the event keys, not their detail", () => {
  assert.deepEqual(
    triggers(`name: x
on:
  push:
    branches: [main]
    paths:
      - "scripts/**"
  workflow_dispatch:
    inputs:
      ref:
        required: false

jobs:
  build:
    steps:
      - run: echo on:`),
    ["push", "workflow_dispatch"],
    "`branches:`/`inputs:` are detail, and `jobs:` is out of the block entirely",
  );
});

test("the flow-list and scalar forms are read too", () => {
  assert.deepEqual(triggers("on: [push, workflow_dispatch]"), ["push", "workflow_dispatch"]);
  assert.deepEqual(triggers("on: workflow_dispatch"), ["workflow_dispatch"]);
  assert.deepEqual(triggers('"on": [push]'), ["push"]);
  assert.deepEqual(triggers("on:\n  - push\n  - workflow_dispatch"), ["push", "workflow_dispatch"]);
  assert.deepEqual(triggers("on: [\n  push,\n  workflow_dispatch,\n]"), ["push", "workflow_dispatch"]);
});

test("a commented-out trigger is not a trigger, and a comment naming one is not either", () => {
  // Both shapes are live in this repo, and a grep for the token gets both wrong in
  // opposite directions: `nightly.yml` has its `schedule:` commented out, and
  // `issue-contract-guard.yml`'s `on:` block explains `workflow_dispatch` in prose
  // eleven lines before declaring it.
  assert.deepEqual(
    triggers(`on:
  # schedule:
  #   - cron: "0 3 * * *"
  workflow_dispatch:`),
    ["workflow_dispatch"],
  );
  assert.deepEqual(
    triggers(`on:
  # NOTE: a workflow_dispatch workflow must exist on the default branch first.
  push:
    branches: [main]`),
    ["push"],
    "a comment mentioning the token must not read as a declared trigger",
  );
});

test("triggers that cannot be read are UNKNOWN, with the reason attached", () => {
  for (const text of ["jobs:\n  build:\n    steps: []", "on:\n", "on: [unterminated"]) {
    const read = readWorkflowTriggers(text);
    assert.equal(read.events, null);
    assert.ok(read.note && read.note.length > 0, `no reason recorded for: ${JSON.stringify(text)}`);
  }
});

test("dispatchability has three states, and the unreadable one is not 'probably yes'", () => {
  assert.equal(workflowDispatchability("on: [push, workflow_dispatch]").dispatchable, true);
  assert.equal(workflowDispatchability("on:\n  push:\n    branches: [main]").dispatchable, false);
  assert.equal(workflowDispatchability("jobs: {}").dispatchable, null);
  // The triggers travel with the verdict: the honest message names what it DOES run on.
  assert.deepEqual(workflowDispatchability("on:\n  push:\n    branches: [main]").triggers, ["push"]);
});

// ── The advice a reviewer reads (#1609) ─────────────────────────────────────

const adviceFor = (...changed) => dispatchAdvice(classify(...changed));

test("a dispatchable workflow still gets the imperative it always got", () => {
  const { annotation, summaryLines } = adviceFor("scripts/partition-shards.mjs");
  assert.match(annotation, /Dispatch \.github\/workflows\/daily-stable\.yml on this branch before merging/);
  assert.match(summaryLines.join("\n"), /Dispatch before merging:/);
});

test("a workflow with no workflow_dispatch is never told to be dispatched", () => {
  // The issue's own acceptance criterion, asserted on the OUTPUT rather than on a
  // grep of the YAML (#1226): PR #1608 was told to dispatch a workflow that is
  // `on: push: [main]`, and following that instruction returns HTTP 422.
  const { annotation, summaryLines } = adviceFor("scripts/coverage-summary.ts");
  assert.doesNotMatch(annotation, /Dispatch/, `still prescribes a dispatch: ${annotation}`);
  assert.doesNotMatch(summaryLines.join("\n"), /Dispatch before merging/);
  assert.match(annotation, /cannot be dispatched on a branch/);
  assert.match(annotation, /no workflow_dispatch trigger \(runs on: push\)/);
  // …and it must say what IS true, not merely withhold the false instruction.
  assert.match(annotation, /Nothing in CI can prove this change before merge/);
});

test("a mixed diff dispatches what it can and is honest about the rest", () => {
  // Not hypothetical: `scripts/stable-tests.ts` is run by daily-stable and
  // weekly-stable — both dispatchable — AND by update-coverage-summary, which is
  // not. Flipping the whole message on the worst member would lose two real
  // dispatches; leaving it alone loses the correction.
  const { annotation } = adviceFor("scripts/partition-shards.mjs", "scripts/coverage-summary.ts");
  assert.match(annotation, /Dispatch \.github\/workflows\/daily-stable\.yml on this branch/);
  assert.doesNotMatch(
    annotation,
    /Dispatch [^.]*update-coverage-summary/,
    "the undispatchable workflow must not appear in the imperative",
  );
  assert.match(annotation, /update-coverage-summary\.yml cannot be dispatched on a branch/);
});

test("a workflow whose triggers are unreadable is reported as unknown, not as either answer", () => {
  const { annotation, summaryLines } = adviceFor("scripts/opaque-only.mjs");
  assert.doesNotMatch(annotation, /Dispatch/);
  assert.doesNotMatch(annotation, /cannot be dispatched/);
  assert.match(annotation, /Could not read the triggers of \.github\/workflows\/opaque\.yml/);
  assert.match(annotation, /no top-level `on:` key/, "the reason must travel with the verdict");
  assert.match(summaryLines.join("\n"), /trigger list unreadable/);
});

test("a verdict that predates the check degrades to unknown rather than to the old imperative", () => {
  // `render-impacted-summary.mjs` is handed the classifier's JSON from a file. A
  // payload without `dispatchTargets` is a payload nothing confirmed, so it must
  // not resurrect the instruction this issue removed.
  const { annotation } = dispatchAdvice({
    verdict: "dispatch",
    ciFiles: ["scripts/x.mjs"],
    dispatchWorkflows: [".github/workflows/daily-stable.yml"],
  });
  assert.doesNotMatch(annotation, /Dispatch/);
  assert.match(annotation, /Could not read the triggers/);
});

test("no advice at all on the verdicts that are not `dispatch`", () => {
  for (const r of [classify(PR_LANE), classify("docs/foo.md"), null]) {
    const { annotation, summaryLines } = dispatchAdvice(r);
    assert.equal(annotation, null);
    assert.deepEqual(summaryLines, []);
  }
});

// ── The other way to 422: disabled in Actions (#1609) ───────────────────────

test("workflow states are read from the Actions API's own TSV, junk rows ignored", () => {
  const states = parseWorkflowStates(
    [
      ".github/workflows/daily-stable.yml\tactive",
      ".github/workflows/weekly-stable.yml\tdisabled_manually",
      ".github/workflows/x.yml\tdisabled_inactivity",
      // The API also returns app-provided entries, which are not workflow paths.
      "dynamic/agents/copilot-pull-request-reviewer\tactive",
      "",
      "no-tab-here",
    ].join("\n"),
  );
  assert.equal(states.get(".github/workflows/daily-stable.yml"), true);
  assert.equal(states.get(".github/workflows/weekly-stable.yml"), false);
  assert.equal(states.get(".github/workflows/x.yml"), false, "only `active` can be dispatched");
  assert.equal(states.get("no-tab-here"), undefined);
});

test("a workflow disabled in Actions is not told to be dispatched, however good its YAML", () => {
  // `weekly-stable.yml` really is `disabled_manually` and really is named by this
  // verdict (it runs `scripts/stable-tests.ts`), so a YAML-only answer would have
  // closed #1609 while still prescribing a 422 by the other route.
  const states = new Map([[".github/workflows/daily-stable.yml", false]]);
  const r = classifyCiChange({ changed: ["scripts/partition-shards.mjs"], refs, states });
  const { annotation, summaryLines } = dispatchAdvice(r);
  assert.equal(r.dispatchTargets[0].dispatchable, true, "the trigger is there…");
  assert.equal(r.dispatchTargets[0].enabled, false, "…and the workflow is off");
  assert.doesNotMatch(annotation, /Dispatch/);
  assert.match(annotation, /is DISABLED in Actions, so dispatching it answers 422/);
  assert.match(annotation, /Nothing in CI can prove this change before merge/);
  assert.match(summaryLines.join("\n"), /is disabled in Actions/);
});

test("an unfetched state list falls back to the trigger rather than caveating everything", () => {
  // The one place this deliberately fails OPEN: a workflow carrying the trigger is
  // dispatchable unless someone disabled it, and caveating every instruction over a
  // lookup that usually succeeds is the noise that gets warnings ignored (#1252).
  const r = classifyCiChange({ changed: ["scripts/partition-shards.mjs"], refs, states: null });
  assert.equal(r.dispatchTargets[0].enabled, null, "unknown, not assumed on");
  assert.match(dispatchAdvice(r).annotation, /Dispatch \.github\/workflows\/daily-stable\.yml/);
});

test("a state file that cannot be read warns and still produces a verdict", () => {
  // Best-effort: losing the state lookup must not fail the lane, and must not be
  // silent either (#1012).
  const out = execFileSync(
    process.execPath,
    [
      path.join(REPO_ROOT, "scripts/ci-change-coverage.mjs"),
      "--root",
      REPO_ROOT,
      "--format=json",
      "--workflow-states=/nonexistent/wf-states.tsv",
      "--stdin",
    ],
    { input: "scripts/partition-shards.mjs\n", stdio: ["pipe", "pipe", "pipe"] },
  );
  assert.equal(JSON.parse(out).verdict, "dispatch");
});

test("dispatchability rides on the verdict, per named workflow", () => {
  const r = classify("scripts/coverage-summary.ts", "scripts/partition-shards.mjs");
  assert.deepEqual(
    r.dispatchTargets.map((t) => [t.workflow, t.dispatchable]),
    [
      [".github/workflows/daily-stable.yml", true],
      [".github/workflows/update-coverage-summary.yml", false],
    ],
  );
  assert.deepEqual(r.dispatchWorkflows, r.dispatchTargets.map((t) => t.workflow), "the two lists must agree");
});

// ── The real repo ───────────────────────────────────────────────────────────

test("every canary spec exists, is @stable, and needs no provider model", () => {
  // The three properties that make the canary usable: it exists (or the CLI
  // aborts), it is validated, and it never depends on provider key health — a
  // canary that skips on a drained key proves nothing (#915/#910/#911).
  const LLM = /resolveTestTargets|SimpleAgentTemplatePage|provider-setup|models\.json|MODEL_TEST_ID|initialGPTsetup|setupOpenAI|resolveGptModel|resolveGeminiModel/;
  for (const spec of CANARY_SPECS) {
    const file = path.join(REPO_ROOT, spec);
    assert.ok(fs.existsSync(file), `canary spec missing: ${spec}`);
    const source = fs.readFileSync(file, "utf8");
    assert.match(source, /@stable/, `canary spec is not @stable: ${spec}`);
    assert.doesNotMatch(source, LLM, `canary spec depends on collect-models output: ${spec}`);
    assert.doesNotMatch(source, /@destructive/, `canary spec is destructive: ${spec}`);
  }
});

test("the canary covers both the API and the browser", () => {
  // API-only would leave a broken Chromium launch to the next daily; UI-only
  // would not prove the backend answers. Both halves are the point.
  assert.ok(CANARY_SPECS.some((s) => s.includes("/api/")), "no API spec in the canary");
  assert.ok(
    CANARY_SPECS.some((s) => !s.includes("/api/")),
    "no UI spec in the canary — a broken browser launch would not be caught",
  );
});

test("against the live .github, the #1045 diff would have run the canary", () => {
  // The regression that opened #1159: this exact diff merged with the E2E lane
  // reporting `skipping`.
  const out = execFileSync(
    process.execPath,
    [path.join(REPO_ROOT, "scripts/ci-change-coverage.mjs"), "--root", REPO_ROOT, "--format=json", "--stdin"],
    { input: ".github/actions/wait-for-backend/action.yml\nscripts/wait-for-backend.mjs\n.github/workflows/pr-validation.yml\n" },
  );
  const result = JSON.parse(out);
  assert.equal(result.verdict, "canary");
  assert.deepEqual(result.canarySpecs, CANARY_SPECS);
});

test("against the live .github, a daily-only diff asks for a dispatch", () => {
  const out = execFileSync(
    process.execPath,
    [path.join(REPO_ROOT, "scripts/ci-change-coverage.mjs"), "--root", REPO_ROOT, "--format=json", "--stdin"],
    { input: ".github/workflows/daily-stable.yml\n" },
  );
  const result = JSON.parse(out);
  assert.equal(result.verdict, "dispatch");
  assert.ok(result.dispatchWorkflows.includes(".github/workflows/daily-stable.yml"));
});

test("against the live .github, PR #1608's diff no longer prescribes a 422", () => {
  // The measurement that opened #1609, replayed: `scripts/coverage-summary.ts` is
  // run only by `update-coverage-summary.yml`, which is `on: push: [main]`.
  const out = execFileSync(
    process.execPath,
    [path.join(REPO_ROOT, "scripts/ci-change-coverage.mjs"), "--root", REPO_ROOT, "--format=json", "--stdin"],
    { input: "scripts/coverage-summary.ts\n" },
  );
  const result = JSON.parse(out);
  assert.equal(result.verdict, "dispatch");
  assert.ok(result.dispatchWorkflows.includes(".github/workflows/update-coverage-summary.yml"));
  assert.doesNotMatch(result.advice, /Dispatch/, `still prescribes a dispatch: ${result.advice}`);
  assert.match(result.advice, /cannot be dispatched on a branch/);
});

test("every workflow in this repo has a DECIDABLE trigger list", () => {
  // The parser is text over YAML, so a new `on:` spelling would degrade the advice
  // to "could not read the triggers" — honest, and useless. Measured when #1609
  // shipped: 18 workflows, 18 decided, 0 unknown. This is what notices the 19th.
  const dir = path.join(REPO_ROOT, ".github/workflows");
  const files = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
  assert.ok(files.length > 0, "no workflows found — the guard would pass vacuously");
  const unreadable = files
    .map((f) => [f, workflowDispatchability(fs.readFileSync(path.join(dir, f), "utf8"))])
    .filter(([, d]) => d.dispatchable === null)
    .map(([f, d]) => `${f}: ${d.note}`);
  assert.deepEqual(unreadable, [], `readWorkflowTriggers cannot read:\n  ${unreadable.join("\n  ")}`);
});

test("an unknown flag exits 2 — undecidable must not read as 'no CI change'", () => {
  assert.throws(
    () =>
      execFileSync(process.execPath, [path.join(REPO_ROOT, "scripts/ci-change-coverage.mjs"), "--nope"], {
        stdio: "pipe",
      }),
    (error) => error.status === 2,
  );
});

// ── The lane must consume the verdict ───────────────────────────────────────

test("pr-validation.yml runs the classifier and substitutes the canary specs", () => {
  const text = fs.readFileSync(path.join(REPO_ROOT, PR_LANE), "utf8");
  assert.match(text, /node scripts\/ci-change-coverage\.mjs --stdin --format=json/);
  // Only when the import graph found nothing — a CI change that DOES touch specs
  // must still run those specs, not the canary.
  assert.match(text, /if \[ "\$TOTAL" -eq 0 \]; then/);
  assert.match(text, /SPECS=\$\(jq -r '\.canarySpecs \| join\(" "\)'/);
  // Both verdicts have to reach the reader; a silent canary is the same bug in a
  // new costume (#1012's no-silent-caps rule).
  assert.match(text, /::warning::CI-only change to a surface THIS lane runs/);
  // The dispatch sentence is RENDERED by the classifier and printed verbatim. It
  // was composed here with `jq` until #1609, and what it composed was an
  // instruction that 422s — a defect no regex over this file could have caught,
  // which is #1226's whole finding. What this still has to pin is the WIRING.
  assert.match(text, /::warning::\$\(jq -r '\.advice' \/tmp\/ci-coverage\.json\)/);
  assert.doesNotMatch(
    text,
    /Dispatch \$\(jq -r '\.dispatchWorkflows/,
    "the workflow must not compose the dispatch advice again — it cannot see the triggers",
  );
  // A classifier that cannot decide must fail the step, not degrade to "skip".
  assert.match(text, /CI-change classification failed/);
});

test("the lane supplies the Actions workflow states, and has the scope to read them", () => {
  // The second route to a 422 (#1609): the trigger is in the YAML, the workflow is
  // turned off. That state is not in the repository, so the lane fetches it — and
  // without `actions: read` the fetch 403s and the flag is silently never passed.
  const text = fs.readFileSync(path.join(REPO_ROOT, PR_LANE), "utf8");
  assert.match(text, /actions\/workflows" --paginate/);
  assert.match(text, /--workflow-states=\/tmp\/wf-states\.tsv/);
  assert.match(text, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  const detectSpecs = text.slice(text.indexOf("\n  detect-specs:"), text.indexOf("\n      - id: diff"));
  assert.match(detectSpecs, /permissions:[\s\S]*actions: read/, "detect-specs cannot read the workflow states");
  assert.match(detectSpecs, /permissions:[\s\S]*contents: read/, "an explicit block must keep checkout working");
});

test("a canary run performs the sweep, so the health gate is actually exercised", () => {
  // The hole this closes: the canary specs need no model data, so the ordinary
  // needs_models rule would skip `Collect models` — and the post-collect-models
  // health gate with it, since that step is `if: needs_models`. A canary meant to
  // cover #1045 would have skipped #1045's action.
  const text = fs.readFileSync(path.join(REPO_ROOT, PR_LANE), "utf8");
  // The invariant is "a canary forces the sweep". Where it is EXPRESSED moved in
  // #1216: the needs_models decision left this workflow's inline shell for
  // `scripts/provider-dependent-specs.mjs`, which forces it on `--canary` (asserted
  // directly in that script's own unit lane). What this file must still pin is the
  // WIRING — that the workflow actually tells the script when the run is a canary,
  // since a dropped flag would silently restore the #1045 hole this test exists for.
  assert.match(
    text,
    /CANARY_FLAG="--canary"/,
    "the canary must still force the sweep — see provider-dependent-specs.mjs",
  );
  // Matched loosely across the invocation's line continuations: what must hold is
  // that `$CANARY_FLAG` reaches THIS script's command line, not the exact order of
  // its other flags.
  assert.match(
    text,
    /provider-dependent-specs\.mjs[\s\S]{0,240}?\$CANARY_FLAG/,
    "the canary flag must reach the verdict script",
  );
  assert.match(text, /canary: \$\{\{ steps\.diff\.outputs\.canary \}\}/, "the canary flag is not a job output");
  // …and neither consequence of forcing the sweep may block a CI-only PR.
  assert.match(
    text,
    /continue-on-error: \$\{\{ needs\.detect-specs\.outputs\.canary == 'true' \}\}/,
    "Collect models stays fatal on a canary run — a drained key would block a CI-only PR",
  );
  assert.match(
    text,
    /PREFLIGHT_SKIP_CREDENTIALS: \$\{\{ needs\.detect-specs\.outputs\.needs_models == 'true' && needs\.detect-specs\.outputs\.canary != 'true'/,
    "the credential pre-flight is still enforced on a canary run",
  );
});
