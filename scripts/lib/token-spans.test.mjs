// Unit tests for the shared span/probe logic (issue #1197).
// Run with: npm run test:scripts
//
// Moved here from scripts/watch-tokens.test.mjs (#1197 re-review, finding A):
// this module is now imported by BOTH the poller (scripts/watch-tokens.mjs)
// and the attribution sidecar (tests/helpers/flows/token-attribution.ts, via a
// dynamic import — see that file's own comment), so its rules are tested once,
// independent of either caller.
import { test } from "node:test";
import assert from "node:assert/strict";
import { flattenSpans, spanModelUsage, spanUnmeasured, spanProvider, buildProbe } from "./token-spans.mjs";

// The exact span shape the spike measured: a component-level llm span with a
// null modelName carrying the SAME usage as the inner provider span.
const SPANS = [
  { name: "Chat Input", type: "chain", modelName: null, tokenUsage: null },
  {
    name: "Language Model",
    type: "llm",
    modelName: null,
    tokenUsage: { promptTokens: 40, completionTokens: 48, totalTokens: 88 },
  },
  {
    name: "ChatOpenAI gpt-4o-mini",
    type: "llm",
    modelName: "gpt-4o-mini",
    tokenUsage: { promptTokens: 40, completionTokens: 48, totalTokens: 88 },
  },
];

test("flattenSpans walks nested children", () => {
  const flat = flattenSpans([{ name: "a", children: [{ name: "b", children: [{ name: "c" }] }] }]);
  assert.deepEqual(flat.map((s) => s.name), ["a", "b", "c"]);
});

test("spanModelUsage counts the provider span ONLY — no double count", () => {
  const usage = spanModelUsage(SPANS);
  assert.equal(usage.length, 1);
  assert.deepEqual(usage[0], {
    model: "gpt-4o-mini",
    provider: "openai",
    prompt_tokens: 40,
    completion_tokens: 48,
    total_tokens: 88,
    calls: 1,
  });
});

test("spanModelUsage sums two calls to the same model within one trace", () => {
  const usage = spanModelUsage([...SPANS, SPANS[2]]);
  assert.equal(usage.length, 1);
  assert.equal(usage[0].calls, 2);
  assert.equal(usage[0].total_tokens, 176);
});

test("spanModelUsage ignores a model span with no usage", () => {
  assert.deepEqual(spanModelUsage([{ type: "llm", modelName: "x", tokenUsage: null }]), []);
});

test("buildProbe assembles the standard probe shape from a trace + its spans", () => {
  const trace = { id: "t1", flowId: "f1", startTime: "2026-07-31T13:35:38Z", status: "ok", totalTokens: 88 };
  assert.deepEqual(buildProbe(trace, SPANS), {
    trace_id: "t1",
    flow_id: "f1",
    start_time: "2026-07-31T13:35:38Z",
    status: "ok",
    total_tokens: 88,
    models: [{ model: "gpt-4o-mini", provider: "openai", prompt_tokens: 40, completion_tokens: 48, total_tokens: 88, calls: 1 }],
  });
  assert.ok(!("unmeasured" in buildProbe(trace, SPANS)), "a fully measured trace keeps the pre-#2288 shape");
});

// #1197 review, finding I3 — buildProbe is where BOTH callers get this rule
// from, so it is covered here rather than duplicated per caller.
test("buildProbe records total_tokens: null when the trace's own total is unknown, not 0", () => {
  const probe = buildProbe({ id: "t1" }, SPANS);
  assert.equal(probe.total_tokens, null);
});

// #1197 re-review, finding A — a detail fetch that never happened (or failed)
// must degrade to `models: []`, not throw or invent a shape difference from
// the "detail succeeded" case.
test("buildProbe degrades to models: [] when spans are unavailable", () => {
  const probe = buildProbe({ id: "t1", totalTokens: 50 }, undefined);
  assert.equal(probe.total_tokens, 50);
  assert.deepEqual(probe.models, []);
});

// ─── Unmeasured calls and the span's provider (#2288) ────────────────────────
// Shaped like the Azure AI Foundry trace measured on 1.13.0.dev44: the provider
// span names its model and carries an all-zero usage object.

const FOUNDRY_SPANS = [
  { name: "Agent", type: "agent", modelName: null, tokenUsage: null },
  {
    name: "AzureAIOpenAIApiChatModel gpt-5.6-sol",
    type: "llm",
    modelName: "gpt-5.6-sol",
    tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  },
];

test("a named span with all-zero usage is an unmeasured call, not a free one", () => {
  assert.deepEqual(spanModelUsage(FOUNDRY_SPANS), [], "no zero-token row");
  assert.deepEqual(spanUnmeasured(FOUNDRY_SPANS), [{ model: "gpt-5.6-sol", provider: "azure", calls: 1 }]);
  const probe = buildProbe({ id: "t1", totalTokens: 0 }, [...FOUNDRY_SPANS, FOUNDRY_SPANS[1]]);
  assert.deepEqual(probe.models, []);
  assert.deepEqual(probe.unmeasured, [{ model: "gpt-5.6-sol", provider: "azure", calls: 2 }]);
});

test("a span with no usage object at all is neither measured nor unmeasured", () => {
  // The shape of a span Langflow never filled: counting it would invent calls.
  assert.deepEqual(spanUnmeasured([{ type: "llm", modelName: "x", tokenUsage: null }]), []);
  assert.deepEqual(spanUnmeasured(SPANS), [], "the null-model component span is not a call either");
});

test("the provider comes from the span's class, so one id billed by two accounts stays two entries", () => {
  const openaiCall = {
    name: "ChatOpenAI gpt-5.6-sol",
    type: "llm",
    modelName: "gpt-5.6-sol",
    tokenUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
  };
  const foundryCall = { ...openaiCall, name: "AzureAIOpenAIApiChatModel gpt-5.6-sol" };
  assert.deepEqual(
    spanModelUsage([openaiCall, foundryCall]).map((m) => [m.model, m.provider, m.total_tokens]),
    [
      ["gpt-5.6-sol", "openai", 15],
      ["gpt-5.6-sol", "azure", 15],
    ],
  );
});

test("each span class measured on a real trace maps to its billing provider; any other to none", () => {
  for (const [name, provider] of [
    ["ChatOpenAI gpt-4o-mini", "openai"],
    ["ChatAnthropic claude-haiku-4-5", "anthropic"],
    ["ChatGoogleGenerativeAI gemini-2.5-flash", "google"],
    ["AzureAIOpenAIApiChatModel gpt-5.6-sol", "azure"],
    ["ChatOllama llama3.2:1b", null],
    ["toString gpt-4o", null],
    ["", null],
  ]) {
    assert.equal(spanProvider({ name }), provider, name);
  }
  // An entry with no known class keeps the pre-#2288 shape: no provider key at all.
  const unknown = spanModelUsage([{ name: "ChatOllama llama3.2:1b", type: "llm", modelName: "llama3.2:1b", tokenUsage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }]);
  assert.ok(!("provider" in unknown[0]));
});

test("a call that did not answer reads {0, 0, 0} too, and is not unmeasured", () => {
  // Langflow ends a failed LLM span with error=str(exception) and no counts, keeping
  // its model name (native_callback.py _handle_error; native.py sets ERROR only for a
  // truthy error). The shapes it actually produces:
  const failed = [
    // a 401, a drained key, a 429
    { ...FOUNDRY_SPANS[1], name: "ChatOpenAI gpt-4o-mini", modelName: "gpt-4o-mini", status: "error", error: "Error code: 401" },
    // a Stop-button cancellation: str(CancelledError()) is "", so status stays ok
    { ...FOUNDRY_SPANS[1], name: "ChatOpenAI gpt-4o", modelName: "gpt-4o", status: "ok", error: "" },
    // defensive: an error status with no message recorded
    { ...FOUNDRY_SPANS[1], name: "ChatAnthropic claude-haiku-4-5", modelName: "claude-haiku-4-5", status: "error", error: null },
  ];
  assert.deepEqual(spanUnmeasured(failed), []);
  assert.ok(!("unmeasured" in buildProbe({ id: "t", totalTokens: 0 }, failed)));
  // The Foundry span that ANSWERED is still unmeasured beside them.
  assert.deepEqual(spanUnmeasured([...failed, { ...FOUNDRY_SPANS[1], status: "ok", error: null }]).map((u) => u.model), ["gpt-5.6-sol"]);
});
