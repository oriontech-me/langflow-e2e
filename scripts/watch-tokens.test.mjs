// Unit tests for the token consumption poller (issue #1197).
// Run with: npm run test:scripts
//
// The backend is faked at the fetch boundary: these tests pin the two behaviours
// that decide whether the numbers are true — the duplicated span pair must not
// double-count (design §2.1), and a trace already seen must never be counted twice.
import { test } from "node:test";
import assert from "node:assert/strict";
import { flattenSpans, spanModelUsage, collectOnce, parseProbeLines } from "./watch-tokens.mjs";

// The exact span shape the spike measured: a component-level llm span with a null
// modelName carrying the SAME usage as the inner provider span.
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

function fakeBackend({ traces, detail, failList = false }) {
  const calls = { list: 0, detail: 0 };
  const fetchImpl = async (url) => {
    if (url.includes("/monitor/traces/")) {
      calls.detail += 1;
      const id = url.split("/monitor/traces/")[1];
      const body = detail[id];
      if (!body) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => body };
    }
    calls.list += 1;
    if (failList) throw new Error("connect ECONNREFUSED");
    return { ok: true, status: 200, json: async () => ({ traces, total: traces.length }) };
  };
  return { fetchImpl, calls };
}

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

test("collectOnce emits one probe per new trace and records its trace total", async () => {
  const { fetchImpl, calls } = fakeBackend({
    traces: [{ id: "t1", flowId: "f1", startTime: "2026-07-31T13:35:38Z", status: "ok", totalTokens: 88 }],
    detail: { t1: { spans: SPANS } },
  });
  const seen = new Set();
  const out = await collectOnce({ fetchImpl, base: "http://x", bearer: "Bearer t", seen });
  assert.equal(out.probes.length, 1);
  assert.equal(out.probes[0].trace_id, "t1");
  assert.equal(out.probes[0].flow_id, "f1");
  assert.equal(out.probes[0].total_tokens, 88);
  assert.deepEqual(out.probes[0].models[0].model, "gpt-4o-mini");
  assert.equal(calls.list, 1);
  assert.equal(calls.detail, 1);
});

test("a trace already seen is not fetched or emitted again", async () => {
  const traces = [{ id: "t1", flowId: "f1", startTime: "x", status: "ok", totalTokens: 88 }];
  const { fetchImpl, calls } = fakeBackend({ traces, detail: { t1: { spans: SPANS } } });
  const seen = new Set();
  await collectOnce({ fetchImpl, base: "http://x", bearer: "b", seen });
  const second = await collectOnce({ fetchImpl, base: "http://x", bearer: "b", seen });
  assert.equal(second.probes.length, 0);
  assert.equal(calls.detail, 1);
});

test("the detail cap bounds one tick, and what it dropped is reported", async () => {
  const traces = Array.from({ length: 5 }, (_, i) => ({
    id: `t${i}`,
    flowId: "f",
    startTime: "x",
    status: "ok",
    totalTokens: 1,
  }));
  const detail = Object.fromEntries(traces.map((t) => [t.id, { spans: SPANS }]));
  const { fetchImpl, calls } = fakeBackend({ traces, detail });
  const out = await collectOnce({ fetchImpl, base: "http://x", bearer: "b", seen: new Set(), detailCap: 2 });
  assert.equal(out.probes.length, 2);
  assert.equal(calls.detail, 2);
  assert.equal(out.deferred, 3);
});

test("a trace whose detail 404s (flow deleted mid-poll) is skipped, not fatal", async () => {
  const { fetchImpl } = fakeBackend({
    traces: [{ id: "gone", flowId: "f", startTime: "x", status: "ok", totalTokens: 5 }],
    detail: {},
  });
  const out = await collectOnce({ fetchImpl, base: "http://x", bearer: "b", seen: new Set() });
  assert.deepEqual(out.probes, []);
  assert.equal(out.errors.length, 1);
});

test("a 401 asks for an auth refresh instead of dying", async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({}) });
  const out = await collectOnce({ fetchImpl, base: "http://x", bearer: "stale", seen: new Set() });
  assert.equal(out.refreshAuth, true);
  assert.deepEqual(out.probes, []);
});

test("a wedged or dead backend produces an error, never a throw", async () => {
  const { fetchImpl } = fakeBackend({ traces: [], detail: {}, failList: true });
  const out = await collectOnce({ fetchImpl, base: "http://x", bearer: "b", seen: new Set() });
  assert.equal(out.probes.length, 0);
  assert.match(out.errors[0], /ECONNREFUSED/);
});

test("parseProbeLines skips a torn last line", () => {
  const probes = parseProbeLines('{"trace_id":"a","total_tokens":1}\n{"trace_id":"b"');
  assert.equal(probes.length, 1);
  assert.equal(probes[0].trace_id, "a");
});
