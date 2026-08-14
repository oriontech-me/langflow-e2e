// Unit tests for the provider-panel entry decision (issue #1465).
// Run with: npm run test:units
//
// The property under test is a REFUSAL, not a lookup: with an Agent node on the
// canvas, "I could not find the way in" must never resolve to "there is nothing
// to configure".
//
// That is exactly what happened on 1.12.0.dev26. The Setup Provider control is
// still a real <button>, but it gained
// `aria-labelledby="node-Agent-<id>-field-model-label"`, so its accessible name
// became the field's label:
//
//   aria snapshot:  - button "Language Model required": Setup Provider
//   getByRole("button", { name: "Setup Provider" })          → 0
//   locator("button").filter({ hasText: "Setup Provider" })  → 1
//
// All three keyed helpers looked it up by role+name, found nothing, and returned
// through a branch that announces "No Agent node found on canvas" — while the
// canvas had one. Nothing was configured, the Agent ran with no model, and
// `general-bugs-agent-sum-duplicate-message-playground.spec.ts` failed 30 s later
// on a completion observable that was healthy, with the real cause
// (`ComponentBuildError: … No model selected.`) visible only in the backend log.
import { test } from "node:test";
import assert from "node:assert/strict";
import { decideEntryPoint } from "./provider-panel-entry";

test("a configured provider goes through the model dropdown", () => {
  const decision = decideEntryPoint(
    { modelDropdown: 1, setupButton: 0, agentNodes: 1 },
    "Anthropic",
  );
  assert.equal(decision.kind, "dropdown");
});

test("an unconfigured provider goes through the Setup Provider button", () => {
  const decision = decideEntryPoint(
    { modelDropdown: 0, setupButton: 1, agentNodes: 1 },
    "Anthropic",
  );
  assert.equal(decision.kind, "setup-button");
});

test("the dropdown wins when both controls are present", () => {
  // A node mid-refresh can briefly render both; the dropdown is the state that
  // already has a provider, so it is the cheaper and more reliable path.
  const decision = decideEntryPoint(
    { modelDropdown: 1, setupButton: 1, agentNodes: 1 },
    "OpenAI",
  );
  assert.equal(decision.kind, "dropdown");
});

test("no Agent node is the ONLY state that may return silently", () => {
  const decision = decideEntryPoint(
    { modelDropdown: 0, setupButton: 0, agentNodes: 0 },
    "Google Generative AI",
  );
  assert.equal(decision.kind, "no-agent");
});

// The #1465 regression, in the exact shape the live measurement produced.
test("an Agent node with no reachable entry point FAILS instead of skipping", () => {
  const decision = decideEntryPoint(
    { modelDropdown: 0, setupButton: 0, agentNodes: 1 },
    "Anthropic",
  );
  assert.equal(decision.kind, "unreachable");
  if (decision.kind !== "unreachable") return;
  // Evidence, not inference: what it looked for and what the canvas showed.
  assert.match(decision.message, /^PROVIDER_PANEL_UNREACHABLE: /);
  assert.match(decision.message, /1 Agent node\(s\)/);
  assert.match(decision.message, /model_model: 0/);
  assert.match(decision.message, /"Setup Provider" button: 0/);
  assert.match(decision.message, /Anthropic/);
  // It must NOT claim the canvas has no Agent node — the false statement the
  // helpers used to print.
  assert.ok(!/No Agent node/i.test(decision.message));
});

test("the failure message never carries a prefix a caller skips on", () => {
  const decision = decideEntryPoint(
    { modelDropdown: 0, setupButton: 0, agentNodes: 2 },
    "OpenAI",
  );
  if (decision.kind !== "unreachable") throw new Error("expected unreachable");
  // Specs turn MODEL_NOT_AVAILABLE into test.skip (llm-agents/CLAUDE.md); a
  // suite-side defect carrying that prefix would be silent all over again.
  assert.ok(!decision.message.startsWith("MODEL_NOT_AVAILABLE"));
  assert.match(decision.message, /2 Agent node\(s\)/);
});
