// Unit tests for the provider-coverage verdict (issue #1216).
// Run with: npm run test:scripts
//
// What rides on this: the verdict decides whether a PR lane runs a spec that needs
// a provider it does not have. Get it wrong in one direction and the lane emits a
// red that has nothing to do with the diff (what #1152 hit, and what this exists to
// end); wrong in the other and it silently drops coverage, or re-couples every
// helper PR to provider key health — the #915/#910/#911 cost the `needs_models`
// gate was built to avoid.
//
// The case that matters most is reproduced literally below: PR #1152's impacted set.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync, spawnSync } from "node:child_process";

import {
  ALWAYS_LLM_AREAS,
  MODEL_DATA_MARKERS,
  PROVIDER_TAGS,
  UndecidableError,
  classifySpec,
  decideProviderCoverage,
  formatExclusionWarning,
  main,
} from "./provider-dependent-specs.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const REGRESSION = "tests/tests-automations/regression/";

/** Sources realistic enough to matter: the tag line is what the classifier reads. */
const SPECS = {
  // The #1152 casualty: needs a provider for `value-dropdown-model_model`, but
  // resolves no model, so no marker matches. Tagged @agents.
  [`${REGRESSION}core-components/agent-component-regression.spec.ts`]: `
    test("renders on canvas with default fields and handles",
      { tag: ["@stable", "@release", "@regression", "@components", "@agents"] },
      async ({ page }) => { await addAgentToBlankFlow(page); });`,
  // Provider-free: the helper change that pulled the set in.
  [`${REGRESSION}core-functionality/project-management/edit-flow-name.spec.ts`]: `
    test("user should be able to edit flow name",
      { tag: ["@stable", "@release", "@workspace", "@regression"] },
      async ({ page }) => {});`,
  [`${REGRESSION}flow-functionality/run-flow.spec.ts`]: `
    test("run flow", { tag: ["@stable", "@release", "@workspace"] }, async () => {});`,
  // Consumes the sweep's output through a resolver.
  [`${REGRESSION}mcp/client/mcp-client-agent.spec.ts`]: `
    import { resolveTestTargets } from "../../../helpers/provider-setup/test-targets";
    test("agent calls echo MCP tool", { tag: ["@stable", "@mcp"] }, async () => {});`,
  // Always-LLM area.
  [`${REGRESSION}core-functionality/llm-agents/agent-system-prompt.spec.ts`]: `
    test("Agent Instructions are respected", { tag: ["@stable", "@agents"] }, async () => {});`,
};

const read = (file) => {
  if (!(file in SPECS)) throw new Error(`no fixture for ${file}`);
  return SPECS[file];
};

const AGENT_CANVAS = `${REGRESSION}core-components/agent-component-regression.spec.ts`;
const EDIT_FLOW_NAME = `${REGRESSION}core-functionality/project-management/edit-flow-name.spec.ts`;
const RUN_FLOW = `${REGRESSION}flow-functionality/run-flow.spec.ts`;
const MCP_AGENT = `${REGRESSION}mcp/client/mcp-client-agent.spec.ts`;
const LLM_AREA = `${REGRESSION}core-functionality/llm-agents/agent-system-prompt.spec.ts`;

// ---------- classifySpec ----------

test("a spec that needs a provider but resolves no model is provider-dependent", () => {
  const verdict = classifySpec(AGENT_CANVAS, SPECS[AGENT_CANVAS]);
  // The exact gap #1216 is about: the OLD rule (area + markers) said no.
  assert.equal(verdict.consumesModelData, false);
  assert.equal(verdict.providerDependent, true);
  assert.deepEqual(verdict.reasons, ["tagged @agents"]);
});

test("a spec that references a resolver consumes the sweep's output", () => {
  const verdict = classifySpec(MCP_AGENT, SPECS[MCP_AGENT]);
  assert.equal(verdict.consumesModelData, true);
  assert.equal(verdict.providerDependent, true);
  assert.match(verdict.reasons.join(" "), /resolveTestTargets/);
});

test("an always-LLM area consumes the sweep's output on path alone", () => {
  const verdict = classifySpec(LLM_AREA, SPECS[LLM_AREA]);
  assert.equal(verdict.consumesModelData, true);
  assert.match(verdict.reasons.join(" "), /llm-agents/);
});

test("a provider-free spec is neither", () => {
  const verdict = classifySpec(EDIT_FLOW_NAME, SPECS[EDIT_FLOW_NAME]);
  assert.equal(verdict.consumesModelData, false);
  assert.equal(verdict.providerDependent, false);
  assert.deepEqual(verdict.reasons, []);
});

test("an unreadable source is undecidable, never LLM-free", () => {
  // Defaulting to false here is exactly how a provider-dependent spec would run
  // bare again, so it must throw rather than guess.
  assert.throws(() => classifySpec("x.spec.ts", undefined), UndecidableError);
});

// ---------- decideProviderCoverage ----------

test("PR #1152's set: the transitive agent spec is excluded, not run bare", () => {
  // A helper change (`rename-flow.ts`) — no spec changed directly.
  const verdict = decideProviderCoverage({
    selected: [AGENT_CANVAS, EDIT_FLOW_NAME, RUN_FLOW],
    changedSpecs: [],
    read,
  });
  assert.equal(verdict.needsModels, false, "a helper PR must not gate on key health");
  assert.deepEqual(verdict.run, [EDIT_FLOW_NAME, RUN_FLOW]);
  assert.deepEqual(
    verdict.excluded.map((spec) => spec.file),
    [AGENT_CANVAS],
  );
});

test("the same spec, changed DIRECTLY, forces the sweep and runs", () => {
  // The PR is about that spec: skipping it would mean the lane ran nothing
  // covering its own diff, so gating on key health is the correct trade here.
  const verdict = decideProviderCoverage({
    selected: [AGENT_CANVAS, EDIT_FLOW_NAME],
    changedSpecs: [AGENT_CANVAS],
    read,
  });
  assert.equal(verdict.needsModels, true);
  assert.deepEqual(verdict.run, [AGENT_CANVAS, EDIT_FLOW_NAME]);
  assert.deepEqual(verdict.excluded, []);
  assert.deepEqual(verdict.forcedBy, [
    { file: AGENT_CANVAS, isChanged: true, reasons: ["tagged @agents"] },
  ]);
});

test("a sweep-consuming spec forces it even when only transitive", () => {
  // The documented asymmetry: these fail at SETUP without the sweep and have
  // always been in scope, so excluding them would remove coverage that exists
  // today. Stated as a test so a future change to it is deliberate.
  const verdict = decideProviderCoverage({
    selected: [MCP_AGENT, EDIT_FLOW_NAME],
    changedSpecs: [],
    read,
  });
  assert.equal(verdict.needsModels, true);
  assert.deepEqual(verdict.excluded, []);
});

test("with the sweep running, nothing is excluded", () => {
  const verdict = decideProviderCoverage({
    selected: [LLM_AREA, AGENT_CANVAS, EDIT_FLOW_NAME],
    changedSpecs: [],
    read,
  });
  assert.equal(verdict.needsModels, true);
  assert.deepEqual(verdict.run.length, 3);
  assert.deepEqual(verdict.excluded, []);
});

test("a canary forces the sweep and excludes nothing", () => {
  // #1159: the canary exists so the post-sweep health gate has something to gate.
  const verdict = decideProviderCoverage({
    selected: [AGENT_CANVAS],
    changedSpecs: [],
    read,
    canary: true,
  });
  assert.equal(verdict.needsModels, true);
  assert.deepEqual(verdict.excluded, []);
  assert.deepEqual(verdict.run, [AGENT_CANVAS]);
});

test("an LLM-free set changes nothing", () => {
  const verdict = decideProviderCoverage({
    selected: [EDIT_FLOW_NAME, RUN_FLOW],
    changedSpecs: [EDIT_FLOW_NAME],
    read,
  });
  assert.equal(verdict.needsModels, false);
  assert.deepEqual(verdict.run, [EDIT_FLOW_NAME, RUN_FLOW]);
  assert.deepEqual(verdict.excluded, []);
});

test("excluding EVERY selected spec forces the sweep instead of running nothing", () => {
  // Decoupling from provider key health is worth one spec's coverage, never worth
  // all of it. An empty run list makes the lane's `has_specs` gate skip the E2E job
  // entirely, and a lane that runs nothing is not a cheaper green — it is no
  // evidence at all (#1012).
  const verdict = decideProviderCoverage({
    selected: [AGENT_CANVAS],
    changedSpecs: [],
    read,
  });
  assert.equal(verdict.needsModels, true);
  assert.equal(verdict.forcedToAvoidEmptyRun, true);
  assert.deepEqual(verdict.excluded, []);
  assert.deepEqual(verdict.run, [AGENT_CANVAS]);
});

test("an exclusion is worded so a shortened run cannot read as full coverage", () => {
  const verdict = decideProviderCoverage({
    selected: [AGENT_CANVAS, EDIT_FLOW_NAME],
    changedSpecs: [],
    read,
  });
  assert.equal(verdict.excluded.length, 1);
  const warning = formatExclusionWarning(verdict.excluded);
  assert.match(warning, /NOT run here/);
  assert.match(warning, /daily-stable\.yml/);
  assert.match(warning, /manual\.yml/);
  assert.match(warning, /#1216/);
  assert.match(warning, /agent-component-regression/);
});

test("a canary with an EMPTY impacted set excludes nothing and keeps its own list", () => {
  // The canary's specs come from `ci-change-coverage.mjs`, not from the import
  // graph, so `selected` is empty on a CI-only PR. A verdict that returned an empty
  // run list here would let the workflow clobber the canary list and skip the E2E
  // job — killing the very run #1159 added to prove the lane boots.
  const verdict = decideProviderCoverage({
    selected: [],
    changedSpecs: [],
    read,
    canary: true,
  });
  assert.equal(verdict.needsModels, true);
  assert.deepEqual(verdict.run, []);
  assert.deepEqual(verdict.excluded, []);
  assert.equal(verdict.forcedToAvoidEmptyRun, false, "an empty SELECTION is not an emptied run");
});

test("bad arguments are undecidable", () => {
  assert.throws(
    () => decideProviderCoverage({ selected: "nope", changedSpecs: [], read }),
    UndecidableError,
  );
  assert.throws(
    () => decideProviderCoverage({ selected: [], changedSpecs: [], read: null }),
    UndecidableError,
  );
});

test("a MISSING changedSpecs is undecidable, not an empty list", () => {
  // Defaulting it fails OPEN on coverage: with no changed specs every
  // provider-dependent spec looks transitive and gets excluded. That is the
  // opposite of this script's own rule, and it would fire the day the resolver's
  // JSON shape changes.
  assert.throws(
    () => decideProviderCoverage({ selected: [AGENT_CANVAS], read }),
    UndecidableError,
  );
});

// ---------- the constants themselves ----------

test("the marker list still covers the cross-area consumers", () => {
  // Unchanged from the inline shell it replaces — this change must not alter any
  // existing verdict, only add the new class.
  for (const marker of [
    "resolveTestTargets",
    "SimpleAgentTemplatePage",
    "initialGPTsetup",
    "MODEL_TEST_ID",
  ]) {
    assert.ok(MODEL_DATA_MARKERS.includes(marker), `${marker} must stay a marker`);
  }
  assert.equal(ALWAYS_LLM_AREAS.length, 2);
});

test("@playground is deliberately NOT a provider tag", () => {
  // A playground spec can assert UI without a completion, and including it would
  // force the sweep across a large, mostly LLM-free area — re-coupling the very
  // PRs #980 decoupled.
  assert.deepEqual(PROVIDER_TAGS, ["@agents", "@model-provider"]);
});

// ---------- CLI ----------

// ---------- the workflow wiring ----------

test("pr-validation calls the verdict and emits the run list ONLY after it", () => {
  // The bug this pins is invisible in a green run: `specs`/`has_specs` used to be
  // written to $GITHUB_OUTPUT before the provider verdict existed, so re-adding an
  // early write would leave which value wins up to the runner — and the excluded
  // specs would reach Playwright anyway. Structural, like the workflow-shape guard
  // in `wait-for-backend.test.mjs`, because no unit test of this script can see it.
  const workflow = readFileSync(
    path.join(REPO_ROOT, ".github/workflows/pr-validation.yml"),
    "utf8",
  );
  assert.match(
    workflow,
    /node scripts\/provider-dependent-specs\.mjs --stdin --format=json/,
    "the lane must ask this script for the verdict",
  );
  assert.match(
    workflow,
    /--changed-file=\/tmp\/changed\.txt/,
    "the verdict must read the PR's changed files, never impacted.direct — that " +
      "field is the depth-1 importers, and misreading it forced the sweep for the " +
      "very helper-only diff this fixes (#1216)",
  );
  // A canary's specs come from ci-change-coverage, not the import graph, so the
  // re-derivation MUST be skipped there or the E2E job is skipped outright.
  assert.match(
    workflow,
    /if \[ "\$CANARY" != "true" \]; then\n\s+SPECS=\$\(jq -r '\.run \| join\(" "\)'/,
    "the canary's spec list must survive the verdict (#1159)",
  );
  const count = (needle) => workflow.split(needle).length - 1;
  assert.equal(count('echo "specs=$SPECS"'), 1, "the run list is emitted exactly once");
  assert.equal(
    count('echo "has_specs=$HAS_SPECS"'),
    1,
    "has_specs is emitted exactly once",
  );
  // …and that single emission must come after the verdict re-derives SPECS.
  const verdictAt = workflow.indexOf("provider-dependent-specs.mjs");
  const rederiveAt = workflow.indexOf("SPECS=$(jq -r '.run | join(\" \")'");
  const emitAt = workflow.indexOf('echo "specs=$SPECS"');
  assert.ok(verdictAt > 0 && rederiveAt > verdictAt, "SPECS must be re-derived from the verdict");
  assert.ok(emitAt > rederiveAt, "the run list must be emitted after it is re-derived");
});

test("an exclusion is announced, never silent", () => {
  // #1012's rule: whatever the lane does not cover is stated, not inferred from a
  // green check. The wording lives in this script (and is asserted above), so the
  // workflow must echo it rather than paraphrase.
  const workflow = readFileSync(
    path.join(REPO_ROOT, ".github/workflows/pr-validation.yml"),
    "utf8",
  );
  assert.match(workflow, /::warning::\$\(jq -r '\.warning' \/tmp\/provider\.json\)/);
  assert.match(workflow, /GITHUB_STEP_SUMMARY/);
});

// ---------- against the REAL resolver ----------

test("PR #1152's actual diff: the resolver's own output, not a hand-built fixture", () => {
  // This test exists because a hand-built fixture (`direct: []`) lied. The real
  // `impacted-specs-by-import.mjs` puts every DEPTH-1 IMPORTER in `.direct`, so for
  // a one-helper diff all 7 callers were "direct" — and a verdict that read that
  // field as "the PR changed this" forced the sweep for exactly the case #1216
  // exists to fix, while every unit test stayed green.
  //
  // So the fixture is now the resolver itself, run on the real diff of PR #1152, and
  // the specs are read off the real tree. If the resolver's shape or this repo's
  // import graph changes, this fails instead of quietly agreeing with itself.
  const impacted = JSON.parse(
    execFileSync(
      process.execPath,
      [
        path.join(REPO_ROOT, "scripts/impacted-specs-by-import.mjs"),
        "--stdin",
        "--format=json",
        "--cap",
        "20",
      ],
      { input: "tests/helpers/flows/rename-flow.ts\n", encoding: "utf8" },
    ),
  );

  assert.ok(
    impacted.direct.length > 1,
    "guard the guard: `.direct` must still be the depth-1 importers, else this " +
      "test would stop covering the trap it was written for",
  );

  const verdict = decideProviderCoverage({
    selected: impacted.selected,
    // What the PR actually changed: one helper, no spec files.
    changedSpecs: [],
    read: (file) => readFileSync(path.join(REPO_ROOT, file), "utf8"),
  });

  const agentSpec = impacted.selected.find((file) =>
    file.endsWith("agent-component-regression.spec.ts"),
  );
  assert.ok(agentSpec, "the agent spec must still be reachable from renameFlow");
  assert.equal(
    verdict.needsModels,
    false,
    "a helper-only diff must not gate this lane on provider key health",
  );
  assert.deepEqual(
    verdict.excluded.map((spec) => spec.file),
    [agentSpec],
    "the provider-dependent spec is excluded rather than run bare",
  );
  assert.ok(
    verdict.run.length >= 5 && !verdict.run.includes(agentSpec),
    "the rest of the impacted set still runs",
  );
});

test("the same diff plus that spec edited: the sweep is forced and it runs", () => {
  const impacted = JSON.parse(
    execFileSync(
      process.execPath,
      [
        path.join(REPO_ROOT, "scripts/impacted-specs-by-import.mjs"),
        "--stdin",
        "--format=json",
        "--cap",
        "20",
      ],
      { input: "tests/helpers/flows/rename-flow.ts\n", encoding: "utf8" },
    ),
  );
  const agentSpec = impacted.selected.find((file) =>
    file.endsWith("agent-component-regression.spec.ts"),
  );
  const verdict = decideProviderCoverage({
    selected: impacted.selected,
    changedSpecs: [agentSpec],
    read: (file) => readFileSync(path.join(REPO_ROOT, file), "utf8"),
  });
  assert.equal(verdict.needsModels, true);
  assert.deepEqual(verdict.excluded, []);
  assert.ok(verdict.run.includes(agentSpec));
});

// ---------- the CLI, actually exercised ----------

const CLI = path.join(REPO_ROOT, "scripts/provider-dependent-specs.mjs");

/** Run the real CLI in a child process. Returns `{status, stdout, stderr}`. */
function runCli(args, { impacted, changedFiles }) {
  const changedPath = path.join(
    os.tmpdir(),
    `changed-${process.pid}-${args.join("_").replace(/\W/g, "")}.txt`,
  );
  writeFileSync(changedPath, changedFiles);
  try {
    const result = spawnSync(
      process.execPath,
      [CLI, ...args, `--changed-file=${changedPath}`],
      { input: JSON.stringify(impacted), encoding: "utf8" },
    );
    return result;
  } finally {
    rmSync(changedPath, { force: true });
  }
}

test("the CLI emits the GitHub outputs and warns, over a real stdin", () => {
  const result = runCli(["--stdin"], {
    impacted: { selected: [AGENT_CANVAS, EDIT_FLOW_NAME] },
    changedFiles: "tests/helpers/flows/rename-flow.ts\n",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /needs_models=false/);
  assert.match(result.stdout, new RegExp(`specs=${EDIT_FLOW_NAME}`));
  assert.doesNotMatch(result.stdout, /agent-component-regression/);
  assert.match(result.stderr, /::warning::/);
  assert.match(result.stderr, /agent-component-regression/);
});

test("the CLI's JSON carries the warning text, so the workflow never rewords it", () => {
  const result = runCli(["--stdin", "--format=json"], {
    impacted: { selected: [AGENT_CANVAS, EDIT_FLOW_NAME] },
    changedFiles: "tests/helpers/flows/rename-flow.ts\n",
  });
  assert.equal(result.status, 0, result.stderr);
  const verdict = JSON.parse(result.stdout);
  assert.equal(verdict.needsModels, false);
  assert.match(verdict.warning, /NOT run here/);
  assert.deepEqual(verdict.run, [EDIT_FLOW_NAME]);
});

test("a changed spec file reaches the verdict through the changed-file list", () => {
  const result = runCli(["--stdin", "--format=json"], {
    impacted: { selected: [AGENT_CANVAS, EDIT_FLOW_NAME] },
    changedFiles: `tests/helpers/flows/rename-flow.ts\n${AGENT_CANVAS}\n`,
  });
  assert.equal(result.status, 0, result.stderr);
  const verdict = JSON.parse(result.stdout);
  assert.equal(verdict.needsModels, true, "editing the spec forces the sweep");
  assert.deepEqual(verdict.excluded, []);
  assert.equal(verdict.warning, "");
});

test("the CLI exits 2 on a missing --changed-file, malformed JSON, or a bad flag", () => {
  // Three ways to be undecidable, all of which must fail the step rather than
  // degrade to "LLM-free" (#1012).
  const noFlag = spawnSync(process.execPath, [CLI, "--stdin"], {
    input: "{}",
    encoding: "utf8",
  });
  assert.equal(noFlag.status, 2);
  assert.match(noFlag.stderr, /usage:/);

  const malformed = runCli(["--stdin"], {
    impacted: "not json at all",
    changedFiles: "",
  });
  // A quoted string IS valid JSON, so force the parse failure explicitly instead.
  const trulyMalformed = spawnSync(
    process.execPath,
    [CLI, "--stdin", "--changed-file=/dev/null"],
    { input: "{ nope", encoding: "utf8" },
  );
  assert.equal(trulyMalformed.status, 2);
  assert.match(trulyMalformed.stderr, /malformed impacted-specs JSON|verdict failed/);
  assert.ok(malformed.status === 2 || malformed.status === 0);

  const badFlag = runCli(["--stdin", "--bogus"], {
    impacted: { selected: [] },
    changedFiles: "",
  });
  assert.equal(badFlag.status, 2);

  const unreadableSpec = runCli(["--stdin"], {
    impacted: { selected: ["tests/does-not-exist.spec.ts"] },
    changedFiles: "",
  });
  assert.equal(unreadableSpec.status, 2, "an unreadable spec is undecidable");
});
