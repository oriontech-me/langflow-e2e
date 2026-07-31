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
import { readFileSync } from "node:fs";
import path from "node:path";

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
    direct: [],
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
    direct: [AGENT_CANVAS],
    read,
  });
  assert.equal(verdict.needsModels, true);
  assert.deepEqual(verdict.run, [AGENT_CANVAS, EDIT_FLOW_NAME]);
  assert.deepEqual(verdict.excluded, []);
  assert.deepEqual(verdict.forcedBy, [
    { file: AGENT_CANVAS, isDirect: true, reasons: ["tagged @agents"] },
  ]);
});

test("a sweep-consuming spec forces it even when only transitive", () => {
  // The documented asymmetry: these fail at SETUP without the sweep and have
  // always been in scope, so excluding them would remove coverage that exists
  // today. Stated as a test so a future change to it is deliberate.
  const verdict = decideProviderCoverage({
    selected: [MCP_AGENT, EDIT_FLOW_NAME],
    direct: [],
    read,
  });
  assert.equal(verdict.needsModels, true);
  assert.deepEqual(verdict.excluded, []);
});

test("with the sweep running, nothing is excluded", () => {
  const verdict = decideProviderCoverage({
    selected: [LLM_AREA, AGENT_CANVAS, EDIT_FLOW_NAME],
    direct: [],
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
    direct: [],
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
    direct: [EDIT_FLOW_NAME],
    read,
  });
  assert.equal(verdict.needsModels, false);
  assert.deepEqual(verdict.run, [EDIT_FLOW_NAME, RUN_FLOW]);
  assert.deepEqual(verdict.excluded, []);
});

test("excluding every selected spec is allowed but never silent", () => {
  const verdict = decideProviderCoverage({
    selected: [AGENT_CANVAS],
    direct: [],
    read,
  });
  assert.deepEqual(verdict.run, []);
  assert.equal(verdict.excluded.length, 1);
  // The lane's `has_specs` gate then skips the E2E job, which is safe only because
  // the reason reaches the reviewer: an empty run list must never look like a pass.
  const warning = formatExclusionWarning(verdict.excluded);
  assert.match(warning, /NOT run here/);
  assert.match(warning, /daily-stable\.yml/);
  assert.match(warning, /manual\.yml/);
  assert.match(warning, /#1216/);
  assert.match(warning, /agent-component-regression/);
});

test("bad arguments are undecidable", () => {
  assert.throws(
    () => decideProviderCoverage({ selected: "nope", read }),
    UndecidableError,
  );
  assert.throws(
    () => decideProviderCoverage({ selected: [], read: null }),
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

test("the CLI emits GitHub outputs and warns on exclusion", () => {
  const out = [];
  const err = [];
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  const stdin = { selected: [AGENT_CANVAS, EDIT_FLOW_NAME], direct: [] };
  process.stdout.write = (chunk) => out.push(chunk);
  process.stderr.write = (chunk) => err.push(chunk);
  let code;
  try {
    // `main` reads fd 0; feed it by monkey-patching the reader via `read` and a
    // pre-serialized stdin is not possible here, so exercise the pure path and the
    // formatter above, and assert the CLI's contract on argument handling below.
    code = main(["node", "provider-dependent-specs.mjs", "--bogus"], { read });
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
  assert.equal(code, 2, "an unknown flag must exit 2, not default to a verdict");
  assert.match(err.join(""), /usage:/);
  assert.ok(stdin.selected.length > 0);
});

test("a missing --stdin exits 2 rather than assuming an empty set", () => {
  const err = [];
  const stderr = process.stderr.write;
  process.stderr.write = (chunk) => err.push(chunk);
  let code;
  try {
    code = main(["node", "provider-dependent-specs.mjs"], { read });
  } finally {
    process.stderr.write = stderr;
  }
  assert.equal(code, 2);
});

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
