// Unit tests for the stored-flow predicate behind the MCP toolset wait (#2541, #2576).
// Run with: npm run test:units
//
// What rides on this predicate: whether a spec sends its prompt while every tool call
// would still be refused. A false "persisted" lets the prompt go out early, and the
// run then fails the way #2541 did (three refused calls, an agent that says the tool
// is unavailable), or passes only because the model kept retrying. So the cases below
// pin the refusals as hard as the pass: each one must NOT read as persisted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readToolsetPersistState } from "./wait-for-toolset-persisted";

const agent = { id: "Agent-abc12", data: { type: "Agent", node: {} } };
const mcp = (over: Record<string, unknown> = {}) => ({
  id: "MCP-8tf5p",
  data: { type: "MCP", node: { tool_mode: true } },
  ...over,
});
const toolsEdge = (source = "MCP-8tf5p", target = "Agent-abc12", fieldName = "tools") => ({
  source,
  target,
  data: { targetHandle: { fieldName } },
});
const flow = (nodes: unknown[], edges: unknown[]) => ({ data: { nodes, edges } });

test("the minimal stored-flow shape (MCP node id as measured on 1.14.0.dev35) reads as persisted", () => {
  assert.equal(readToolsetPersistState(flow([agent, mcp()], [toolsEdge()])), "persisted");
});

test("a namespaced MCPTools type is recognised", () => {
  const node = mcp({ id: "ext-node-1", data: { type: "ext:langflow:MCPTools@official", node: { tool_mode: true } } });
  const edge = toolsEdge("ext-node-1");
  assert.equal(readToolsetPersistState(flow([agent, node], [edge])), "persisted");
});

test("a bare MCPTools type is recognised", () => {
  const node = mcp({ data: { type: "MCPTools", node: { tool_mode: true } } });
  assert.equal(readToolsetPersistState(flow([agent, node], [toolsEdge()])), "persisted");
});

test("the id prefix is a fallback for a type rewritten after creation", () => {
  const node = mcp({ data: { type: "SomethingElse", node: { tool_mode: true } } });
  assert.equal(readToolsetPersistState(flow([agent, node], [toolsEdge()])), "persisted");
});

test("a near-miss type or id is not an MCP node", () => {
  for (const [id, type] of [
    ["MCPServer-1", "MCPServer"],
    ["X-1", "MyMCPTools"],
    ["X-2", "ext:vendor:MCPToolsExtra@official"],
  ]) {
    const node = { id, data: { type, node: { tool_mode: true } } };
    assert.equal(readToolsetPersistState(flow([agent, node], [toolsEdge(id)])), "no-mcp-node", type);
  }
});

test("a namespaced Agent type is recognised", () => {
  const nsAgent = { id: "n-1", data: { type: "ext:langflow:Agent@official", node: {} } };
  assert.equal(readToolsetPersistState(flow([nsAgent, mcp()], [toolsEdge("MCP-8tf5p", "n-1")])), "persisted");
});

test("no MCP node, or an unreadable body, reads as no-mcp-node", () => {
  assert.equal(readToolsetPersistState(flow([agent], [])), "no-mcp-node");
  assert.equal(readToolsetPersistState(undefined), "no-mcp-node");
  assert.equal(readToolsetPersistState({}), "no-mcp-node");
});

test("two MCP nodes are refused: the authorization matches one exact node id", () => {
  const second = mcp({ id: "MCP-zzzzz" });
  assert.equal(readToolsetPersistState(flow([agent, mcp(), second], [toolsEdge()])), "no-mcp-node");
});

test("tool mode must be literally true", () => {
  for (const toolMode of [false, undefined, "true", 1]) {
    const node = mcp({ data: { type: "MCP", node: { tool_mode: toolMode } } });
    assert.equal(readToolsetPersistState(flow([agent, node], [toolsEdge()])), "tool-mode-off", String(toolMode));
  }
});

test("an edge into another input of the Agent is not the toolset", () => {
  assert.equal(
    readToolsetPersistState(flow([agent, mcp()], [toolsEdge("MCP-8tf5p", "Agent-abc12", "input_value")])),
    "no-edge-to-agent-tools",
  );
});

test("a node whose id only starts with Agent does not stand in for the Agent", () => {
  const impostor = { id: "AgentQL-x1", data: { type: "AgentQL", node: {} } };
  assert.equal(
    readToolsetPersistState(flow([agent, impostor, mcp()], [toolsEdge("MCP-8tf5p", "AgentQL-x1")])),
    "no-edge-to-agent-tools",
  );
});

test("an edge from another node into the Agent's tools is not the MCP toolset", () => {
  const other = { id: "Calculator-1", data: { type: "Calculator", node: {} } };
  assert.equal(
    readToolsetPersistState(flow([agent, other, mcp()], [toolsEdge("Calculator-1")])),
    "no-edge-to-agent-tools",
  );
});
