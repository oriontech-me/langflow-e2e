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

test(
  "DELETE /api/v1/monitor/traces returns 404 for an unknown but well-formed flow_id",
  { tag: ["@stable", "@release", "@api", "@regression", "@observability"] },
  async ({ request }) => {
    const authToken = await getAuthToken(request);

    // Well-formed UUID that cannot match any flow owned by the caller. The
    // handler joins flow → user, so an unknown flow and a flow owned by a
    // different user both collapse to the same 404 response — this case
    // covers both.
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

    // Trace writes are asynchronous: poll the list endpoint until at least one
    // trace exists for this flow before exercising DELETE.
    await expect
      .poll(
        async () => {
          const res = await request.get(
            `/api/v1/monitor/traces?flow_id=${flowId}`,
            { headers: { Authorization: bearerToken } },
          );
          if (res.status() !== 200) return 0;
          const body = await res.json();
          return body.traces?.length ?? 0;
        },
        { timeout: 30000, intervals: [500, 1000, 2000] },
      )
      .toBeGreaterThan(0);
  });

  test.afterAll(async ({ request }) => {
    // DELETE /monitor/traces only removes trace rows, the flow itself remains —
    // both cleanups still apply. allSettled keeps each delete independent.
    const cleanups: Promise<unknown>[] = [];
    if (flowId && apiKey) {
      cleanups.push(
        request.delete(`/api/v1/flows/${flowId}`, {
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
    "DELETE /api/v1/monitor/traces?flow_id=... clears all traces for the flow",
    { tag: ["@stable", "@release", "@api", "@regression", "@observability"] },
    async ({ request }) => {
      const deleteRes = await request.delete(
        `/api/v1/monitor/traces?flow_id=${flowId}`,
        { headers: { Authorization: bearerToken } },
      );
      // The handler is declared `status_code=204`; assert the exact contract
      // rather than a permissive 2xx range so a future change to 200/202
      // surfaces here.
      expect(deleteRes.status()).toBe(204);

      const listRes = await request.get(
        `/api/v1/monitor/traces?flow_id=${flowId}`,
        { headers: { Authorization: bearerToken } },
      );
      expect(listRes.status()).toBe(200);

      const body = await listRes.json();
      expect(Array.isArray(body.traces)).toBe(true);
      expect(body.traces.length).toBe(0);
      expect(body.total).toBe(0);
    },
  );
});
