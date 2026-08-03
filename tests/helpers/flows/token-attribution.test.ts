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
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { APIRequestContext } from "@playwright/test";
import { recordTokenAttribution, resetAttributedFlows } from "./token-attribution";

function tmpFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "attrib-")), "token-attrib.jsonl");
}

// The JSONL file now carries TWO record shapes (§4.3, fix round 2): one line per
// attributed trace, plus exactly ONE `kind: "attrib_cost"` record per call. Splitting
// them here keeps every assertion below about the shape it means.
function readRecords(out: string): Array<Record<string, unknown>> {
  return fs
    .readFileSync(out, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}
function traceLines(out: string): Array<Record<string, unknown>> {
  return readRecords(out).filter((r) => r.kind !== "attrib_cost");
}
function costRecords(out: string): Array<Record<string, unknown>> {
  return readRecords(out).filter((r) => r.kind === "attrib_cost");
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

// §2.1: reset the attempted-flow guard before each test, ensuring tests are
// isolated by default. Tests that exercise cross-call persistence (calling
// recordTokenAttribution twice within a single test) are unaffected — the reset
// happens before the test, not between calls within it.
beforeEach(() => {
  resetAttributedFlows();
});

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
  const lines = traceLines(out);
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
  // Two entries, both named, neither thrown: the flow's own trace line and the cost
  // record are separate appends to the same unwritable path (§4.3, fix round 2).
  // Silence on the second would make an unwritable path look like a free teardown.
  assert.equal(result.skipped.length, 2, JSON.stringify(result.skipped));
  assert.match(result.skipped[0], /^f1: /);
  assert.match(result.skipped[1], /^attrib_cost: /);
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
  // No TRACE line — that part is unchanged. But the cost record IS written now
  // (§4.3, fix round 2): a 403 list request still cost a round trip, and the whole
  // point of the new shape is that a teardown which attributed nothing is exactly the
  // case the old per-line field was blind to.
  assert.deepEqual(traceLines(out), [], "a skipped flow must still produce no trace line");
  assert.equal(costRecords(out).length, 1, "the request was paid for, so its cost must be recorded");
});

test("a flow with no trace yet is simply not recorded — no polling", async () => {
  const out = tmpFile();
  let getCalls = 0;
  const baseRequest = fakeRequest({ f1: [] });
  const request = {
    get: async (url: string) => {
      getCalls++;
      return baseRequest.get(url);
    },
  } as unknown as APIRequestContext;
  const result = await recordTokenAttribution({ request, flowIds: ["f1"], test: "t", file: "f", out });
  assert.equal(result.recorded, 0);
  assert.equal(result.skipped.length, 0);
  assert.equal(getCalls, 1, "the list request must be issued, not short-circuited by the guard");
});

test("appends rather than truncating, so parallel workers coexist", async () => {
  const out = tmpFile();
  const request = fakeRequest(
    { f1: [{ id: "t1" }], f2: [{ id: "t2" }] },
    { t1: { spans: [] }, t2: { spans: [] } },
  );
  await recordTokenAttribution({ request, flowIds: ["f1"], test: "a", file: "a.spec.ts", out });
  await recordTokenAttribution({ request, flowIds: ["f2"], test: "b", file: "b.spec.ts", out });
  assert.equal(traceLines(out).length, 2, "one line per attributed trace, from both calls");
  assert.equal(costRecords(out).length, 2, "one cost record per CALL — two calls, two records");
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
  const lines = traceLines(out);
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
  const lines = traceLines(out);
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
  const lines = traceLines(out);
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

// §2.1: the anti-double-count guard. `cleanup()` attributes the whole captured
// batch (track-created-flows.ts:263) and then calls `deleteFlow` per id (:296).
// Once `deleteFlow` carries its own hook, every tracked spec's flows arrive here
// twice. Two lines for one trace is not a visible defect downstream -- it is a
// plausible number, twice as large, with no marker saying so.
test("a flow already attempted is never attributed a second time (§2.1)", async () => {
  const out = tmpFile();
  const request = fakeRequest({ f1: [{ id: "t1", totalTokens: 88 }] }, { t1: { spans: SPANS } });
  const args = { request, flowIds: ["f1"], test: "spec", file: "x.spec.ts", out };

  const first = await recordTokenAttribution(args);
  const second = await recordTokenAttribution(args);

  assert.equal(first.recorded, 1);
  assert.equal(second.recorded, 0, "the second pass must record nothing for the same flow");
  assert.equal(traceLines(out).length, 1, "exactly one line for one trace, across both passes");
  // Two CALLS were made, so two teardowns paid a cost — the second one being cheap
  // (it issued no request) is a fact about the run, not a reason to hide it.
  assert.equal(costRecords(out).length, 2, "one cost record per call, including the one that re-attributed nothing");
});

// ATTEMPTED, not RECORDED. The contract is one list request per flow, never
// retried (Global Constraints) -- so a flow whose list came back 403 is spent, not
// eligible for a second try. Recording it as "attempted" is what keeps a failure
// from silently turning into the retry the no-polling rule forbids.
test("a flow whose list request failed is still not retried on a second pass (§2.1)", async () => {
  const out = tmpFile();
  let calls = 0;
  const request = {
    get: async () => {
      calls += 1;
      return { ok: () => false, status: () => 403, json: async () => ({ detail: "Not authenticated" }) };
    },
  } as unknown as APIRequestContext;
  const args = { request, flowIds: ["f1"], test: "spec", file: "x.spec.ts", out };

  const first = await recordTokenAttribution(args);
  const second = await recordTokenAttribution(args);

  assert.deepEqual(first.skipped, ["f1: HTTP 403"]);
  assert.equal(calls, 1, "the second pass must not issue another list request");
  assert.equal(second.recorded, 0);
  assert.deepEqual(second.skipped, [], "already-attempted is not a new failure to report");
});

test("resetAttributedFlows clears the guard, so a fresh worker starts clean", async () => {
  resetAttributedFlows();
  const out = tmpFile();
  const request = fakeRequest({ f1: [{ id: "t1", totalTokens: 10 }] }, { t1: { spans: [] } });
  const args = { request, flowIds: ["f1"], test: "spec", file: "x.spec.ts", out };
  assert.equal((await recordTokenAttribution(args)).recorded, 1);
  resetAttributedFlows();
  assert.equal((await recordTokenAttribution(args)).recorded, 1);
});

// --- §4: bounding the teardown cost, and measuring it ---

// §4.2: the per-flow loop was strictly serial, so N flows cost N round trips on
// the teardown path of nearly every spec in the suite. Concurrency collapses that
// to roughly one round trip regardless of flow count.
test("reads every flow's traces concurrently, not one round trip per flow (§4.2)", async () => {
  const out = tmpFile();
  let inFlight = 0;
  let peak = 0;
  const request = {
    get: async (url: string) => {
      if (url.includes("?flow_id=")) {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 10));
        inFlight -= 1;
        const flowId = new URL(url, "http://x").searchParams.get("flow_id") ?? "";
        return { ok: () => true, status: () => 200, json: async () => ({ traces: [{ id: `t-${flowId}`, totalTokens: 5 }] }) };
      }
      return { ok: () => true, status: () => 200, json: async () => ({ spans: [] }) };
    },
  } as unknown as APIRequestContext;

  const result = await recordTokenAttribution({
    request,
    flowIds: ["f1", "f2", "f3"],
    test: "spec",
    file: "x.spec.ts",
    out,
  });

  assert.equal(result.recorded, 3);
  assert.ok(peak > 1, `the list requests must overlap; peak concurrency was ${peak}`);
  // Every line is whole and parseable after three concurrent appends. This is
  // necessary but NOT sufficient evidence for the synchronous-append claim -- an
  // awaited async append would satisfy it too. The mechanism itself is pinned by
  // "the sidecar appends synchronously" below.
  const raw = fs.readFileSync(out, "utf8").trim().split("\n");
  for (const line of raw) assert.doesNotThrow(() => JSON.parse(line));
  assert.equal(traceLines(out).length, 3);
  assert.equal(costRecords(out).length, 1, "one cost record for the whole call, not one per flow");
});

// §4.2: an explicit numeric zero means the per-model spans buy nothing. Absent or
// null means NOT YET COMPUTED, which is the whole reason for the
// total_tokens: null-not-0 rule (#1197 review, finding I3) -- conflating the two
// would discard a real trace whose total simply had not landed.
test("skips the detail fetch on totalTokens === 0, but never on absent or null (§4.2)", async () => {
  const details: string[] = [];
  const request = {
    get: async (url: string) => {
      if (url.includes("?flow_id=")) {
        const flowId = new URL(url, "http://x").searchParams.get("flow_id") ?? "";
        const byFlow: Record<string, Array<Record<string, unknown>>> = {
          zero: [{ id: "t-zero", totalTokens: 0 }],
          absent: [{ id: "t-absent" }],
          nulled: [{ id: "t-null", totalTokens: null }],
        };
        return { ok: () => true, status: () => 200, json: async () => ({ traces: byFlow[flowId] ?? [] }) };
      }
      details.push(url);
      return { ok: () => true, status: () => 200, json: async () => ({ spans: [] }) };
    },
  } as unknown as APIRequestContext;

  await recordTokenAttribution({
    request,
    flowIds: ["zero", "absent", "nulled"],
    test: "spec",
    file: "x.spec.ts",
    out: tmpFile(),
  });

  assert.equal(details.some((u) => u.endsWith("t-zero")), false, "an explicit 0 needs no spans");
  assert.equal(details.some((u) => u.endsWith("t-absent")), true, "absent means unknown, so fetch");
  assert.equal(details.some((u) => u.endsWith("t-null")), true, "null means unknown, so fetch");
});

// §4.2: EVERY request the sidecar makes must carry a timeout. Without one,
// Playwright's 30s default applies, and a wedged monitor endpoint during teardown
// eats the test's 5-minute budget inside afterEach -- so `request.delete` never
// runs and the flow leaks silently. That is the failure `deleteFlow` exists to
// prevent, caused by telemetry. A wall-clock deadline checked BETWEEN requests
// cannot bound a request that never returns; only a per-request timeout can.
test("every request carries the timeout, list and detail alike (§4.2)", async () => {
  const seen: Array<{ url: string; timeout?: number }> = [];
  const request = {
    get: async (url: string, opts?: { timeout?: number }) => {
      seen.push({ url, timeout: opts?.timeout });
      if (url.includes("?flow_id=")) {
        return { ok: () => true, status: () => 200, json: async () => ({ traces: [{ id: "t1" }] }) };
      }
      return { ok: () => true, status: () => 200, json: async () => ({ spans: [] }) };
    },
  } as unknown as APIRequestContext;

  await recordTokenAttribution({
    request,
    flowIds: ["f1"],
    test: "spec",
    file: "x.spec.ts",
    out: tmpFile(),
    timeoutMs: 1234,
  });

  assert.equal(seen.length, 2, "one list request plus one detail request");
  for (const call of seen) {
    assert.equal(call.timeout, 1234, `${call.url} was issued without the timeout`);
  }
});

test("the timeout defaults to TOKENS_TIMEOUT_MS, then to 8000 (§4.2)", async (t) => {
  const seen: number[] = [];
  const request = {
    get: async (url: string, opts?: { timeout?: number }) => {
      seen.push(opts?.timeout as number);
      if (url.includes("?flow_id=")) {
        return { ok: () => true, status: () => 200, json: async () => ({ traces: [{ id: "t1" }] }) };
      }
      return { ok: () => true, status: () => 200, json: async () => ({ spans: [] }) };
    },
  } as unknown as APIRequestContext;
  const args = { request, flowIds: ["f1"], test: "spec", file: "x.spec.ts", out: tmpFile() };

  process.env.TOKENS_TIMEOUT_MS = "500";
  t.after(() => delete process.env.TOKENS_TIMEOUT_MS);
  await recordTokenAttribution(args);
  assert.deepEqual(seen, [500, 500], "the lane's own value must be honoured");

  delete process.env.TOKENS_TIMEOUT_MS;
  resetAttributedFlows();
  seen.length = 0;
  await recordTokenAttribution({ ...args, flowIds: ["f2"] });
  assert.deepEqual(seen, [8000, 8000], "the default must match the poller's DEFAULTS.timeoutMs");
});

// §4.2: the detail fan-out is the unbounded part -- one fetch per trace, and a
// flow can carry many. The poller caps its own at TOKENS_DETAIL_CAP (25); the
// sidecar adopts the same knob rather than inventing a third. Counted, so this is
// deterministic and needs no sleep.
test("stops fetching detail at the cap and names what it skipped (§4.2)", async () => {
  let detailCalls = 0;
  const request = {
    get: async (url: string) => {
      if (url.includes("?flow_id=")) {
        return {
          ok: () => true,
          status: () => 200,
          json: async () => ({ traces: [{ id: "t1" }, { id: "t2" }, { id: "t3" }] }),
        };
      }
      detailCalls += 1;
      return { ok: () => true, status: () => 200, json: async () => ({ spans: [] }) };
    },
  } as unknown as APIRequestContext;

  const result = await recordTokenAttribution({
    request,
    flowIds: ["f1"],
    test: "spec",
    file: "x.spec.ts",
    out: tmpFile(),
    detailCap: 2,
  });

  assert.equal(detailCalls, 2, "the cap must stop the fan-out");
  // Named, not silent. Dropping the spans quietly would leave `models: []` on a
  // trace whose tokens are unknown -- identical to a trace whose detail genuinely
  // came back empty, so the line would read as complete.
  assert.ok(
    result.skipped.some((s) => s.includes("detail cap")),
    `the cap must name itself on skipped; got ${JSON.stringify(result.skipped)}`,
  );
  // The capped trace still contributes its own total_tokens -- the cap costs the
  // per-model breakdown, never the tokens.
  assert.equal(result.recorded, 3, "every trace is still recorded, capped or not");
});

// --- §4.3, fix round 2: ONE cost record per CALL ---
//
// The previous shape put a per-FLOW `attrib_ms` on every trace line and could not
// measure what §4.3 exists to measure, twice over:
//
//   - a flow that produced NO traces wrote no line, so it cost nothing on paper --
//     yet §4.1's dominant cost is "one list request per deleted flow, paid even by
//     specs that burn nothing", i.e. exactly the ~140 UI specs whose single GET each
//     IS the cost. The artifact was blind to all of them;
//   - summing per-flow elapsed over-reported by roughly the flow count (`.map` starts
//     every task at once, so each flow measures nearly the same interval), and that
//     sum barely moves when the loop goes serial->concurrent -- so the field added to
//     demonstrate the improvement was the one field that could not show it.
//
// One record per call, wall-clock, written unconditionally. A plain sum is now correct
// downstream, and the distinct-flow_id trap is gone with the per-line field.

test("writes exactly one cost record per call, with the call's own wall-clock (§4.3)", async () => {
  const out = tmpFile();
  const request = fakeRequest(
    { f1: [{ id: "t1", totalTokens: 88 }, { id: "t2", totalTokens: 50 }], f2: [{ id: "t3", totalTokens: 5 }] },
    { t1: { spans: SPANS }, t2: { spans: [] }, t3: { spans: [] } },
  );
  const result = await recordTokenAttribution({
    request,
    flowIds: ["f1", "f2"],
    test: "agent suite",
    file: "x.spec.ts",
    out,
  });

  assert.equal(result.recorded, 3, "three traces across two flows");
  assert.equal(traceLines(out).length, 3);
  // ONE record for the whole call — not one per flow, and not one per trace. This is
  // what makes a plain sum downstream correct.
  const costs = costRecords(out);
  assert.equal(costs.length, 1);
  assert.equal(costs[0].flows, 2, "the number of flow ids this call was asked to attribute");
  assert.equal(costs[0].test, "agent suite");
  assert.equal(costs[0].file, "x.spec.ts");
  assert.equal(typeof costs[0].attrib_ms, "number");
  assert.ok((costs[0].attrib_ms as number) >= 0);
  // No per-trace copy survives: one channel, one meaning. Keeping both would invite
  // the same wrong sum a second time.
  for (const line of traceLines(out)) {
    assert.equal("attrib_ms" in line, false, "attrib_ms must live ONLY on the cost record");
  }
});

// THE case the old design silently dropped, and the whole reason the shape changed:
// a spec that created flows but ran none of them still paid one list request per flow.
// That is the dominant cost of this sidecar across the suite.
test("a call whose flows yield ZERO traces still records its cost (§4.3)", async () => {
  const out = tmpFile();
  const request = fakeRequest({ f1: [], f2: [], f3: [] });
  const result = await recordTokenAttribution({
    request,
    flowIds: ["f1", "f2", "f3"],
    test: "ui spec that burns nothing",
    file: "ui.spec.ts",
    out,
  });

  assert.equal(result.recorded, 0, "no traces, so no trace lines — unchanged");
  assert.deepEqual(result.skipped, [], "nothing failed; there was simply nothing to attribute");
  assert.deepEqual(traceLines(out), []);
  const costs = costRecords(out);
  assert.equal(costs.length, 1, "the three list requests were paid for and must be visible");
  assert.equal(costs[0].flows, 3);
  assert.equal(typeof costs[0].attrib_ms, "number", "a numeric cost, not a missing field");
});

test("a call whose every flow THREW still records its cost (§4.3)", async () => {
  const out = tmpFile();
  const request = fakeRequest({}, {}, { fail: true });
  const result = await recordTokenAttribution({
    request,
    flowIds: ["f1"],
    test: "spec",
    file: "x.spec.ts",
    out,
  });

  assert.equal(result.recorded, 0);
  assert.equal(result.skipped.length, 1, "the throw is still named");
  assert.equal(costRecords(out).length, 1, "a wedged backend costs time — the most important time to see");
});

// The one deliberate exception to "unconditional": a failing buildProbe import
// returns before the Promise.all, having made no request at all, and the existing
// "no file must be written when the import itself fails" test pins that. Asserted
// here too, from the cost record's side, so the exception is explicit rather than
// discovered later as an inconsistency.
test("a failing buildProbe import writes NO cost record — it made no request (§4.3)", async () => {
  const out = tmpFile();
  const request = fakeRequest({ f1: [{ id: "t1", totalTokens: 88 }] }, { t1: { spans: SPANS } });
  const result = await recordTokenAttribution({
    request,
    flowIds: ["f1"],
    test: "spec",
    file: "x.spec.ts",
    out,
    loadBuildProbe: async () => {
      throw new Error("Cannot find module");
    },
  });
  assert.match(result.skipped[0], /buildProbe import failed/);
  assert.equal(fs.existsSync(out), false, "no trace line and no cost record");
});

// Fix round 1, item 5: the rule that a non-positive value falls back applied to the
// env var only, so `timeoutMs: 0` reached Playwright as `timeout: 0` -- which means
// NO timeout, the exact wedge the option exists to close -- while the doc comment
// claimed 0 was rejected. Same rule on both paths now, matching the poller's num()
// (scripts/watch-tokens.mjs:63-66).
test("a non-positive timeout falls back to 8000 instead of disabling the timeout (§4.2)", async () => {
  const seen: Array<number | undefined> = [];
  const request = {
    get: async (url: string, opts?: { timeout?: number }) => {
      seen.push(opts?.timeout);
      if (url.includes("?flow_id=")) {
        return { ok: () => true, status: () => 200, json: async () => ({ traces: [{ id: "t1" }] }) };
      }
      return { ok: () => true, status: () => 200, json: async () => ({ spans: [] }) };
    },
  } as unknown as APIRequestContext;

  await recordTokenAttribution({
    request,
    flowIds: ["f1"],
    test: "spec",
    file: "x.spec.ts",
    out: tmpFile(),
    timeoutMs: 0,
  });

  assert.deepEqual(seen, [8000, 8000], "Playwright reads timeout: 0 as unbounded — a bound must never resolve to it");
});

// --- The two ordering invariants concurrency can break (fix round 1, item 1) ---
//
// Both were correct in the implementation and pinned by NOTHING: the reviewer moved
// `attempted.add(flowId)` to after the list `await`, and separately moved
// `detailFetches += 1` to after the detail `await`, and the whole suite stayed
// green. The pre-existing §2.1 tests only exercise the guard across SEQUENTIAL
// calls, and the cap test uses a single flow whose detail loop is serial, so a
// post-increment still lands exactly on the cap. On a branch whose recurring defect
// has been precisely "a comment is the only thing holding an invariant", that is the
// gap worth closing.

// The counter must be claimed BEFORE its await. Three flows, one detail slot, and
// BOTH fakes delayed so that all three tasks are sitting in the cap check before any
// detail request resolves: pre-increment lets exactly one through, post-increment
// lets all three see a counter still reading 0.
test("the detail counter is claimed before its await, so concurrent flows cannot both take the last slot (§4.2)", async () => {
  let detailCalls = 0;
  const request = {
    get: async (url: string) => {
      if (url.includes("?flow_id=")) {
        // Delayed on purpose: all three list requests must be in flight together,
        // so all three tasks arrive at the cap check in the same timer batch.
        await new Promise((r) => setTimeout(r, 10));
        const flowId = new URL(url, "http://x").searchParams.get("flow_id") ?? "";
        return { ok: () => true, status: () => 200, json: async () => ({ traces: [{ id: `t-${flowId}` }] }) };
      }
      detailCalls += 1;
      // Also delayed: this is the window a post-increment would leave open.
      await new Promise((r) => setTimeout(r, 10));
      return { ok: () => true, status: () => 200, json: async () => ({ spans: [] }) };
    },
  } as unknown as APIRequestContext;

  const result = await recordTokenAttribution({
    request,
    flowIds: ["f1", "f2", "f3"],
    test: "spec",
    file: "x.spec.ts",
    out: tmpFile(),
    detailCap: 1,
  });

  assert.equal(
    detailCalls,
    1,
    `the cap must hold across CONCURRENT flows, not just within one; got ${detailCalls} detail requests for a cap of 1`,
  );
  // The cap costs a breakdown, never a trace: all three are still recorded, and the
  // two that lost their spans are named.
  assert.equal(result.recorded, 3);
  assert.equal(
    result.skipped.filter((s) => s.includes("detail cap")).length,
    2,
    `both curtailed flows must name the cap; got ${JSON.stringify(result.skipped)}`,
  );
});

// The flow id must be claimed BEFORE the list await. Two tasks for the SAME id in
// one call: claiming first means the second returns immediately; claiming after the
// await means both pass a check on a set that is still empty, and one trace gets two
// lines -- which is not a visible defect downstream, just a plausible number, twice
// as large (§2.1).
//
// `cleanup()` cannot reach this today, because its `captured` list is a Set. That is
// the reason the invariant needs a TEST rather than a caller to protect it: nothing
// in the code stops the next caller from passing a plain array with a repeat.
test("a flow id repeated inside ONE call is claimed once, not raced twice (§2.1)", async () => {
  const out = tmpFile();
  let listCalls = 0;
  const request = {
    get: async (url: string) => {
      if (url.includes("?flow_id=")) {
        listCalls += 1;
        // Delayed, so the duplicate task has a real window in which to slip past a
        // guard that is claimed too late.
        await new Promise((r) => setTimeout(r, 10));
        return { ok: () => true, status: () => 200, json: async () => ({ traces: [{ id: "t1", totalTokens: 88 }] }) };
      }
      return { ok: () => true, status: () => 200, json: async () => ({ spans: SPANS }) };
    },
  } as unknown as APIRequestContext;

  const result = await recordTokenAttribution({
    request,
    flowIds: ["f1", "f1"],
    test: "spec",
    file: "x.spec.ts",
    out,
  });

  assert.equal(listCalls, 1, "one list request per flow, never two for the same id (the no-polling contract)");
  assert.equal(result.recorded, 1, "the duplicate must be claimed away, not attributed a second time");
  assert.equal(
    traceLines(out).length,
    1,
    "two lines for one trace is a plausible number, twice as large -- exactly what §2.1 forbids",
  );
});

// Fix round 1, item 4: the interleaving argument rests on the append being
// SYNCHRONOUS, and no behavioural test can see the difference -- the reviewer
// swapped in `await fs.promises.appendFile` and all 20 tests stayed green. So pin
// the mechanism structurally, the way scripts/lib/token-cost.test.mjs pins "never
// reads the clock". A comment asserting coverage the assertions do not provide is
// the shape this branch keeps getting bitten by.
test("the sidecar appends synchronously — the property the interleaving argument rests on (§4.2)", () => {
  const src = fs.readFileSync(path.join(__dirname, "token-attribution.ts"), "utf8");
  // Comments stripped first: that file's own prose NAMES the async APIs it refuses
  // to use, and a guard that its own justification trips is a guard someone deletes
  // rather than keeps. Match the CODE.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.match(code, /fs\.appendFileSync\(/, "the JSONL append must be fs.appendFileSync");
  assert.doesNotMatch(
    code,
    /fs\.promises|appendFile\s*\(|createWriteStream|writeFile\s*\(/,
    "an async append or a stream yields between open and write — the window that produces half a JSON line " +
      "when two concurrent flows (or two Playwright workers) share this file",
  );
});
