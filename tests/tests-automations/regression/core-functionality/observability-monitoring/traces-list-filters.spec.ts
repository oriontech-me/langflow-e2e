import { readFileSync } from "fs";
import path from "path";
import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";

const ERROR_FIXTURE = JSON.parse(
  readFileSync(
    path.resolve(
      __dirname,
      "../../../../assets/flows/basic-prompting-trace-fixture.json",
    ),
    "utf8",
  ),
);
const OK_FIXTURE = JSON.parse(
  readFileSync(
    path.resolve(
      __dirname,
      "../../../../assets/flows/chat-io-ok-trace-fixture.json",
    ),
    "utf8",
  ),
);

test.describe("Trace list filters — status / start_time / query", () => {
  test.describe.configure({ mode: "serial" });

  let bearerToken: string;
  let apiKey: string;
  let apiKeyId: string;
  let errorFlowId: string;
  let okFlowId: string;
  // Unique substring captured from the trace name during setup — drives the
  // `?query=` filter assertions without depending on the trace-name format.
  let errorTraceNameProbe: string;

  test.beforeAll(async ({ request }) => {
    bearerToken = await getAuthToken(request);

    const keyRes = await request.post("/api/v1/api_key/", {
      headers: { Authorization: bearerToken },
      data: { name: `traces-filters-test-${Date.now()}` },
    });
    expect(keyRes.status()).toBe(200);
    const keyBody = await keyRes.json();
    apiKey = keyBody.api_key;
    apiKeyId = keyBody.id;

    // Flow A — basic-prompting without provider; the LanguageModelComponent
    // fails with "A model selection is required", which still emits a trace
    // with status=error.
    const errorFlowRes = await request.post("/api/v1/flows/", {
      headers: { "x-api-key": apiKey },
      data: {
        ...ERROR_FIXTURE,
        name: `${ERROR_FIXTURE.name} ${Date.now()}`,
      },
    });
    expect(errorFlowRes.status()).toBe(201);
    errorFlowId = (await errorFlowRes.json()).id;

    // Flow B — ChatInput → ChatOutput; pure local I/O, no LLM, run completes
    // in status=ok. The two flows together let us pin the discriminative
    // behavior of ?status=ok vs ?status=error scoped by flow_id.
    const okFlowRes = await request.post("/api/v1/flows/", {
      headers: { "x-api-key": apiKey },
      data: {
        ...OK_FIXTURE,
        name: `${OK_FIXTURE.name} ${Date.now()}`,
      },
    });
    expect(okFlowRes.status()).toBe(201);
    okFlowId = (await okFlowRes.json()).id;

    const errorRunRes = await request.post(`/api/v1/run/${errorFlowId}`, {
      headers: { "x-api-key": apiKey },
      data: {
        input_value: "filters-error-probe",
        input_type: "chat",
        output_type: "chat",
      },
    });
    expect([200, 500]).toContain(errorRunRes.status());

    const okRunRes = await request.post(`/api/v1/run/${okFlowId}`, {
      headers: { "x-api-key": apiKey },
      data: {
        input_value: "filters-ok-probe",
        input_type: "chat",
        output_type: "chat",
      },
    });
    expect(okRunRes.status()).toBe(200);

    // Poll each flow independently — a single combined poll could be satisfied
    // by one flow's trace landing before the other and the assertions below
    // would race against the second insert.
    for (const fId of [errorFlowId, okFlowId]) {
      await expect
        .poll(
          async () => {
            const res = await request.get(
              `/api/v1/monitor/traces?flow_id=${fId}`,
              { headers: { Authorization: bearerToken } },
            );
            if (res.status() !== 200) return 0;
            const body = await res.json();
            return body.traces?.length ?? 0;
          },
          { timeout: 30000, intervals: [500, 1000, 2000] },
        )
        .toBeGreaterThan(0);
    }

    // Capture the unique trailing UUID of the error trace name for ?query=.
    // The handler ILIKEs on TraceTable.{name,id,session_id}, and the trace
    // name is `<flow.name> - <flowId>`, so the flow UUID is a substring of
    // the name and unique across concurrent test runs.
    const errorListRes = await request.get(
      `/api/v1/monitor/traces?flow_id=${errorFlowId}`,
      { headers: { Authorization: bearerToken } },
    );
    const errorBody = await errorListRes.json();
    expect(typeof errorBody.traces?.[0]?.name).toBe("string");
    errorTraceNameProbe = errorFlowId;
  });

  test.afterAll(async ({ request }) => {
    const cleanups: Promise<unknown>[] = [];
    if (errorFlowId && apiKey) {
      cleanups.push(
        request.delete(`/api/v1/flows/${errorFlowId}`, {
          headers: { "x-api-key": apiKey },
        }),
      );
    }
    if (okFlowId && apiKey) {
      cleanups.push(
        request.delete(`/api/v1/flows/${okFlowId}`, {
          headers: { "x-api-key": apiKey },
        }),
      );
    }
    if (apiKeyId) {
      cleanups.push(
        request.delete(`/api/v1/api_key/${apiKeyId}`, {
          headers: { Authorization: bearerToken },
        }),
      );
    }
    await Promise.allSettled(cleanups);
  });

  test(
    "GET /api/v1/monitor/traces?status=error returns only the failing trace",
    { tag: ["@stable", "@release", "@api", "@regression", "@observability"] },
    async ({ request }) => {
      const matchRes = await request.get(
        `/api/v1/monitor/traces?flow_id=${errorFlowId}&status=error`,
        { headers: { Authorization: bearerToken } },
      );
      expect(matchRes.status()).toBe(200);
      const matchBody = await matchRes.json();
      expect(matchBody.total).toBe(1);
      expect(matchBody.traces.length).toBe(1);
      expect(matchBody.traces[0].status).toBe("error");
      expect(matchBody.traces[0].flowId).toBe(errorFlowId);

      const missRes = await request.get(
        `/api/v1/monitor/traces?flow_id=${errorFlowId}&status=ok`,
        { headers: { Authorization: bearerToken } },
      );
      expect(missRes.status()).toBe(200);
      const missBody = await missRes.json();
      expect(missBody.total).toBe(0);
      expect(missBody.traces.length).toBe(0);
    },
  );

  test(
    "GET /api/v1/monitor/traces?status=ok returns only the successful trace",
    { tag: ["@stable", "@release", "@api", "@regression", "@observability"] },
    async ({ request }) => {
      const matchRes = await request.get(
        `/api/v1/monitor/traces?flow_id=${okFlowId}&status=ok`,
        { headers: { Authorization: bearerToken } },
      );
      expect(matchRes.status()).toBe(200);
      const matchBody = await matchRes.json();
      expect(matchBody.total).toBe(1);
      expect(matchBody.traces.length).toBe(1);
      expect(matchBody.traces[0].status).toBe("ok");
      expect(matchBody.traces[0].flowId).toBe(okFlowId);

      const missRes = await request.get(
        `/api/v1/monitor/traces?flow_id=${okFlowId}&status=error`,
        { headers: { Authorization: bearerToken } },
      );
      expect(missRes.status()).toBe(200);
      const missBody = await missRes.json();
      expect(missBody.total).toBe(0);
      expect(missBody.traces.length).toBe(0);
    },
  );

  test(
    "GET /api/v1/monitor/traces?start_time=<future> returns empty",
    { tag: ["@stable", "@release", "@api", "@regression", "@observability"] },
    async ({ request }) => {
      // ISO timestamp 1 hour in the future — every seeded trace must precede it.
      const future = new Date(Date.now() + 3600 * 1000).toISOString();

      const res = await request.get(
        `/api/v1/monitor/traces?flow_id=${errorFlowId}&start_time=${encodeURIComponent(future)}`,
        { headers: { Authorization: bearerToken } },
      );
      expect(res.status()).toBe(200);
      const body = await res.json();
      expect(body.total).toBe(0);
      expect(body.traces.length).toBe(0);
    },
  );

  test(
    "GET /api/v1/monitor/traces?query=<substring> filters by trace name/id/session",
    { tag: ["@stable", "@release", "@api", "@regression", "@observability"] },
    async ({ request }) => {
      // The handler ILIKEs on TraceTable.{name,id,session_id} (capped at 50
      // chars by sanitize_query_string). The flow UUID is part of the trace
      // name and unique across concurrent runs — a hit must return >= 1, and
      // when narrowed by flow_id it must be exactly 1.
      const hitRes = await request.get(
        `/api/v1/monitor/traces?flow_id=${errorFlowId}&query=${encodeURIComponent(errorTraceNameProbe)}`,
        { headers: { Authorization: bearerToken } },
      );
      expect(hitRes.status()).toBe(200);
      const hitBody = await hitRes.json();
      expect(hitBody.total).toBe(1);
      expect(hitBody.traces.length).toBe(1);
      expect(hitBody.traces[0].flowId).toBe(errorFlowId);

      // Same query string with a guaranteed-unmatched fixed prefix returns 0.
      // Using a hyphen-prefixed nonce keeps the probe within the 50-char
      // sanitizer cap and within the printable-ASCII allowlist.
      const missRes = await request.get(
        `/api/v1/monitor/traces?flow_id=${errorFlowId}&query=zzz-no-trace-name-matches-this-${Date.now()}`,
        { headers: { Authorization: bearerToken } },
      );
      expect(missRes.status()).toBe(200);
      const missBody = await missRes.json();
      expect(missBody.total).toBe(0);
      expect(missBody.traces.length).toBe(0);
    },
  );
});
