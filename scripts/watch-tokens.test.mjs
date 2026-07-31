// Unit tests for the token consumption poller (issue #1197).
// Run with: npm run test:scripts
//
// The backend is faked at the fetch boundary: these tests pin the two behaviours
// that decide whether the numbers are true — the duplicated span pair must not
// double-count (design §2.1), and a trace already seen must never be counted twice.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { flattenSpans, spanModelUsage, collectOnce, parseProbeLines, poll } from "./watch-tokens.mjs";

const SCRIPT = fileURLToPath(new URL("./watch-tokens.mjs", import.meta.url));

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

// TOKENS_OUT becoming unwritable mid-run (ENOSPC, permissions, a bad path) must
// degrade the recorder, not crash it — the file's own header promises "always
// exits 0 / never throws out of a tick". Point TOKENS_OUT at a directory: on
// every platform node's fs targets, appendFileSync on a directory throws
// (EISDIR/EPERM), which is the same failure family as a disk going away.
test("an append failure is logged and the loop is not stopped", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tokens-out-"));
  const traces = [{ id: "t1", flowId: "f1", startTime: "x", status: "ok", totalTokens: 88 }];
  const { fetchImpl } = fakeBackend({ traces, detail: { t1: { spans: SPANS } } });
  const logs = [];
  const code = await poll({
    fetchImpl,
    env: {
      TOKENS_BASE_URL: "http://x",
      TOKENS_OUT: dir, // a directory, not a file
      TOKENS_INTERVAL_MS: "10",
      TOKENS_MAX_SECONDS: "0.15",
    },
    log: (msg) => logs.push(msg),
  });
  assert.equal(code, 0);
  assert.ok(
    logs.some((l) => /could not append a probe/.test(l)),
    `expected an append-failure log, got: ${JSON.stringify(logs)}`,
  );
});

// The entry-point guard (`if (import.meta.url === ...)`) only runs when the file
// is executed as the main module, which none of the tests above do — they all
// import the named exports. Spawn the real file to exercise that code path and
// confirm the process still exits 0, even pointed at a backend that refuses
// every connection. This does not force the try/catch's error branch: poll()
// is designed to never throw (every failure is caught and turned into a
// logged `errors[]` entry inside collectOnce/poll itself), so there is no fault
// this test can inject that would reach main()'s catch without mocking poll()
// internals directly — the wrapping is defense-in-depth for an unexpected
// throw, matching watch-backend.mjs's own untested catch branch in main().
test("the entry point exits 0 when run directly, even against an unreachable backend", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tokens-entry-"));
  const out = join(dir, "probes.jsonl");
  const child = spawn(process.execPath, [SCRIPT], {
    env: {
      ...process.env,
      TOKENS_BASE_URL: "http://127.0.0.1:1", // nothing listens here: connection refused
      TOKENS_OUT: out,
      TOKENS_INTERVAL_MS: "50",
      TOKENS_TIMEOUT_MS: "200",
      TOKENS_MAX_SECONDS: "0.3",
    },
    stdio: "ignore",
  });
  const code = await new Promise((resolve) => child.on("exit", resolve));
  assert.equal(code, 0);
});
