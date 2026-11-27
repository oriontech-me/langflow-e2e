// Unit tests for the outdated-but-safe repair flow (#2567).
// Run with: npm run test:units
//
// What rides on this builder: the upgrade-repair specs need a flow whose preview reads
// `ready` with exactly one node to update. That only holds if the OpenAI node keeps its
// FROZEN code (a current copy has nothing to update) and the edge's target handle is the
// live Chat Output's (a stale handle is an edge the editor drops on load).
import { test } from "node:test";
import assert from "node:assert/strict";
import { OUTDATED_SAFE_CHAT_OUTPUT_ID, buildOutdatedSafeFlow } from "./outdated-safe-flow";

const LIVE_INPUT_TYPES = ["Data", "JSON", "DataFrame", "Table", "Message"];

function liveCatalog(): Record<string, unknown> {
  return {
    models: {
      // A CURRENT OpenAI component: the builder must not pick it over the frozen one.
      OpenAIModel: {
        outputs: [{ name: "text_output", types: ["Message"] }],
        template: { code: { value: "current openai code" } },
      },
    },
    input_output: {
      ChatOutput: {
        outputs: [{ name: "message", types: ["Message"] }],
        template: {
          code: { value: "current chat output code" },
          input_value: { type: "other", input_types: LIVE_INPUT_TYPES, value: "" },
        },
      },
    },
  };
}

function fixture() {
  return {
    nodes: [
      { id: "Prompt-1", data: { type: "Prompt", node: { template: {} } } },
      {
        id: "OpenAIModel-gQ2Hu",
        data: {
          type: "OpenAIModel",
          node: {
            outputs: [
              { name: "text_output", types: ["Message"] },
              { name: "model_output", types: ["LanguageModel"] },
            ],
            template: { code: { value: "frozen openai code" } },
          },
        },
      },
    ],
  };
}

test("the OpenAI node keeps the fixture's frozen code, not the live catalog's", () => {
  const built = buildOutdatedSafeFlow(liveCatalog(), fixture());
  const openAi = built.data.nodes.find((n) => n.id === "OpenAIModel-gQ2Hu")!;
  assert.equal(openAi.data.node.template.code.value, "frozen openai code");
  assert.equal(built.openAiCode, "frozen openai code");
  assert.equal(built.openAiNodeId, "OpenAIModel-gQ2Hu");
});

test("the Chat Output is the live catalog's", () => {
  const built = buildOutdatedSafeFlow(liveCatalog(), fixture());
  const chat = built.data.nodes.find((n) => n.id === OUTDATED_SAFE_CHAT_OUTPUT_ID)!;
  assert.equal(chat.data.node.template.code.value, "current chat output code");
});

test("the one edge's target handle is the live Chat Output's input_value", () => {
  const built = buildOutdatedSafeFlow(liveCatalog(), fixture());
  assert.equal(built.data.edges.length, 1);
  const edge = built.data.edges[0];
  assert.deepEqual([edge.source, edge.target], ["OpenAIModel-gQ2Hu", OUTDATED_SAFE_CHAT_OUTPUT_ID]);
  assert.deepEqual(edge.data.targetHandle, {
    fieldName: "input_value",
    id: OUTDATED_SAFE_CHAT_OUTPUT_ID,
    inputTypes: LIVE_INPUT_TYPES,
    type: "other",
  });
  assert.deepEqual(edge.data.sourceHandle, {
    dataType: "OpenAIModel",
    id: "OpenAIModel-gQ2Hu",
    name: "text_output",
    output_types: ["Message"],
  });
});

test("the live catalog is not modified", () => {
  const catalog = liveCatalog();
  const before = JSON.stringify(catalog);
  buildOutdatedSafeFlow(catalog, fixture());
  assert.equal(JSON.stringify(catalog), before);
});

test("a fixture without an OpenAI node is refused by name", () => {
  assert.throws(() => buildOutdatedSafeFlow(liveCatalog(), { nodes: [] }), /no OpenAIModel node/);
});
