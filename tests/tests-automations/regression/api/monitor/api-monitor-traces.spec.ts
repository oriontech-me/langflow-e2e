import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { createApiKey, deleteApiKey } from "../../../../helpers/auth/create-api-key";
import { createRunnableChatFlowViaApi } from "../../../../helpers/flows/create-runnable-chat-flow-via-api";

// The four trace operations of the monitor router, over traces this file emits with
// an LLM-free run. Spec doc: docs/api/monitor/api-monitor-traces.md
//
// PREMISE: traces exist only when tracing is on. An instance started with
// LANGFLOW_DEACTIVATE_TRACING=true answers `{"traces":[],"total":0,"pages":0}` after
// a successful run — a 200 that means "unevaluated", not "no traces". This file
// FAILS in that state, naming the flag; it never skips, because a skip would read
// green on an instance that measured nothing (#1012). CI runs with tracing on.
test.describe("Monitor API — traces", () => {
  const RUN_HEADERS: Record<string, string> = {};
  let authHeaders: Record<string, string> = {};
  let flowId = "";
  let apiKeyId = "";
  let teardownFlow: (req?: APIRequestContext) => Promise<void> = async () => {};

  const UNKNOWN_ID = "00000000-0000-4000-8000-000000000000";
  const uniqueSession = (label: string) =>
    `monitor-traces-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  type TraceRow = {
    id: string;
    status: string;
    flowId: string;
    sessionId: string;
    input: { input_value?: string };
    totalTokens: number;
    totalLatencyMs: number;
  };

  async function run(request: APIRequestContext, sessionId: string, input: string) {
    const res = await request.post(`/api/v1/run/${flowId}`, {
      headers: RUN_HEADERS,
      data: { input_value: input, input_type: "chat", output_type: "chat", session_id: sessionId },
    });
    expect(res.status(), await res.text()).toBe(200);
  }

  async function listTraces(
    request: APIRequestContext,
    query = "",
  ): Promise<{ traces: TraceRow[]; total: number; pages: number }> {
    const res = await request.get(`/api/v1/monitor/traces?flow_id=${flowId}${query}`, {
      headers: authHeaders,
    });
    expect(res.status()).toBe(200);
    return res.json();
  }

  /**
   * Wait for the run's trace to land, and FAIL — not skip — if it never does. The
   * message names the one configuration that produces this shape on a healthy run.
   */
  async function waitForTraces(request: APIRequestContext, atLeast: number) {
    let total = 0;
    await expect
      .poll(async () => {
        total = (await listTraces(request)).total;
        return total;
      }, { timeout: 20_000 })
      .toBeGreaterThanOrEqual(atLeast)
      .catch(() => undefined);
    expect(
      total,
      `expected >= ${atLeast} trace(s) after a successful run, got ${total}. ` +
        "A 200 with no traces after a run is what LANGFLOW_DEACTIVATE_TRACING=true " +
        "produces — this file needs an instance with tracing enabled.",
    ).toBeGreaterThanOrEqual(atLeast);
  }

  test.beforeAll(async ({ request }) => {
    const authToken = await getAuthToken(request);
    authHeaders = { Authorization: authToken };
    const key = await createApiKey(request, authHeaders, { namePrefix: "api-monitor-traces" });
    apiKeyId = key.id;
    RUN_HEADERS["x-api-key"] = key.key;
    const flow = await createRunnableChatFlowViaApi(request, authHeaders);
    flowId = flow.flowId;
    teardownFlow = flow.deleteFlow;
  });

  test.afterAll(async ({ request }) => {
    // Traces are not part of the flow row, so they are deleted by flow_id first —
    // scoped by the required query parameter, never a wipe.
    await request
      .delete(`/api/v1/monitor/traces?flow_id=${flowId}`, { headers: authHeaders })
      .catch(() => undefined);
    await teardownFlow(request).catch((error) => {
      console.warn(`⚠️ Orphan flow left behind (${flowId}): ${error}`);
    });
    if (apiKeyId) {
      await deleteApiKey(request, apiKeyId, authHeaders).catch((error) => {
        console.warn(`⚠️ Orphan API key left behind (${apiKeyId}): ${error}`);
      });
    }
  });

  test(
    "a run emits a trace that can be listed, filtered, read and deleted by id",
    { tag: ["@stable", "@api", "@observability"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        "GET /api/v1/monitor/traces",
        "GET /api/v1/monitor/traces/{trace_id}",
        "DELETE /api/v1/monitor/traces/{trace_id}",
      ]);
      const session = uniqueSession("one");
      await run(request, session, "trace-hello");
      await waitForTraces(request, 1);

      let trace: TraceRow = {} as TraceRow;

      await test.step("the listed trace describes the run", async () => {
        const body = await listTraces(request, `&session_id=${session}`);
        expect(body.traces).toHaveLength(1);
        trace = body.traces[0];
        expect(trace.status).toBe("ok");
        expect(trace.flowId).toBe(flowId);
        expect(trace.sessionId).toBe(session);
        expect(trace.input.input_value).toBe("trace-hello");
        expect(trace.totalTokens).toBe(0);
        expect(trace.totalLatencyMs).toBeGreaterThanOrEqual(0);
        // The status filter keeps it.
        const ok = await listTraces(request, `&session_id=${session}&status=ok`);
        expect(ok.traces.map((t) => t.id)).toContain(trace.id);
      });

      await test.step("GET by id adds endTime and the span tree", async () => {
        const res = await request.get(`/api/v1/monitor/traces/${trace.id}`, { headers: authHeaders });
        expect(res.status()).toBe(200);
        const detail = await res.json();
        expect(detail.id).toBe(trace.id);
        expect(typeof detail.endTime).toBe("string");
        // The detail is the trace plus its spans — strictly more than the row.
        expect(JSON.stringify(detail).length).toBeGreaterThan(JSON.stringify(trace).length);
      });

      await test.step("DELETE by id removes exactly that trace", async () => {
        const res = await request.delete(`/api/v1/monitor/traces/${trace.id}`, { headers: authHeaders });
        expect(res.status()).toBe(204);
        const gone = await request.get(`/api/v1/monitor/traces/${trace.id}`, { headers: authHeaders });
        expect(gone.status()).toBe(404);
        expect((await gone.json()).detail).toBe("Trace not found");
      });

      await test.step("unknown ids answer 404 on both verbs", async () => {
        const get = await request.get(`/api/v1/monitor/traces/${UNKNOWN_ID}`, { headers: authHeaders });
        expect(get.status()).toBe(404);
        expect((await get.json()).detail).toBe("Trace not found");
        const del = await request.delete(`/api/v1/monitor/traces/${UNKNOWN_ID}`, { headers: authHeaders });
        expect(del.status()).toBe(404);
        expect((await del.json()).detail).toBe("Trace not found");
      });
    },
  );

  test(
    "the bulk delete is scoped to a flow",
    { tag: ["@stable", "@api", "@observability"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare(["GET /api/v1/monitor/traces", "DELETE /api/v1/monitor/traces"]);
      await run(request, uniqueSession("bulk-a"), "bulk-a");
      await run(request, uniqueSession("bulk-b"), "bulk-b");
      await waitForTraces(request, 2);
      const before = (await listTraces(request)).total;

      await test.step("without flow_id the delete is refused and nothing is removed", async () => {
        const res = await request.delete("/api/v1/monitor/traces", { headers: authHeaders });
        expect(res.status()).toBe(422);
        expect((await res.json()).detail[0].loc).toEqual(["query", "flow_id"]);
        expect((await listTraces(request)).total).toBe(before);
      });

      await test.step("with flow_id every trace of the flow goes", async () => {
        const res = await request.delete(`/api/v1/monitor/traces?flow_id=${flowId}`, {
          headers: authHeaders,
        });
        expect(res.status()).toBe(204);
        expect(await listTraces(request)).toEqual({ traces: [], total: 0, pages: 0 });
      });
    },
  );
});
