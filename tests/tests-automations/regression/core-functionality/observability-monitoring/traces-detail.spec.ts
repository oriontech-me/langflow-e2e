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
  "GET /api/v1/monitor/transactions returns 200 with paginated result",
  { tag: ["@stable", "@release", "@api", "@regression", "@observability"] },
  async ({ request }) => {
    const authToken = await getAuthToken(request);

    // flow_id is required — use a valid UUID format
    const res = await request.get(
      "/api/v1/monitor/transactions?flow_id=00000000-0000-0000-0000-000000000001",
      {
        headers: { Authorization: authToken },
      },
    );

    expect(res.status()).toBe(200);
    const body = await res.json();

    // The endpoint returns the fastapi-pagination envelope:
    // { items: [], total, page, size, pages }. Each key must be present so the
    // Traces UI (FlowInsightsContent.tsx) can render a paginated grid without
    // probing for optional fields.
    expect(typeof body).toBe("object");
    expect(body).not.toBeNull();
    expect(Array.isArray(body.items)).toBe(true);
    expect(typeof body.total).toBe("number");
    expect(body).toHaveProperty("page");
    expect(body).toHaveProperty("size");
    expect(body).toHaveProperty("pages");
  },
);

test(
  "GET /api/v1/monitor/transactions filters by flow_id (UUID)",
  { tag: ["@stable", "@release", "@api", "@regression", "@observability"] },
  async ({ request }) => {
    const authToken = await getAuthToken(request);

    // Use a well-formed UUID that does not correspond to any real flow.
    // The endpoint must still return 200 with an empty items array (not a 400/404).
    const res = await request.get(
      "/api/v1/monitor/transactions?flow_id=00000000-0000-0000-0000-000000000001",
      {
        headers: { Authorization: authToken },
      },
    );

    expect(res.status()).toBe(200);
    const body = await res.json();
    // For an unknown flow_id the result should be a paginated object with empty items
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBe(0);
    expect(body.total).toBe(0);
  },
);

test.describe("Transaction record shape — seeded flow", () => {
  test.describe.configure({ mode: "serial" });

  let bearerToken: string;
  let apiKey: string;
  let apiKeyId: string;
  let flowId: string;

  test.beforeAll(async ({ request }) => {
    bearerToken = await getAuthToken(request);

    const keyRes = await request.post("/api/v1/api_key/", {
      headers: { Authorization: bearerToken },
      data: { name: `traces-detail-test-${Date.now()}` },
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

    // Run the flow once to emit a transaction. The fixture has no provider
    // configured, so the LanguageModelComponent fails with "A model selection
    // is required" — that is intentional. The component failure still writes a
    // transaction row, which is what this test validates.
    const runRes = await request.post(`/api/v1/run/${flowId}`, {
      headers: { "x-api-key": apiKey },
      data: {
        input_value: "transaction-probe",
        input_type: "chat",
        output_type: "chat",
      },
    });
    expect([200, 500]).toContain(runRes.status());

    // Transaction writes are asynchronous: poll /monitor/transactions until at
    // least one row exists for this flow before asserting record shape.
    await expect
      .poll(
        async () => {
          const res = await request.get(
            `/api/v1/monitor/transactions?flow_id=${flowId}`,
            { headers: { Authorization: bearerToken } },
          );
          if (res.status() !== 200) return 0;
          const body = await res.json();
          return body.items?.length ?? 0;
        },
        { timeout: 30000, intervals: [500, 1000, 2000] },
      )
      .toBeGreaterThan(0);
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
    "transaction records contain required fields when not empty",
    { tag: ["@stable", "@release", "@api", "@regression", "@observability"] },
    async ({ request }) => {
      const res = await request.get(
        `/api/v1/monitor/transactions?flow_id=${flowId}`,
        { headers: { Authorization: bearerToken } },
      );

      expect(res.status()).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body.items)).toBe(true);
      expect(body.items.length).toBeGreaterThan(0);

      const record = body.items[0];
      expect(record).toBeDefined();

      // The transaction object must be a plain object (not null/array)
      expect(typeof record).toBe("object");
      expect(record).not.toBeNull();
      expect(Array.isArray(record)).toBe(false);

      // One of the common timestamp fields must be present — the Traces UI
      // orders rows by time, so losing every recognizable timestamp would
      // break the grid silently.
      const hasTimestamp =
        "timestamp" in record ||
        "created_at" in record ||
        "updated_at" in record;
      expect(
        hasTimestamp,
        "Transaction record should contain a timestamp field",
      ).toBe(true);
    },
  );
});
