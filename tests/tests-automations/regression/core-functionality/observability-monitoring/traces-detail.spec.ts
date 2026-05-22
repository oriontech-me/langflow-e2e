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

// items[0] is deterministically the last vertex to write a transaction
// (endpoint orders timestamp DESC, monitor.py:574). For this fixture's
// error path, that is always the LanguageModelComponent failing with
// "A model selection is required" — if the fixture is regenerated with
// different node IDs, this constant fails loudly rather than silently.
const FAILING_LLM_VERTEX_ID = "LanguageModelComponent-FLeYF";

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

      // vertex_id is required (nullable=False in the schema) and must match
      // one of the imported node IDs — IDs are preserved on import, so a
      // mismatch would indicate the seeded flow did not actually run.
      const seededNodeIds = new Set<string>(
        TRACE_FIXTURE.data.nodes.map((n: { id: string }) => n.id),
      );

      // Validate the TransactionLogsResponse contract on every returned
      // record (not just items[0]). A regression that breaks any vertex's
      // emit path — ChatInput, Prompt, or the failing LLM — surfaces here.
      for (const [index, record] of body.items.entries()) {
        const where = `body.items[${index}]`;

        // The transaction object must be a plain object (not null/array)
        expect(record, `${where} should be defined`).toBeDefined();
        expect(typeof record).toBe("object");
        expect(record).not.toBeNull();
        expect(Array.isArray(record)).toBe(false);

        // TransactionLogsResponse pins these keys (see backend
        // services/database/models/transactions/model.py:169) — every
        // record must carry them so the Traces grid can render rows
        // without probing for optional fields.
        for (const key of [
          "id",
          "timestamp",
          "vertex_id",
          "target_id",
          "inputs",
          "outputs",
          "status",
        ]) {
          expect(
            record,
            `${where} should contain '${key}'`,
          ).toHaveProperty(key);
        }

        expect(typeof record.vertex_id).toBe("string");
        expect(record.vertex_id.length).toBeGreaterThan(0);
        expect(
          seededNodeIds.has(record.vertex_id),
          `${where}.vertex_id '${record.vertex_id}' should be one of the seeded node IDs`,
        ).toBe(true);

        // target_id is optional (string | null in the schema). The key
        // must still exist (asserted above) so callers can read it
        // without a guard.
        if (record.target_id !== null) {
          expect(typeof record.target_id).toBe("string");
        }

        // Schema says inputs / outputs are `dict | None`; arrays would
        // pass `typeof === "object"` but violate the contract.
        for (const key of ["inputs", "outputs"] as const) {
          const value = record[key];
          if (value !== null) {
            expect(typeof value).toBe("object");
            expect(Array.isArray(value)).toBe(false);
          }
        }

        // status is required and the only two values written by the
        // runtime are "success" (lfx/graph/vertex/base.py:862) and
        // "error" (line 730). Pin the allowed set so a new value would
        // force an explicit decision here before it silently propagates
        // to the UI.
        expect(typeof record.status).toBe("string");
        expect(["success", "error"]).toContain(record.status);

        // TransactionLogsResponse deliberately excludes `error` and
        // `flow_id` ("Transaction response model for logs view -
        // excludes error and flow_id fields"). Pin the absence so that
        // if the schema regresses and starts leaking the raw error
        // message or the flow_id back into the logs view we catch it
        // here.
        expect(record).not.toHaveProperty("error");
        expect(record).not.toHaveProperty("flow_id");
      }

      // Pin the deterministic seed path on items[0] (the last vertex to
      // emit, per the DESC ordering) — a refactor that stops emitting the
      // LLM error row would surface here.
      expect(body.items[0].vertex_id).toBe(FAILING_LLM_VERTEX_ID);
      expect(body.items[0].status).toBe("error");
    },
  );
});
