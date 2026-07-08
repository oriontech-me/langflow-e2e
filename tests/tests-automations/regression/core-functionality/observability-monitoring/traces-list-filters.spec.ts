import { readFileSync } from "fs";
import path from "path";
import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";

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

// REQUIRES serial mode. The five tests below share a single beforeAll that
// seeds two flows, runs each once, and polls for trace emission. Removing
// `describe.configure({ mode: "serial" })` would let Playwright shard the
// tests across workers, all of which would race against the same setup.
test.describe("Trace list filters — status / start_time / query / session_id", () => {
  test.describe.configure({ mode: "serial" });

  let bearerToken: string;
  let apiKey: string;
  let apiKeyId: string;
  let errorFlowId: string;
  let okFlowId: string;
  // Full trace.name of the error run — drives both the `?query=` substring
  // probe and the 50-char sanitizer-cap probe. Captured (and asserted) in
  // beforeAll so a future change to the trace-name format surfaces there
  // instead of silently failing the query test.
  let errorTraceName: string;
  // Unique session_id threaded through the ok run's payload — drives the
  // `?session_id=` filter assertions.
  let okSessionId: string;

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

    // Langflow returns 200 (with error payload) or 500 for component-level
    // failures. Anything outside that range (401, 422, etc.) means the run
    // never reached the graph executor and no trace will be emitted — fail
    // fast instead of timing out on the poll below.
    const errorRunRes = await request.post(`/api/v1/run/${errorFlowId}`, {
      headers: { "x-api-key": apiKey },
      data: {
        input_value: "filters-error-probe",
        input_type: "chat",
        output_type: "chat",
      },
    });
    expect([200, 500]).toContain(errorRunRes.status());

    // Thread a unique session_id through the ok run so the ?session_id=
    // filter has a deterministic target. The session_id is persisted on
    // TraceTable.session_id by the native tracer.
    okSessionId = `filters-ok-session-${Date.now()}`;
    const okRunRes = await request.post(`/api/v1/run/${okFlowId}`, {
      headers: { "x-api-key": apiKey },
      data: {
        input_value: "filters-ok-probe",
        input_type: "chat",
        output_type: "chat",
        session_id: okSessionId,
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

    // Capture and validate the error-trace name shape. The handler ILIKEs on
    // TraceTable.{name, id, session_id} (repository.py:169-177), but trace.id
    // is its own UUID (not flow_id), and we did not set a session_id on the
    // error run — so the only column the flow-UUID probe can hit through is
    // `name`. Asserting the substring here means a future change to the
    // trace-name format surfaces at setup time, not as a confusing 0-hit on
    // the ?query= test.
    const errorListRes = await request.get(
      `/api/v1/monitor/traces?flow_id=${errorFlowId}`,
      { headers: { Authorization: bearerToken } },
    );
    expect(errorListRes.status()).toBe(200);
    const errorBody = await errorListRes.json();
    expect(typeof errorBody.traces?.[0]?.name).toBe("string");
    errorTraceName = errorBody.traces[0].name as string;
    expect(errorTraceName).toContain(errorFlowId);
    // Guards the 50-char sanitizer-cap probe in test 4: the probe is built
    // as `errorTraceName.slice(0, 50) + "<garbage>"`. If `errorTraceName`
    // is shorter than 50 chars, `slice(0, 50)` returns the whole name and
    // the truncated probe ends up containing garbage that is NOT in the
    // name — the test would fail with a confusing 0-hit instead of the
    // real surface (trace name format shortened upstream). Fail fast here.
    expect(errorTraceName.length).toBeGreaterThanOrEqual(50);
  });

  test.afterAll(async ({ request }) => {
    const cleanups: Promise<unknown>[] = [];
    if (errorFlowId && apiKey) {
      cleanups.push(
        deleteFlow(request, errorFlowId, {
          headers: { "x-api-key": apiKey },
        }),
      );
    }
    if (okFlowId && apiKey) {
      cleanups.push(
        deleteFlow(request, okFlowId, {
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
    "GET /api/v1/monitor/traces?status=error returns only the failing trace; rejects unknown values",
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

      // Unknown SpanStatus value must be rejected by FastAPI's enum parser
      // (Pydantic 422), not silently coerced to a string LIKE. A handler
      // that loosened the enum to plain str would leak through here.
      const invalidRes = await request.get(
        `/api/v1/monitor/traces?flow_id=${errorFlowId}&status=failed`,
        { headers: { Authorization: bearerToken } },
      );
      expect(invalidRes.status()).toBe(422);
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
    "GET /api/v1/monitor/traces?start_time pins the >= lower bound",
    { tag: ["@stable", "@release", "@api", "@regression", "@observability"] },
    async ({ request }) => {
      // Past cutoff: every seeded trace satisfies start_time >= past, so a
      // handler that flipped the comparator to <= would return 0 here. This
      // is the half that actually pins the direction.
      const past = new Date(Date.now() - 3600 * 1000).toISOString();
      const hitRes = await request.get(
        `/api/v1/monitor/traces?flow_id=${errorFlowId}&start_time=${encodeURIComponent(past)}`,
        { headers: { Authorization: bearerToken } },
      );
      expect(hitRes.status()).toBe(200);
      const hitBody = await hitRes.json();
      expect(hitBody.total).toBe(1);
      expect(hitBody.traces.length).toBe(1);
      expect(hitBody.traces[0].flowId).toBe(errorFlowId);

      // Future cutoff: every seeded trace precedes it, so the filter must
      // exclude all rows. Confirms the filter is actually wired (not a no-op).
      const future = new Date(Date.now() + 3600 * 1000).toISOString();
      const missRes = await request.get(
        `/api/v1/monitor/traces?flow_id=${errorFlowId}&start_time=${encodeURIComponent(future)}`,
        { headers: { Authorization: bearerToken } },
      );
      expect(missRes.status()).toBe(200);
      const missBody = await missRes.json();
      expect(missBody.total).toBe(0);
      expect(missBody.traces.length).toBe(0);
    },
  );

  test(
    "GET /api/v1/monitor/traces?query=<substring> filters by trace name (incl. 50-char sanitize cap)",
    { tag: ["@stable", "@release", "@api", "@regression", "@observability"] },
    async ({ request }) => {
      // The handler ILIKEs on TraceTable.{name, id, session_id} (capped at
      // 50 chars by sanitize_query_string). In this setup the flow UUID is
      // only inside `name`, so the hit here pins the `name` branch.
      const hitRes = await request.get(
        `/api/v1/monitor/traces?flow_id=${errorFlowId}&query=${encodeURIComponent(errorFlowId)}`,
        { headers: { Authorization: bearerToken } },
      );
      expect(hitRes.status()).toBe(200);
      const hitBody = await hitRes.json();
      expect(hitBody.total).toBe(1);
      expect(hitBody.traces.length).toBe(1);
      expect(hitBody.traces[0].flowId).toBe(errorFlowId);

      // 50-char sanitizer cap: send a probe whose first 50 chars are inside
      // trace.name but whose tail is a guaranteed-unmatched suffix. This is
      // the only shape that discriminates the cap from the no-cap case:
      // - cap engaged → sanitizer truncates to first 50 chars (in-name) → HIT
      // - cap dropped → backend ILIKEs the full string (50 in-name + garbage
      //   suffix) which is *not* inside trace.name → MISS
      // - cap hardened into a reject (e.g. 422 on len > 50) → status != 200
      // A prefix-only probe (slice(0, 60)) would HIT in both the cap and
      // no-cap cases and could not tell them apart.
      const longProbe =
        errorTraceName.slice(0, 50) + `-zzz-not-in-name-${Date.now()}`;
      expect(longProbe.length).toBeGreaterThan(50);
      const longRes = await request.get(
        `/api/v1/monitor/traces?flow_id=${errorFlowId}&query=${encodeURIComponent(longProbe)}`,
        { headers: { Authorization: bearerToken } },
      );
      expect(longRes.status()).toBe(200);
      const longBody = await longRes.json();
      expect(longBody.total).toBe(1);
      expect(longBody.traces[0].flowId).toBe(errorFlowId);

      // Same query string with a guaranteed-unmatched fixed prefix returns 0.
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

  test(
    "GET /api/v1/monitor/traces?session_id filters by the session passed at run time",
    { tag: ["@stable", "@release", "@api", "@regression", "@observability"] },
    async ({ request }) => {
      const hitRes = await request.get(
        `/api/v1/monitor/traces?flow_id=${okFlowId}&session_id=${encodeURIComponent(okSessionId)}`,
        { headers: { Authorization: bearerToken } },
      );
      expect(hitRes.status()).toBe(200);
      const hitBody = await hitRes.json();
      expect(hitBody.total).toBe(1);
      expect(hitBody.traces.length).toBe(1);
      expect(hitBody.traces[0].flowId).toBe(okFlowId);
      expect(hitBody.traces[0].sessionId).toBe(okSessionId);

      const missRes = await request.get(
        `/api/v1/monitor/traces?flow_id=${okFlowId}&session_id=missing-session-${Date.now()}`,
        { headers: { Authorization: bearerToken } },
      );
      expect(missRes.status()).toBe(200);
      const missBody = await missRes.json();
      expect(missBody.total).toBe(0);
      expect(missBody.traces.length).toBe(0);
    },
  );
});
