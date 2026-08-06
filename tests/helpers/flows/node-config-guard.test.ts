// Unit tests for the node-configuration guard (issue #1302).
// Run with: npm run test:units
//
// What rides on these: whether a node that silently reverted reports itself as
// such, or as the thing #1302 was filed under — `expect(locator).toHaveCount`
// timing out after 180 s on `div-chat-message`, three layers downstream of the
// cause, which read as "the model was slow" and sent the issue after the wait
// budget. The budget was never the cause: the same step costs 5 408-6 503 ms on
// the four dailies measured, cold container or warm.
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyInfraError } from "../../../scripts/lib/infra-signatures";
import {
  classifyConfigOutcome,
  revertedConfigMessage,
} from "./node-config-guard";

const DETAIL = {
  field: "Model Name",
  expected: "llama3.2:1b",
  observed: "Select an option",
  valueTestId: "value-dropdown-dropdown_str_model_name",
};

test("a widget still showing the value HELD, even inside a larger label", () => {
  // These widgets render the selection among other text — the spec's own
  // assertion uses toContainText for the same reason. Equality here would call
  // a perfectly good selection a revert.
  assert.equal(classifyConfigOutcome("llama3.2:1b", "llama3.2:1b"), "held");
  assert.equal(
    classifyConfigOutcome("llama3.2:1b", "Model: llama3.2:1b (local)"),
    "held",
  );
});

test("the reverted states are the default label, empty, and a missing widget", () => {
  // "Select an option" is what the #1302 DOM actually showed; the other two are
  // the states the same revert can leave behind while the canvas re-renders.
  assert.equal(
    classifyConfigOutcome("llama3.2:1b", "Select an option"),
    "reverted",
  );
  assert.equal(classifyConfigOutcome("llama3.2:1b", ""), "reverted");
  assert.equal(classifyConfigOutcome("llama3.2:1b", null), "reverted");
});

test("a DIFFERENT model is reverted, not held — the run would use the wrong one", () => {
  // Not hypothetical: the drop-to-workspace-default class (#491/#596) replaces
  // the selection rather than clearing it, and that run executes green against
  // a model the test never chose.
  assert.equal(
    classifyConfigOutcome("llama3.2:1b", "qwen2.5:0.5b"),
    "reverted",
  );
});

test("the message names the field, both values, and the testid it read", () => {
  const msg = revertedConfigMessage(DETAIL);

  assert.match(msg, /Model Name/);
  assert.match(msg, /llama3\.2:1b/);
  assert.match(msg, /Select an option/);
  assert.match(msg, /value-dropdown-dropdown_str_model_name/);
});

test("an empty widget is reported as empty, not as a missing one", () => {
  // Same distinction the sidebar-add message draws: `""` is a real observation
  // (the field was reset) and must not read the same as "the widget is gone",
  // which points at a re-render instead.
  const empty = revertedConfigMessage({ ...DETAIL, observed: "" });
  const gone = revertedConfigMessage({ ...DETAIL, observed: null });

  assert.match(empty, /EMPTY/);
  assert.doesNotMatch(empty, /GONE/);
  assert.match(gone, /GONE/);
  assert.doesNotMatch(gone, /EMPTY/);
});

test("the companion field is what distinguishes one widget from a whole-node reset", () => {
  // In #1302 BOTH the model and the base URL were back at their defaults. A
  // message about the dropdown alone would understate it as a selection glitch.
  const msg = revertedConfigMessage({
    ...DETAIL,
    companion: {
      field: "Ollama API URL",
      expected: "http://ollama:11434",
      observed: "http://localhost:11434",
    },
  });

  assert.match(msg, /Ollama API URL/);
  assert.match(msg, /http:\/\/ollama:11434/);
  assert.match(msg, /http:\/\/localhost:11434/);
  assert.match(msg, /the whole node was reset/);
});

test("without a companion the message makes no claim about other fields", () => {
  assert.doesNotMatch(revertedConfigMessage(DETAIL), /whole node was reset/);
});

test("the message points at the cause and forbids the wrong reading", () => {
  // The two sentences that exist to stop #1302 being re-diagnosed as a budget:
  // it names the flow-save race, and it says outright that this is not slowness.
  const msg = revertedConfigMessage(DETAIL);

  assert.match(msg, /wait-for-flow-save-settled/);
  assert.match(msg, /no version check/);
  assert.match(msg, /in-memory graph/);
  assert.match(msg, /NOT read this as a slow model or a short timeout/);
});

test("the reverted-config message is NOT classifiable as an infra failure", () => {
  // #1262's rule: claiming infra would exempt this from @stable auto-removal
  // and hide a node that silently drops its configuration.
  assert.equal(classifyInfraError(revertedConfigMessage(DETAIL)), null);
});
