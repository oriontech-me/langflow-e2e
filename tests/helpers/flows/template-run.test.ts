// Unit tests for the shared template-run helpers (#2467).
// Run with: npm run test:units
//
// These helpers decide what the template-execution specs check, so a defect here passes
// silently: a built-node derivation that drops a node shrinks the build check, a
// `ranField` that reads the saved flow over the live payload misses the silent model
// fallback #1372 was about, and a `readTemplate` that hands back the listing's own object
// lets one test's pins leak into the next. Each test below pins one of those.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { APIRequestContext } from "@playwright/test";
import {
  buildableNodes,
  componentNodes,
  field,
  modelPairs,
  onlyNode,
  ranField,
  readTemplate,
  resolveModelOption,
  type FlowData,
  type FlowNode,
} from "./template-run";

function node(id: string, type: string, extra: Partial<NonNullable<FlowNode["data"]>> = {}) {
  return { id, type: "genericNode", data: { type, ...extra } } satisfies FlowNode;
}

function graph(nodes: FlowNode[]): FlowData {
  return { nodes, edges: [] };
}

/** A fake APIRequestContext answering one GET with `body` at `status`, counting calls. */
function fakeRequest(status: number, body: unknown) {
  let gets = 0;
  const request = {
    get: async () => {
      gets += 1;
      return {
        status: () => status,
        json: async () => body,
        text: async () => JSON.stringify(body),
      };
    },
  } as unknown as APIRequestContext;
  return { request, gets: () => gets };
}

test("componentNodes leaves the notes out, whatever their shape", () => {
  const data = graph([
    node("ChatInput-1", "ChatInput"),
    { id: "note-1", type: "noteNode", data: { type: "note" } },
    { id: "note-2", type: "noteNode" },
  ]);
  assert.deepEqual(
    componentNodes(data).map((n) => n.id),
    ["ChatInput-1"],
  );
});

test("buildableNodes skips tool-mode and hidden nodes and keeps repeated types", () => {
  const data = graph([
    node("Agent-1", "Agent"),
    node("Agent-2", "Agent"),
    node("URL-1", "URLComponent", { node: { tool_mode: true } }),
    node("ChatOutput-1", "ChatOutput", { showNode: false }),
    node("Prompt-1", "Prompt", { showNode: true, node: { tool_mode: false } }),
    { id: "note-1", type: "noteNode" },
  ]);
  assert.deepEqual(buildableNodes(data), [
    { id: "Agent-1", type: "Agent" },
    { id: "Agent-2", type: "Agent" },
    { id: "Prompt-1", type: "Prompt" },
  ]);
});

test("onlyNode returns the single node of a type", () => {
  const data = graph([node("File-1", "File"), node("Agent-1", "Agent")]);
  assert.equal(onlyNode(data, "File", "T").id, "File-1");
});

test("onlyNode throws on zero and on two, naming the template and the count", () => {
  const data = graph([node("Agent-1", "Agent"), node("Agent-2", "Agent")]);
  assert.throws(() => onlyNode(data, "File", "Tpl"), /Template "Tpl" has 0 "File" component/);
  assert.throws(() => onlyNode(data, "Agent", "Tpl"), /Template "Tpl" has 2 "Agent" component/);
});

test("field returns the live field object, so a pin written through it lands in the graph", () => {
  const n = node("Agent-1", "Agent", { node: { template: { model: { value: [] } } } });
  field(n, "model", "T").value = ["pinned"];
  assert.deepEqual(n.data.node?.template?.model?.value, ["pinned"]);
});

test("field throws on a missing field, naming the node and the field", () => {
  const n = node("Agent-1", "Agent", { node: { template: {} } });
  assert.throws(
    () => field(n, "model", "Tpl"),
    /Template "Tpl": node Agent-1 \(Agent\) has no template\.model field/,
  );
});

test("ranField reads the run's live data and never asks for the saved flow", async () => {
  let savedReads = 0;
  const saved = async () => {
    savedReads += 1;
    return graph([node("Agent-1", "Agent", { node: { template: { model: { value: "saved" } } } })]);
  };
  const runBody = {
    data: {
      nodes: [node("Agent-1", "Agent", { node: { template: { model: { value: "live" } } } })],
    },
  };
  assert.equal((await ranField(runBody, saved, "Agent-1", "model"))?.value, "live");
  assert.equal(savedReads, 0);
});

test("ranField falls back to the saved flow when the run carried no data", async () => {
  const saved = async () =>
    graph([
      node("File-1", "File", { node: { template: { path: { value: ["a"], file_path: ["p"] } } } }),
    ]);
  for (const runBody of [null, {}, { data: {} }, { data: { nodes: "not an array" } }]) {
    assert.deepEqual(await ranField(runBody, saved, "File-1", "path"), {
      value: ["a"],
      file_path: ["p"],
    });
  }
});

test("ranField is undefined for an unknown node or field", async () => {
  const runBody = { data: { nodes: [node("Agent-1", "Agent", { node: { template: {} } })] } };
  const saved = async () => graph([]);
  assert.equal(await ranField(runBody, saved, "Agent-2", "model"), undefined);
  assert.equal(await ranField(runBody, saved, "Agent-1", "model"), undefined);
});

test("modelPairs renders every shape a model selector value takes", () => {
  assert.deepEqual(modelPairs([{ name: "gpt-4o-mini", provider: "OpenAI" }]), [
    "gpt-4o-mini / OpenAI",
  ]);
  assert.deepEqual(modelPairs({ name: "m", provider: "P" }), ["m / P"]);
  assert.deepEqual(modelPairs("gpt-4o-mini"), ["gpt-4o-mini"]);
  assert.deepEqual(modelPairs([{ name: "a", provider: "P" }, { name: "b" }]), [
    "a / P",
    "b / undefined",
  ]);
  for (const empty of [undefined, null, "", []]) {
    assert.deepEqual(modelPairs(empty), []);
  }
});

test("readTemplate returns a deep copy, so a pin never reaches the listing", async () => {
  const listing = [
    {
      name: "Basic Prompting",
      description: "d",
      data: { nodes: [node("LM-1", "LanguageModelComponent")], edges: [] },
    },
  ];
  const { request } = fakeRequest(200, listing);
  const first = await readTemplate(request, "Basic Prompting", {});
  first.data.nodes[0].id = "mutated";
  const second = await readTemplate(request, "Basic Prompting", {});
  assert.equal(second.data.nodes[0].id, "LM-1");
  assert.equal(second.description, "d");
});

test("readTemplate names the registered templates when the one asked for is absent", async () => {
  const { request } = fakeRequest(200, [{ name: "A", data: graph([]) }, { name: "B" }]);
  await assert.rejects(readTemplate(request, "C", {}), /Template "C" is not in .*registered: A, B/);
});

test("readTemplate surfaces a non-200 with its status", async () => {
  const { request } = fakeRequest(500, { detail: "boom" });
  await assert.rejects(readTemplate(request, "A", {}), /basic_examples\/ failed: 500/);
});

test("resolveModelOption returns the enabled OpenAI option, untouched", async () => {
  const option = { name: "gpt-4o-mini", provider: "OpenAI", metadata: { k: 1 } };
  const { request } = fakeRequest(200, [{ name: "gpt-4o-mini", provider: "Azure" }, option]);
  assert.deepEqual(await resolveModelOption(request, "gpt-4o-mini", {}), option);
});

test("resolveModelOption throws when the model is not enabled, listing what is", async () => {
  const { request } = fakeRequest(200, [{ name: "gpt-4o", provider: "OpenAI" }]);
  await assert.rejects(
    resolveModelOption(request, "gpt-4o-mini", {}),
    /gpt-4o-mini \/ OpenAI is not an enabled language model.*lists: gpt-4o \/ OpenAI/,
  );
});
