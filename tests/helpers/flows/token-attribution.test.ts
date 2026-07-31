// Unit tests for the token attribution sidecar (issue #1197).
// Run with: npm run test:units
//
// What rides on this helper: it is the only thing that can name WHICH spec spent
// the tokens, because a trace 404s the moment its flow is deleted (design §2, S4).
// It runs inside `cleanup()`, so its hard requirement is the inverse of a test
// helper's: it must never throw, never slow the teardown, and never be the reason a
// green test goes red.
//
// #1197 re-review, finding A: a real daily-stable run proved 5 of 6 attributed
// traces never reached the poller's own probe file, so their tokens were lost
// from `totals` entirely. The sidecar now fetches its own detail (one extra
// `GET` per trace it found — still bounded, still not polling) and writes a
// full probe shape ALONGSIDE the attribution fields in the same line, via
// `buildProbe()` — the shared, pure function in scripts/lib/token-spans.mjs
// that both this sidecar and the poller import, so the anti-double-count rule
// lives in exactly one place.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { APIRequestContext } from "@playwright/test";
import { recordTokenAttribution } from "./token-attribution";

function tmpFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "attrib-")), "token-attrib.jsonl");
}

// The exact span shape the spike measured (mirrors scripts/lib/token-spans.test.mjs):
// a component-level llm span with a null modelName carrying the SAME usage as
// the inner provider span — spanModelUsage must count it once, not twice.
const SPANS = [
  { modelName: null, tokenUsage: { promptTokens: 40, completionTokens: 48, totalTokens: 88 } },
  { modelName: "gpt-4o-mini", tokenUsage: { promptTokens: 40, completionTokens: 48, totalTokens: 88 } },
];

interface FakeTrace {
  id: string;
  totalTokens?: number;
  flowId?: string;
  startTime?: string;
  status?: string;
}

/**
 * Fakes BOTH endpoints the sidecar now calls: the list
 * (`/api/v1/monitor/traces?flow_id=...`) and, per trace found, the detail
 * (`/api/v1/monitor/traces/{id}`). A trace id absent from `detail` behaves
 * like a real 404 — the flow raced ahead and deleted that trace too (S4).
 */
function fakeRequest(
  traces: Record<string, FakeTrace[]>,
  detail: Record<string, { spans?: unknown[] }> = {},
  opts: { fail?: boolean } = {},
): APIRequestContext {
  return {
    get: async (url: string) => {
      if (opts.fail) throw new Error("backend wedged");
      if (url.includes("?flow_id=")) {
        const flowId = new URL(url, "http://x").searchParams.get("flow_id") ?? "";
        return { ok: () => true, status: () => 200, json: async () => ({ traces: traces[flowId] ?? [] }) };
      }
      // Detail endpoint: /api/v1/monitor/traces/{id}
      const id = url.split("/monitor/traces/")[1];
      const body = detail[id];
      if (!body) return { ok: () => false, status: () => 404, json: async () => ({}) };
      return { ok: () => true, status: () => 200, json: async () => body };
    },
  } as unknown as APIRequestContext;
}

test("writes one self-sufficient line per trace — trace_id, flow_id, its own tokens, AND the attribution fields (finding A)", async () => {
  const out = tmpFile();
  const request = fakeRequest(
    { f1: [{ id: "t1", totalTokens: 88, startTime: "2026-07-31T13:35:38Z", status: "ok" }, { id: "t2", totalTokens: 50 }] },
    { t1: { spans: SPANS }, t2: { spans: [] } },
  );
  const result = await recordTokenAttribution({
    request,
    flowIds: ["f1"],
    test: "agent suite",
    file: "x.spec.ts",
    out,
  });
  assert.equal(result.recorded, 2);
  const lines = fs.readFileSync(out, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines[0], {
    trace_id: "t1",
    flow_id: "f1",
    start_time: "2026-07-31T13:35:38Z",
    status: "ok",
    total_tokens: 88,
    models: [{ model: "gpt-4o-mini", prompt_tokens: 40, completion_tokens: 48, total_tokens: 88, calls: 1 }],
    test: "agent suite",
    file: "x.spec.ts",
  });
  assert.equal(lines[1].trace_id, "t2");
  assert.equal(lines[1].total_tokens, 50);
  assert.deepEqual(lines[1].models, []);
});

test("does nothing at all when the out path is unset — no request, no file", async () => {
  let called = false;
  const request = {
    get: async () => {
      called = true;
      throw new Error("should not be called");
    },
  } as unknown as APIRequestContext;
  const result = await recordTokenAttribution({
    request,
    flowIds: ["f1"],
    test: "t",
    file: "f",
    out: undefined,
  });
  assert.deepEqual(result, { recorded: 0, skipped: [] });
  assert.equal(called, false);
});

test("a failing backend is reported on the result, never thrown", async () => {
  const out = tmpFile();
  const request = fakeRequest({}, {}, { fail: true });
  const result = await recordTokenAttribution({
    request,
    flowIds: ["f1"],
    test: "t",
    file: "f",
    out,
  });
  assert.equal(result.recorded, 0);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0], /f1/);
});

test("an unwritable out path is reported, never thrown", async () => {
  const request = fakeRequest({ f1: [{ id: "t1" }] }, { t1: { spans: [] } });
  const result = await recordTokenAttribution({
    request,
    flowIds: ["f1"],
    test: "t",
    file: "f",
    out: "/proc/definitely/not/writable/x.jsonl",
  });
  assert.equal(result.recorded, 0);
  assert.equal(result.skipped.length, 1);
});

// #1197 review, finding I8: the sidecar used to call `res.json()` regardless of
// `res.ok()`. Langflow answers an unauthenticated/forbidden request with a JSON
// body too (e.g. 403 `{"detail": "Not authenticated"}`), so `body.traces` was
// `undefined`, the loop `continue`d, and the result read exactly like "no
// traces yet" — `{recorded: 0, skipped: []}` — with no warning anywhere. That
// is the exact regression the bearer-token fix (#1197 §S2) exists to catch.
test("a non-ok response (e.g. 403 unauthenticated) is reported, never read as zero traces", async () => {
  const out = tmpFile();
  const request = {
    get: async () => ({
      ok: () => false,
      status: () => 403,
      json: async () => ({ detail: "Not authenticated" }),
    }),
  } as unknown as APIRequestContext;
  const result = await recordTokenAttribution({ request, flowIds: ["f1"], test: "t", file: "f", out });
  assert.equal(result.recorded, 0);
  assert.deepEqual(result.skipped, ["f1: HTTP 403"]);
  assert.equal(fs.existsSync(out), false, "nothing should be written when every flow was skipped");
});

test("a flow with no trace yet is simply not recorded — no polling", async () => {
  const out = tmpFile();
  const request = fakeRequest({ f1: [] });
  const result = await recordTokenAttribution({ request, flowIds: ["f1"], test: "t", file: "f", out });
  assert.equal(result.recorded, 0);
  assert.equal(result.skipped.length, 0);
});

test("appends rather than truncating, so parallel workers coexist", async () => {
  const out = tmpFile();
  const request = fakeRequest(
    { f1: [{ id: "t1" }], f2: [{ id: "t2" }] },
    { t1: { spans: [] }, t2: { spans: [] } },
  );
  await recordTokenAttribution({ request, flowIds: ["f1"], test: "a", file: "a.spec.ts", out });
  await recordTokenAttribution({ request, flowIds: ["f2"], test: "b", file: "b.spec.ts", out });
  assert.equal(fs.readFileSync(out, "utf8").trim().split("\n").length, 2);
});

// --- Finding A (#1197 re-review) ---

test("a detail-fetch failure still yields a line for that trace, with a null total, not a lost line", async () => {
  const out = tmpFile();
  // No totalTokens on the list item, and no detail entry for "t1" → the
  // detail GET behaves like a real 404 (the flow raced ahead and deleted this
  // trace too, S4).
  const request = fakeRequest({ f1: [{ id: "t1" }] }, {});
  const result = await recordTokenAttribution({ request, flowIds: ["f1"], test: "t", file: "f.spec.ts", out });
  assert.equal(result.recorded, 1, "the line must still be written, not lost");
  const lines = fs.readFileSync(out, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].trace_id, "t1");
  assert.equal(lines[0].total_tokens, null);
  assert.deepEqual(lines[0].models, []);
  assert.equal(lines[0].test, "t");
  assert.equal(lines[0].file, "f.spec.ts");
});

test("a detail-fetch failure still keeps the trace's own total already in hand from the list response", async () => {
  const out = tmpFile();
  // The list response already carries totalTokens — buildProbe uses that
  // regardless of whether the (separate) detail fetch for spans succeeds.
  const request = fakeRequest({ f1: [{ id: "t1", totalTokens: 500 }] }, {});
  const result = await recordTokenAttribution({ request, flowIds: ["f1"], test: "t", file: "f.spec.ts", out });
  assert.equal(result.recorded, 1);
  const lines = fs.readFileSync(out, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines[0].total_tokens, 500, "the list's own total must survive a failed detail fetch");
  assert.deepEqual(lines[0].models, [], "without spans, the model breakdown degrades to empty, not an error");
});

test("a network error fetching ONE trace's detail degrades that trace only — the rest of the flow is unaffected", async () => {
  const out = tmpFile();
  const request = {
    get: async (url: string) => {
      if (url.includes("?flow_id=")) {
        return {
          ok: () => true,
          status: () => 200,
          json: async () => ({
            traces: [
              { id: "t1", totalTokens: 10 },
              { id: "t2", totalTokens: 20 },
            ],
          }),
        };
      }
      if (url.endsWith("/t1")) throw new Error("ECONNRESET");
      return { ok: () => true, status: () => 200, json: async () => ({ spans: [] }) };
    },
  } as unknown as APIRequestContext;
  const result = await recordTokenAttribution({ request, flowIds: ["f1"], test: "t", file: "f.spec.ts", out });
  assert.equal(result.recorded, 2, "both traces must still produce a line");
  const lines = fs.readFileSync(out, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines[0].total_tokens, 10);
  assert.deepEqual(lines[0].models, []);
  assert.equal(lines[1].total_tokens, 20);
});

// #1197 re-review, "Important": the dynamic `import()` that loads `buildProbe`
// sat OUTSIDE every try/catch, at the top of `recordTokenAttribution` — a
// rejection there (module moved, fd exhaustion, a transient resolution
// failure) propagated straight out of this function. `cleanup()` in
// track-created-flows.ts awaits this call with no try/catch of its own, on
// the stated assumption that it "cannot throw" — so an unguarded import
// failure would have failed the calling spec's teardown as an unrelated
// random failure, in a helper 28 specs depend on. Forcing a REAL import
// failure reliably from a test is impractical, so `loadBuildProbe` is
// injectable — unit tests only, per its doc comment.
test("a failing buildProbe import degrades to a named skip — never a silent {recorded: 0, skipped: []}", async () => {
  const out = tmpFile();
  const request = fakeRequest({ f1: [{ id: "t1", totalTokens: 88 }] }, { t1: { spans: SPANS } });
  const result = await recordTokenAttribution({
    request,
    flowIds: ["f1"],
    test: "t",
    file: "f.spec.ts",
    out,
    loadBuildProbe: async () => {
      throw new Error("Cannot find module '../../../scripts/lib/token-spans.mjs'");
    },
  });
  assert.equal(result.recorded, 0);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0], /buildProbe import failed/);
  assert.match(result.skipped[0], /Cannot find module/);
  assert.equal(fs.existsSync(out), false, "no file must be written when the import itself fails");
});
