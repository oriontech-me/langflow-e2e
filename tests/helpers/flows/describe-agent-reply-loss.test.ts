// Unit tests for describe-agent-reply-loss (#2176).
// Run with: npm run test:units
//
// The helper exists because the VM daily failed
// `mcp-client-agent-gemini-tool-regression` twice with the persisted reply
// `"Echo: hello m"` and nothing else, and the one fact that separates the two
// candidate causes was never recorded. Did the model stop there, or did
// Langflow drop the rest of an answer the model completed? The trace's `llm`
// span keeps the model's full text (LangChain joins string and dict content
// items), while the stored message keeps only what
// `_coerce_ai_message_blocks` let through. So the failure message has to carry
// both.
//
// Two contractual properties, both asserted below:
//
// 1. It NEVER THROWS. It runs on the branch where an assertion is about to
//    fail; a throw here would replace the real failure with its own.
//
// 2. States it could not read are NAMED, never folded into a verdict (#1012).
//    "tracing is off", "the trace had no llm span" and "the trace request
//    failed" are different observations.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { APIRequestContext } from "@playwright/test";
import {
  collectLlmCalls,
  describeAgentReplyLoss,
  readSessionLlmCalls,
  toolOutputText,
} from "./describe-agent-reply-loss";

const PAYLOAD = /hello mcp/i;
const FULL = "Echo: hello mcp (probe-0-1791250691528)";

/** The shape `GET /api/v1/monitor/traces/{id}` returned on 1.13.0.dev33. */
function traceDetail(calls: Array<{ text: string; model: string }>, asString = false) {
  const llmSpans = calls.map((c, i) => {
    const outputs = {
      generations: [[{ text: c.text, generation_info: { finish_reason: "STOP", model_name: c.model } }]],
    };
    return {
      id: `llm-${i}`,
      name: "ChatGoogleGenerativeAI gemini-flash-latest",
      type: "llm",
      modelName: "gemini-flash-latest",
      outputs: asString ? JSON.stringify(outputs) : outputs,
      children: [],
    };
  });
  return {
    spans: [
      { name: "Chat Input", type: "chain", children: [] },
      {
        name: "Agent",
        type: "agent",
        children: [{ name: "Chain", type: "chain", children: llmSpans }],
      },
    ],
  };
}

test("collectLlmCalls returns each llm span's text and SERVED model, nested at any depth", () => {
  const calls = collectLlmCalls(
    traceDetail([
      { text: "", model: "gemini-3.8-flash" },
      { text: FULL, model: "gemini-3.8-flash" },
    ]),
  );
  assert.deepEqual(calls, [
    { text: "", model: "gemini-3.8-flash" },
    { text: FULL, model: "gemini-3.8-flash" },
  ]);
});

test("collectLlmCalls reads outputs serialised as a JSON string", () => {
  const calls = collectLlmCalls(traceDetail([{ text: FULL, model: "gemini-2.5-flash" }], true));
  assert.deepEqual(calls, [{ text: FULL, model: "gemini-2.5-flash" }]);
});

test("collectLlmCalls falls back to the span's requested model when the served one is absent", () => {
  const calls = collectLlmCalls({
    spans: [{ type: "llm", modelName: "gemini-flash-latest", outputs: { generations: [[{ text: "x" }]] } }],
  });
  assert.deepEqual(calls, [{ text: "x", model: "gemini-flash-latest" }]);
});

test("collectLlmCalls never throws on garbage and returns no calls", () => {
  for (const garbage of [null, undefined, 42, "x", { spans: "nope" }, { spans: [{ type: "llm", outputs: "{bad" }] }]) {
    assert.doesNotThrow(() => collectLlmCalls(garbage));
  }
  assert.deepEqual(collectLlmCalls({ spans: [{ type: "llm", outputs: "{bad" }] }), [
    { text: null, model: null },
  ]);
});

test("toolOutputText reads a dumped ToolMessage, a bare string, and nothing else", () => {
  assert.equal(toolOutputText({ content: FULL, type: "tool", name: "echo" }), FULL);
  assert.equal(toolOutputText(FULL), FULL);
  assert.equal(toolOutputText(null), null);
  assert.equal(toolOutputText({ content: [{ type: "text", text: FULL }] }), FULL);
});

test("a non-empty strict prefix of the tool output is named as the #2176 signature", () => {
  const message = describeAgentReplyLoss({
    replyText: "Echo: hello m",
    payload: PAYLOAD,
    toolOutputs: [FULL],
    llm: { available: true, calls: [{ text: FULL, model: "gemini-3.8-flash" }] },
  });
  assert.match(message, /"Echo: hello m"/);
  assert.match(message, new RegExp(FULL.replace(/[()]/g, "\\$&")));
  assert.match(message, /#2176 signature/);
  assert.match(message, /strict prefix/);
  assert.match(message, /_coerce_ai_message_blocks/);
});

test("an LLM text holding the payload beside a reply that lacks it is called a loss inside Langflow", () => {
  const message = describeAgentReplyLoss({
    replyText: "Echo: hello m",
    payload: PAYLOAD,
    toolOutputs: [FULL],
    llm: { available: true, calls: [{ text: FULL, model: "gemini-3.8-flash" }] },
  });
  assert.match(message, /lost inside Langflow/);
});

test("an LLM text that also stops short is NOT called a loss inside Langflow", () => {
  // The model itself returned the short text: the contrast that proves the
  // drop is absent, so the message must not claim it.
  const message = describeAgentReplyLoss({
    replyText: "Echo: hello m",
    payload: PAYLOAD,
    toolOutputs: [FULL],
    llm: { available: true, calls: [{ text: "Echo: hello m", model: "gemini-3.8-flash" }] },
  });
  assert.doesNotMatch(message, /lost inside Langflow/);
  assert.match(message, /the model itself returned/i);
});

test("a served model without gemini-3 is flagged as the trigger, a gemini-3 one is not", () => {
  const legacy = describeAgentReplyLoss({
    replyText: "Echo: hello m",
    payload: PAYLOAD,
    toolOutputs: [FULL],
    llm: { available: true, calls: [{ text: FULL, model: "gemini-2.5-flash" }] },
  });
  assert.match(legacy, /gemini-2\.5-flash/);
  assert.match(legacy, /not a Gemini 3 model/);

  const current = describeAgentReplyLoss({
    replyText: "Echo: hello m",
    payload: PAYLOAD,
    toolOutputs: [FULL],
    llm: { available: true, calls: [{ text: FULL, model: "gemini-3.8-flash" }] },
  });
  assert.doesNotMatch(current, /not a Gemini 3 model/);
});

test("an empty reply is named as ambiguous between #2176 and #2095, not as the #2176 signature", () => {
  const message = describeAgentReplyLoss({
    replyText: "",
    payload: PAYLOAD,
    toolOutputs: [FULL],
    llm: { available: true, calls: [] },
  });
  assert.match(message, /empty/);
  assert.match(message, /#2095/);
  assert.doesNotMatch(message, /#2176 signature/);
});

test("a reply that is not a prefix of the tool output is reported as a different cause", () => {
  const message = describeAgentReplyLoss({
    replyText: "I could not use the tool.",
    payload: PAYLOAD,
    toolOutputs: [FULL],
    llm: { available: true, calls: [] },
  });
  assert.match(message, /not the #2176 signature/);
  assert.match(message, /different cause/);
});

test("a missing tool output is named rather than compared against nothing", () => {
  const message = describeAgentReplyLoss({
    replyText: "Echo: hello m",
    payload: PAYLOAD,
    toolOutputs: [],
    llm: { available: true, calls: [] },
  });
  assert.match(message, /no echo tool output was persisted/);
  assert.doesNotMatch(message, /#2176 signature/);
});

test("an unavailable trace is a named line with its reason, never an omission", () => {
  const message = describeAgentReplyLoss({
    replyText: "Echo: hello m",
    payload: PAYLOAD,
    toolOutputs: [FULL],
    llm: { available: false, reason: "no native trace for this session within 10s" },
  });
  assert.match(message, /LLM calls unavailable: no native trace for this session within 10s/);
});

test("a trace with no llm span says so", () => {
  const message = describeAgentReplyLoss({
    replyText: "Echo: hello m",
    payload: PAYLOAD,
    toolOutputs: [FULL],
    llm: { available: true, calls: [] },
  });
  assert.match(message, /no llm span/);
});

test("describeAgentReplyLoss never throws on hostile input", () => {
  assert.doesNotThrow(() =>
    describeAgentReplyLoss({
      replyText: undefined as unknown as string,
      payload: PAYLOAD,
      toolOutputs: null as unknown as string[],
      llm: null as unknown as { available: false; reason: string },
    }),
  );
});

/** A request context whose GETs answer from `routes`, in call order per path. */
function fakeRequest(routes: Record<string, Array<{ status: number; body: unknown } | Error>>) {
  const seen: string[] = [];
  const request = {
    get: async (url: string) => {
      seen.push(url);
      const path = url.split("?")[0];
      const queue = routes[path];
      const next = queue && queue.length > 1 ? queue.shift()! : queue?.[0];
      if (!next) throw new Error(`unexpected GET ${url}`);
      if (next instanceof Error) throw next;
      return {
        ok: () => next.status >= 200 && next.status < 300,
        status: () => next.status,
        json: async () => next.body,
      };
    },
  } as unknown as APIRequestContext;
  return { request, seen };
}

test("readSessionLlmCalls queries by flow AND session, then reads each trace's detail", async () => {
  const { request, seen } = fakeRequest({
    "/api/v1/monitor/traces": [{ status: 200, body: { traces: [{ id: "t1" }] } }],
    "/api/v1/monitor/traces/t1": [{ status: 200, body: traceDetail([{ text: FULL, model: "gemini-3.8-flash" }]) }],
  });
  const result = await readSessionLlmCalls(request, {
    flowId: "f1",
    sessionId: "s 1",
    headers: {},
    budgetMs: 50,
    intervalMs: 1,
  });
  assert.deepEqual(result, { available: true, calls: [{ text: FULL, model: "gemini-3.8-flash" }] });
  assert.match(seen[0], /flow_id=f1/);
  assert.match(seen[0], /session_id=s%201/);
});

test("readSessionLlmCalls polls until the trace is written", async () => {
  const { request } = fakeRequest({
    "/api/v1/monitor/traces": [
      { status: 200, body: { traces: [] } },
      { status: 200, body: { traces: [{ id: "t1" }] } },
    ],
    "/api/v1/monitor/traces/t1": [{ status: 200, body: traceDetail([{ text: FULL, model: "gemini-3.8-flash" }]) }],
  });
  const result = await readSessionLlmCalls(request, {
    flowId: "f1",
    sessionId: "s1",
    headers: {},
    budgetMs: 1000,
    intervalMs: 1,
  });
  assert.equal(result.available, true);
});

test("readSessionLlmCalls names a session with no trace within the budget", async () => {
  const { request } = fakeRequest({
    "/api/v1/monitor/traces": [{ status: 200, body: { traces: [] } }],
  });
  const result = await readSessionLlmCalls(request, {
    flowId: "f1",
    sessionId: "s1",
    headers: {},
    budgetMs: 20,
    intervalMs: 1,
  });
  assert.equal(result.available, false);
  assert.match((result as { reason: string }).reason, /no native trace for this session/);
  assert.match((result as { reason: string }).reason, /LANGFLOW_DEACTIVATE_TRACING/);
});

test("readSessionLlmCalls names a failing list request and a throwing transport, never throws", async () => {
  const failing = fakeRequest({ "/api/v1/monitor/traces": [{ status: 500, body: {} }] });
  const r1 = await readSessionLlmCalls(failing.request, {
    flowId: "f1",
    sessionId: "s1",
    headers: {},
    budgetMs: 20,
    intervalMs: 1,
  });
  assert.equal(r1.available, false);
  assert.match((r1 as { reason: string }).reason, /500/);

  const throwing = fakeRequest({ "/api/v1/monitor/traces": [new Error("socket hang up")] });
  const r2 = await readSessionLlmCalls(throwing.request, {
    flowId: "f1",
    sessionId: "s1",
    headers: {},
    budgetMs: 20,
    intervalMs: 1,
  });
  assert.equal(r2.available, false);
  assert.match((r2 as { reason: string }).reason, /socket hang up/);
});
