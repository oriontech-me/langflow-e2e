import { readFileSync } from "fs";
import path from "path";
import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";

const TRACE_FIXTURE = JSON.parse(
  readFileSync(
    path.resolve(
      __dirname,
      "../../../../assets/flows/basic-prompting-trace-fixture.json",
    ),
    "utf8",
  ),
);

test(
  "DELETE /api/v1/monitor/traces returns 404 for an unknown flow_id",
  { tag: ["@stable", "@release", "@api", "@regression", "@observability"] },
  async ({ request }) => {
    const authToken = await getAuthToken(request);

    // Well-formed UUID that cannot match any flow owned by the caller — the
    // handler joins flow → user, so the row lookup fails and the response
    // collapses to 404. This pins the unknown-flow 404 contract only;
    // foreign-owned-flow 404 (the cross-user authorization path) is NOT
    // exercised here — see the "What this test does not cover" section of
    // the spec doc for why.
    const res = await request.delete(
      "/api/v1/monitor/traces?flow_id=00000000-0000-0000-0000-000000000001",
      { headers: { Authorization: authToken } },
    );

    expect(res.status()).toBe(404);
  },
);

test.describe("Bulk delete traces — seeded flow", () => {
  test.describe.configure({ mode: "serial" });

  let bearerToken: string;
  let apiKey: string;
  let apiKeyId: string;
  let flowId: string;
  // Number of traces visible for the seeded flow at the end of beforeAll,
  // captured AFTER the count has stabilized across two consecutive reads
  // (defense against async multi-row inserts landing post-DELETE). Asserted
  // > 0 inside the happy-path test as a precondition, so a degraded GET
  // returning an empty envelope after DELETE cannot pass for the wrong reason.
  let initialTraceCount: number;

  test.beforeAll(async ({ request }) => {
    bearerToken = await getAuthToken(request);

    const keyRes = await request.post("/api/v1/api_key/", {
      headers: { Authorization: bearerToken },
      data: { name: `traces-delete-test-${Date.now()}` },
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
    // that is intentional. The failure still emits a trace, which is what this
    // spec deletes.
    const runRes = await request.post(`/api/v1/run/${flowId}`, {
      headers: { "x-api-key": apiKey },
      data: {
        input_value: "delete-traces-probe",
        input_type: "chat",
        output_type: "chat",
      },
    });
    expect([200, 500]).toContain(runRes.status());

    // Stable-count poll: a single `length > 0` poll could fire DELETE while
    // additional trace rows are still being written asynchronously, so a row
    // that lands after DELETE would survive and break the post-DELETE
    // assertion. Require the count to be the same across two consecutive
    // reads before considering it stable.
    let lastCount = -1;
    let stableConfirms = 0;
    await expect
      .poll(
        async () => {
          const res = await request.get(
            `/api/v1/monitor/traces?flow_id=${flowId}`,
            { headers: { Authorization: bearerToken } },
          );
          if (res.status() !== 200) return 0;
          const body = await res.json();
          const current = body.traces?.length ?? 0;
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
    initialTraceCount = lastCount;
  });

  test.afterAll(async ({ request }) => {
    // DELETE /monitor/traces under test only removes trace rows; the flow
    // itself remains and still needs cleanup. The flow is deleted with the
    // bearer token (not the api_key) so the cleanup does not race the
    // api_key delete — if the api_key delete won the race, the flow delete
    // would 401 and the seeded flow would leak into subsequent runs.
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
    "DELETE /api/v1/monitor/traces?flow_id=... clears all traces, and a second DELETE on the empty owned flow still returns 204",
    { tag: ["@release", "@api", "@regression", "@observability"] },
    async ({ request }) => {
      // Anchor: the seeded flow MUST have traces before DELETE. Without this,
      // a post-DELETE empty envelope could come from a degraded GET (the
      // handler swallows DB errors and returns traces=[], total=0 at
      // traces.py:91-96) and the assertion would pass for the wrong reason.
      expect(initialTraceCount).toBeGreaterThan(0);

      const deleteRes = await request.delete(
        `/api/v1/monitor/traces?flow_id=${flowId}`,
        { headers: { Authorization: bearerToken } },
      );
      // The handler is declared `status_code=204`; assert the exact contract
      // rather than a permissive 2xx range so a future change to 200/202
      // surfaces here. Also assert the body is empty — FastAPI returns no
      // body on 204 by contract, so a handler change to 204-with-body would
      // be silently absorbed without this check.
      expect(deleteRes.status()).toBe(204);
      expect((await deleteRes.body()).length).toBe(0);

      const listRes = await request.get(
        `/api/v1/monitor/traces?flow_id=${flowId}`,
        { headers: { Authorization: bearerToken } },
      );
      expect(listRes.status()).toBe(200);

      const body = await listRes.json();
      expect(Array.isArray(body.traces)).toBe(true);
      expect(body.traces.length).toBe(0);
      expect(body.total).toBe(0);

      // Second DELETE on the now-empty owned flow. The handler still has to
      // pass the ownership check (`select(Flow).where(id == flow_id).where(
      // user_id == current_user.id)`) before issuing the `sa.delete` that
      // deletes zero rows. A 404 here would mean the ownership check now
      // rejects empty-trace flows; a non-204 success would mean the contract
      // drifted. This is the only path that distinguishes "ownership
      // enforced" from "id-only check" without seeding a second user.
      const secondDeleteRes = await request.delete(
        `/api/v1/monitor/traces?flow_id=${flowId}`,
        { headers: { Authorization: bearerToken } },
      );
      expect(secondDeleteRes.status()).toBe(204);
      expect((await secondDeleteRes.body()).length).toBe(0);
    },
  );
});
