// Unit tests for the run-request model binding parser (issue #1678).
// Run with: npm run test:units
//
// What rides on this function: whether a run that executes a model the flow does
// not name is CAUGHT and named, or passes green.
//
// `POST /api/v2/workflows` carries `data`, declared upstream as an "optional
// live-canvas override of the flow's nodes/edges" that "takes priority over the
// saved flow data" — so the run builds that payload, not the database row. The
// row is therefore the wrong object to gate on, measured: on 1.13.0.dev19 the
// pre-send read of `GET /api/v1/flows/{id}` returned `gpt-4o-mini` /
// `OpenAI Compatible` while the run request carried `gpt-6-astra` / `OpenAI`, and
// the test passed because OpenAI answered and echoed the sentinel (3/3 with the
// send delayed 4 s; ~9 of 33 runs unmodified).
//
// The parser's whole job is to answer, off that body: which model, and whose.
// Every shape below was taken off a real capture or is a degradation the spec
// must not read as a healthy run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRunModelBinding } from "./watch-run-model-binding";

/** A run body as the frontend sends it, trimmed to what the parser reads. */
function runBody(modelValue: unknown, extraNodes: unknown[] = []): unknown {
  return {
    flow_id: "2cdd9950-0b56-4cf4-a2a9-01e3aa727422",
    input_value: "Repeat this token exactly and nothing else: OC-1",
    data: {
      nodes: [
        { id: "ChatInput-aBcDe", data: { node: { template: { input_value: { value: "" } } } } },
        ...extraNodes,
        {
          id: "LanguageModelComponent-FLeYF",
          data: {
            node: {
              template: {
                model_name: { value: "" },
                model: { value: modelValue },
              },
            },
          },
        },
      ],
    },
  };
}

test("the run's model and provider are read off the live-canvas payload", () => {
  const binding = parseRunModelBinding(
    runBody([{ name: "gpt-4o-mini", provider: "OpenAI Compatible", metadata: { icon: "Plug" } }]),
  );

  assert.deepEqual(binding.models, ["gpt-4o-mini"]);
  assert.deepEqual(binding.providers, ["OpenAI Compatible"]);
  assert.equal(binding.hasData, true);
  assert.equal(binding.nodeId, "LanguageModelComponent-FLeYF");
});

test("a substituted model is reported as itself, not normalised away", () => {
  // The measured substitution: the flow is configured for OpenAI Compatible and the
  // run carries the editor's refill. The parser must surface the substitute so the
  // assertion message can name it.
  const binding = parseRunModelBinding(
    runBody([{ name: "gpt-6-astra", provider: "OpenAI", metadata: { context_length: 128000 } }]),
  );

  assert.deepEqual(binding.models, ["gpt-6-astra"]);
  assert.deepEqual(binding.providers, ["OpenAI"]);
});

test("an emptied model field is not silently a pass", () => {
  // The blank is the first half of the defect — the backend answers `[]` and the
  // frontend refills it. A run that still carries the blank must not read as
  // "provider matched"; it carries no model at all.
  const binding = parseRunModelBinding(runBody([]));

  assert.deepEqual(binding.models, []);
  assert.deepEqual(binding.providers, []);
  assert.equal(binding.hasData, true);
});

test("a bare string value degrades to a model with no provider observed", () => {
  // The pre-unified-selector shape, tolerated exactly as `persistedModelBinding`
  // tolerates it: a name says nothing about the provider, so claiming one would be
  // worse than reporting none.
  const binding = parseRunModelBinding(runBody("gpt-4o-mini"));

  assert.deepEqual(binding.models, ["gpt-4o-mini"]);
  assert.deepEqual(binding.providers, []);
});

test("a run sent WITHOUT the live-canvas override is reported as such", () => {
  // `data` is optional in `WorkflowRunRequest`. Absent, the backend builds the saved
  // flow and this parser has nothing to say — which the caller must be able to tell
  // apart from "the payload named the wrong model".
  const binding = parseRunModelBinding({
    flow_id: "2cdd9950-0b56-4cf4-a2a9-01e3aa727422",
    input_value: "hi",
  });

  assert.equal(binding.hasData, false);
  assert.equal(binding.nodeId, null);
  assert.deepEqual(binding.models, []);
});

test("a payload with no Language Model node reports no node, not an empty model", () => {
  const binding = parseRunModelBinding({
    data: { nodes: [{ id: "ChatInput-aBcDe", data: { node: { template: {} } } }] },
  });

  assert.equal(binding.hasData, true);
  assert.equal(binding.nodeId, null);
  assert.deepEqual(binding.models, []);
});

test("the node is found by the model_name template key, whatever its position", () => {
  // `persistedModelBinding` identifies the unified model node the same way, and the
  // node order in `data.nodes` follows the canvas, not the graph.
  const binding = parseRunModelBinding(
    runBody([{ name: "gpt-4o-mini", provider: "OpenAI Compatible" }], [
      { id: "Prompt-xYz", data: { node: { template: { template: { value: "hi" } } } } },
    ]),
  );

  assert.equal(binding.nodeId, "LanguageModelComponent-FLeYF");
  assert.deepEqual(binding.models, ["gpt-4o-mini"]);
});

test("several model entries are all reported, so a multi-entry value cannot hide one", () => {
  const binding = parseRunModelBinding(
    runBody([
      { name: "gpt-4o-mini", provider: "OpenAI Compatible" },
      { name: "gpt-6-astra", provider: "OpenAI" },
    ]),
  );

  assert.deepEqual(binding.models, ["gpt-4o-mini", "gpt-6-astra"]);
  assert.deepEqual(binding.providers, ["OpenAI Compatible", "OpenAI"]);
});

test("a body that is not an object is not a crash and not a pass", () => {
  for (const body of [null, undefined, "", 42, []]) {
    const binding = parseRunModelBinding(body);
    assert.equal(binding.hasData, false, `body ${JSON.stringify(body)}`);
    assert.deepEqual(binding.models, []);
  }
});

test("the summary names the model, the provider and the node", () => {
  // This string is what the spec prints when the assertion fails — an unattributed
  // diff is the failure mode #1678 exists to end.
  const summary = parseRunModelBinding(
    runBody([{ name: "gpt-6-astra", provider: "OpenAI" }]),
  ).summary;

  assert.match(summary, /gpt-6-astra/);
  assert.match(summary, /OpenAI/);
  assert.match(summary, /LanguageModelComponent-FLeYF/);
});

test("the summary says so when the run carried no live-canvas payload", () => {
  const summary = parseRunModelBinding({ flow_id: "x" }).summary;

  assert.match(summary, /no live-canvas `data` payload/i);
});
