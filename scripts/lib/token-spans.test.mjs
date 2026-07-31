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
import { flattenSpans, spanModelUsage, buildProbe } from "./token-spans.mjs";

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
    models: [{ model: "gpt-4o-mini", prompt_tokens: 40, completion_tokens: 48, total_tokens: 88, calls: 1 }],
  });
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
