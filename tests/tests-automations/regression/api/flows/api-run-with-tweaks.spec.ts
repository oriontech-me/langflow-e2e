import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";

// Tests the POST /api/v1/run/{flow_id} endpoint with tweaks parameter,
// which allows callers to override flow component configuration at runtime.

test.describe("POST /api/v1/run with tweaks", () => {
  let bearerToken: string;
  let apiKey: string;
  let apiKeyId: string;
  let flowId: string;

  test.beforeAll(async ({ request }) => {
    bearerToken = await getAuthToken(request);

    // Create an API key for run endpoint (requires x-api-key, not Bearer)
    const keyRes = await request.post("/api/v1/api_key/", {
      headers: { Authorization: bearerToken },
      data: { name: `tweaks-test-key-${Date.now()}` },
    });
    expect(keyRes.status()).toBe(200);
    const keyBody = await keyRes.json();
    apiKey = keyBody.api_key;
    apiKeyId = keyBody.id;

    // Create an empty flow — run endpoint accepts empty flows and returns valid structure
    const flowRes = await request.post("/api/v1/flows/", {
      headers: { Authorization: bearerToken },
      data: {
        name: `Tweaks Test Flow ${Date.now()}`,
        data: { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
        is_component: false,
      },
    });
    expect(flowRes.status()).toBe(201);
    flowId = (await flowRes.json()).id;
  });

  test.afterAll(async ({ request }) => {
    if (flowId) {
      await request
        .delete(`/api/v1/flows/${flowId}`, {
          headers: { Authorization: bearerToken },
        })
        .catch(() => {});
    }
    if (apiKeyId) {
      await request
        .delete(`/api/v1/api_key/${apiKeyId}`, {
          headers: { Authorization: bearerToken },
        })
        .catch(() => {});
    }
  });

  test(
    "POST /api/v1/run/{id} accepts tweaks parameter without error",
    { tag: ["@release", "@api", "@regression"] },
    async ({ request }) => {
      // tweaks with empty object should be accepted and ignored (no components to tweak)
      const res = await request.post(`/api/v1/run/${flowId}`, {
        headers: { "x-api-key": apiKey },
        data: {
          input_value: "hello from test",
          input_type: "chat",
          output_type: "chat",
          tweaks: {},
        },
      });

      // The run endpoint must accept the request — 200 regardless of flow output
      expect(res.status()).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty("outputs");
    },
  );

  test(
    "POST /api/v1/run/{id} without tweaks also returns 200",
    { tag: ["@release", "@api", "@regression"] },
    async ({ request }) => {
      const res = await request.post(`/api/v1/run/${flowId}`, {
        headers: { "x-api-key": apiKey },
        data: {
          input_value: "hello",
          input_type: "chat",
          output_type: "chat",
        },
      });

      expect(res.status()).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty("outputs");
      expect(body).toHaveProperty("session_id");
    },
  );

  test(
    "POST /api/v1/run/{id} with tweaks referencing non-existent component is silently ignored",
    { tag: ["@release", "@api", "@regression"] },
    async ({ request }) => {
      // Tweaks referencing non-existent component IDs are silently ignored — returns 200.
      const res = await request.post(`/api/v1/run/${flowId}`, {
        headers: { "x-api-key": apiKey },
        data: {
          input_value: "test",
          input_type: "chat",
          output_type: "chat",
          tweaks: {
            "NonExistentComponent-999": {
              some_field: "value",
            },
          },
        },
      });

      expect(res.status()).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty("outputs");
    },
  );

  test(
    "POST /api/v1/run with input_type chat and output_type chat returns valid structure",
    { tag: ["@release", "@api", "@regression"] },
    async ({ request }) => {
      const res = await request.post(`/api/v1/run/${flowId}`, {
        headers: { "x-api-key": apiKey },
        data: {
          input_value: "ping",
          input_type: "chat",
          output_type: "chat",
        },
      });

      expect(res.status()).toBe(200);
      const body = await res.json();

      // Response must always include outputs and session_id
      expect(body).toHaveProperty("outputs");
      expect(Array.isArray(body.outputs)).toBe(true);
      expect(body).toHaveProperty("session_id");
      expect(typeof body.session_id).toBe("string");
    },
  );
});
