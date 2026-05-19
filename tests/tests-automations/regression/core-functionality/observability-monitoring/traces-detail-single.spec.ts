import { readFileSync } from "fs";
import path from "path";
import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";

const TRACE_FIXTURE = JSON.parse(
  readFileSync(
    path.resolve(
      __dirname,
      "../../../../assets/flows/basic-prompting-trace-fixture.json",
    ),
    "utf8",
  ),
);

const SPAN_TYPES = [
  "chain",
  "llm",
  "tool",
  "retriever",
  "embedding",
  "parser",
  "agent",
] as const;
const SPAN_STATUSES = ["unset", "ok", "error"] as const;

function flattenSpans(
  spans: Array<{ children?: unknown[] } & Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const span of spans) {
    out.push(span);
    const children = Array.isArray(span.children) ? span.children : [];
    out.push(...flattenSpans(children as typeof spans));
  }
  return out;
}

test(
  "GET /api/v1/monitor/traces/{trace_id} returns 404 for an unknown but well-formed UUID",
  { tag: ["@stable", "@release", "@api", "@regression", "@observability"] },
  async ({ request }) => {
    const authToken = await getAuthToken(request);

    // Well-formed UUID that cannot match any existing trace. The handler joins
    // trace → flow → user, so an unknown trace and a trace owned by a different
    // user both collapse to the same 404 response — this case covers both.
    const res = await request.get(
      "/api/v1/monitor/traces/00000000-0000-0000-0000-000000000001",
      { headers: { Authorization: authToken } },
    );

    expect(res.status()).toBe(404);
  },
);

test.describe("Single trace shape — seeded flow", () => {
  test.describe.configure({ mode: "serial" });

  let bearerToken: string;
  let apiKey: string;
  let apiKeyId: string;
  let flowId: string;
  let traceId: string;

  test.beforeAll(async ({ request }) => {
    bearerToken = await getAuthToken(request);

    const keyRes = await request.post("/api/v1/api_key/", {
      headers: { Authorization: bearerToken },
      data: { name: `traces-detail-single-test-${Date.now()}` },
    });
    expect(keyRes.status()).toBe(200);
    const keyBody = await keyRes.json();
    apiKey = keyBody.api_key;
    apiKeyId = keyBody.id;

    const flowRes = await request.post("/api/v1/flows/", {
      headers: { "x-api-key": apiKey },
      data: {
        ...TRACE_FIXTURE,
        name: `${TRACE_FIXTURE.name} ${Date.now()}`,
      },
    });
    expect(flowRes.status()).toBe(201);
    flowId = (await flowRes.json()).id;

    // Run the flow once to emit a trace. The fixture has no provider configured,
    // so the LanguageModelComponent fails with "A model selection is required" —
    // that is intentional. The failure still emits a trace with a span tree,
    // which is what this spec validates.
    const runRes = await request.post(`/api/v1/run/${flowId}`, {
      headers: { "x-api-key": apiKey },
      data: {
        input_value: "single-trace-probe",
        input_type: "chat",
        output_type: "chat",
      },
    });
    expect([200, 500]).toContain(runRes.status());

    // Trace writes are asynchronous: poll the list endpoint until at least one
    // trace exists for this flow. Capture the id inside the poll closure to
    // avoid a redundant re-fetch (and the row-shift race that comes with it).
    let polledTraceId: string | null = null;
    await expect
      .poll(
        async () => {
          const res = await request.get(
            `/api/v1/monitor/traces?flow_id=${flowId}`,
            { headers: { Authorization: bearerToken } },
          );
          if (res.status() !== 200) return null;
          const body = await res.json();
          polledTraceId = body.traces?.[0]?.id ?? null;
          return polledTraceId;
        },
        { timeout: 30000, intervals: [500, 1000, 2000] },
      )
      .not.toBeNull();

    expect(polledTraceId).not.toBeNull();
    traceId = polledTraceId as unknown as string;
  });

  test.afterAll(async ({ request }) => {
    if (flowId) {
      await request.delete(`/api/v1/flows/${flowId}`, {
        headers: { "x-api-key": apiKey },
      });
    }
    if (apiKeyId) {
      await request.delete(`/api/v1/api_key/${apiKeyId}`, {
        headers: { Authorization: bearerToken },
      });
    }
  });

  test(
    "GET /api/v1/monitor/traces/{trace_id} returns the full TraceRead contract with a non-empty span tree",
    { tag: ["@stable", "@release", "@api", "@regression", "@observability"] },
    async ({ request }) => {
      const res = await request.get(`/api/v1/monitor/traces/${traceId}`, {
        headers: { Authorization: bearerToken },
      });
      expect(res.status()).toBe(200);

      const body = await res.json();

      // Top-level TraceRead fields the Trace Details modal consumes.
      expect(body.id).toBe(traceId);
      expect(typeof body.name).toBe("string");
      expect(SPAN_STATUSES).toContain(body.status);
      expect(typeof body.startTime).toBe("string");
      expect(typeof body.totalLatencyMs).toBe("number");
      expect(body.totalLatencyMs).toBeGreaterThanOrEqual(0);
      expect(typeof body.totalTokens).toBe("number");
      expect(body.totalTokens).toBeGreaterThanOrEqual(0);
      expect(body.flowId).toBe(flowId);
      // TraceTable.session_id is nullable on the column, so the wire response
      // is `string | null` even though TraceRead types it as str.
      expect(
        body.sessionId === null || typeof body.sessionId === "string",
      ).toBe(true);
      // input/output/endTime are optional in the schema — assert presence of
      // the keys so a future rename surfaces here.
      expect(body).toHaveProperty("input");
      expect(body).toHaveProperty("output");
      expect(body).toHaveProperty("endTime");

      // Span tree must be non-empty; the seeded flow emits root + 3 components.
      expect(Array.isArray(body.spans)).toBe(true);
      expect(body.spans.length).toBeGreaterThan(0);

      const allSpans = flattenSpans(body.spans);
      expect(allSpans.length).toBeGreaterThan(0);

      for (const span of allSpans) {
        expect(typeof span.id).toBe("string");
        expect(typeof span.name).toBe("string");
        expect(SPAN_TYPES).toContain(span.type);
        expect(SPAN_STATUSES).toContain(span.status);
        expect(typeof span.latencyMs).toBe("number");
        expect(span.latencyMs).toBeGreaterThanOrEqual(0);
        // Schema marks these as nullable but the key itself must be present so
        // the SpanDetail panel can render without probing for optional fields.
        expect(span).toHaveProperty("startTime");
        expect(span).toHaveProperty("endTime");
        expect(span).toHaveProperty("inputs");
        expect(span).toHaveProperty("outputs");
        expect(span).toHaveProperty("error");
        expect(span).toHaveProperty("modelName");
        expect(span).toHaveProperty("tokenUsage");
        expect(Array.isArray(span.children)).toBe(true);
      }
    },
  );
});
