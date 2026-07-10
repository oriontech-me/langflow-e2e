import { readFileSync } from "fs";
import path from "path";
import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";

// ChatInput -> ChatOutput. Runs to completion WITHOUT a provider and still emits
// a trace with a populated span tree (one span per executed component). That
// populated span tree is the whole point of this spec: the #13955 bug only fires
// when the trace being deleted is referenced by span rows, so a fixture that
// deterministically produces spans (independent of any API key) is required.
const TRACE_FIXTURE = JSON.parse(
  readFileSync(
    path.resolve(
      __dirname,
      "../../../../assets/flows/chat-io-ok-trace-fixture.json",
    ),
    "utf8",
  ),
);

// Regression for langflow-ai/langflow#13955 ("Langflow traces - Clear all does
// not worked"). Root cause: the span -> trace foreign key lacked
// `ondelete="CASCADE"`, so the bulk `DELETE FROM trace WHERE flow_id = ...`
// (which never goes through the ORM cascade machinery) violated
// `span_trace_id_fkey` whenever the trace still had spans. The fix (PR #13976,
// merged to release-1.11.0) adds the cascade so the delete removes the trace
// AND its spans in one statement.
//
// This spec deletes a trace that is GUARANTEED to have spans and asserts the
// delete succeeds — the plain `traces-delete.spec.ts` deletes a trace from a
// provider-less failed run (a thin/fragile span tree) and pins the status-code
// / ownership contract; it does not target the cascade dimension. See the spec
// doc's "What this test does not cover" for the boundary between the two.
//
// IMPORTANT: this bug is only observable when the database enforces foreign
// keys. Postgres always does; SQLite does NOT by default (Langflow's default
// `sqlite_pragmas` omit `foreign_keys`). Against an FK-unenforced SQLite SUT the
// buggy `DELETE` "succeeds" (204, leaving orphaned spans) and this test passes
// for the wrong reason. See the spec doc's "External dependencies".
test.describe("Clear traces with a populated span tree (regression #13955)", () => {
  test.describe.configure({ mode: "serial" });

  let bearerToken: string;
  let apiKey: string;
  let apiKeyId: string;
  let flowId: string;
  let traceId: string;
  // Span count on the seeded trace, captured AFTER it has stabilized across two
  // consecutive reads (spans can land asynchronously after the trace row). This
  // is the anchor asserted `> 0` in the test: without a span tree, the DELETE
  // would not exercise the cascade path and a green result would be meaningless.
  let spanCount: number;

  test.beforeAll(async ({ request }) => {
    bearerToken = await getAuthToken(request);

    const keyRes = await request.post("/api/v1/api_key/", {
      headers: { Authorization: bearerToken },
      data: { name: `traces-delete-cascade-test-${Date.now()}` },
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

    // Run the flow once to emit a trace with spans. Unlike the provider-less
    // fixture in traces-delete.spec.ts, ChatInput -> ChatOutput completes
    // successfully (HTTP 200) and produces a deterministic span tree.
    const runRes = await request.post(`/api/v1/run/${flowId}`, {
      headers: { "x-api-key": apiKey },
      data: {
        input_value: "delete-traces-cascade-probe",
        input_type: "chat",
        output_type: "chat",
      },
    });
    expect(runRes.status()).toBe(200);

    // Stable-count poll on the SPAN count of the emitted trace. A single
    // `spans.length > 0` read could fire DELETE while more spans are still being
    // written, and the trace row itself may land a beat before its spans. Keep
    // reading the trace detail until the span count is the same across two
    // consecutive reads before treating it as settled.
    let lastCount = -1;
    let stableConfirms = 0;
    await expect
      .poll(
        async () => {
          const listRes = await request.get(
            `/api/v1/monitor/traces?flow_id=${flowId}`,
            { headers: { Authorization: bearerToken } },
          );
          if (listRes.status() !== 200) return 0;
          const list = await listRes.json();
          const first = list.traces?.[0];
          if (!first?.id) return 0;
          traceId = first.id;

          const detailRes = await request.get(
            `/api/v1/monitor/traces/${traceId}`,
            { headers: { Authorization: bearerToken } },
          );
          if (detailRes.status() !== 200) return 0;
          const detail = await detailRes.json();
          const current = Array.isArray(detail.spans) ? detail.spans.length : 0;
          if (current > 0 && current === lastCount) {
            stableConfirms++;
          } else {
            stableConfirms = 0;
          }
          lastCount = current;
          return stableConfirms;
        },
        { timeout: 30000, intervals: [500, 500, 1000, 1000, 2000] },
      )
      .toBeGreaterThanOrEqual(1);
    spanCount = lastCount;
  });

  test.afterAll(async ({ request }) => {
    // DELETE /monitor/traces removes trace rows only; the flow itself remains
    // and still needs cleanup. Deleted with the bearer token (not the api_key)
    // so cleanup does not race the api_key delete — mirrors traces-delete.spec.ts.
    const cleanups: Promise<unknown>[] = [];
    if (flowId) {
      cleanups.push(
        deleteFlow(request, flowId, {
          headers: { Authorization: bearerToken },
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
    "Clearing traces for a flow whose trace has spans succeeds (cascade), leaving no traces behind",
    { tag: ["@stable", "@regression", "@api", "@observability"] },
    async ({ request }) => {
      // Anchor: the seeded trace MUST have spans before DELETE. This is what
      // distinguishes the cascade path from the plain bulk-delete contract test.
      // Without a span tree the DELETE never touches the span -> trace FK and a
      // green result would prove nothing about #13955.
      expect(spanCount).toBeGreaterThan(0);

      // The bug: on an FK-enforcing DB the pre-fix handler raises a foreign-key
      // violation here and returns 500 (the trace is left behind — "Clear All
      // does not work"). The fix cascades the span deletes, so DELETE returns
      // 204 with an empty body. Note: this is an API-only test (the `request`
      // fixture, not `page`), so the fixtures' backend-error monitor — which
      // listens on `page.on("response")` — does NOT observe this call; the
      // explicit status assertion below is the sole detection signal.
      const deleteRes = await request.delete(
        `/api/v1/monitor/traces?flow_id=${flowId}`,
        { headers: { Authorization: bearerToken } },
      );
      expect(deleteRes.status()).toBe(204);
      expect((await deleteRes.body()).length).toBe(0);

      // Post-condition: the traces are actually gone. On the buggy path the
      // delete rolled back and this list would still be non-empty.
      const listRes = await request.get(
        `/api/v1/monitor/traces?flow_id=${flowId}`,
        { headers: { Authorization: bearerToken } },
      );
      expect(listRes.status()).toBe(200);
      const body = await listRes.json();
      expect(Array.isArray(body.traces)).toBe(true);
      expect(body.traces.length).toBe(0);
      expect(body.total).toBe(0);

      // And the span tree is gone with it: fetching the now-deleted trace by id
      // returns 404. On the buggy FK-unenforced path the trace row was removed
      // but its spans were orphaned; here the cascade removed both, and the
      // trace detail is unambiguously absent.
      const detailRes = await request.get(
        `/api/v1/monitor/traces/${traceId}`,
        { headers: { Authorization: bearerToken } },
      );
      expect(detailRes.status()).toBe(404);
    },
  );
});
