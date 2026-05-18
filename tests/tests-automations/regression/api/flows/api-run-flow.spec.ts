import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";

// The /api/v1/run endpoint requires x-api-key authentication (not Bearer).
// This test creates a temporary API key in beforeAll and deletes it in afterAll.
// The flow is intentionally empty — matching the convention in api-run-with-tweaks.spec.ts.
// A runnable-flow fixture for semantic output assertions belongs in a separate spec.

test.describe("POST /api/v1/run", () => {
  let flowId: string;
  let apiKey: string;
  let apiKeyId: string;
  let bearerToken: string;

  test.beforeAll(async ({ request }) => {
    bearerToken = await getAuthToken(request);

    // Create a temporary API key for run tests
    const keyRes = await request.post("/api/v1/api_key/", {
      headers: { Authorization: bearerToken },
      data: { name: `playwright-run-test-${Date.now()}` },
    });
    expect(keyRes.status()).toBe(200);
    const keyBody = await keyRes.json();
    expect(keyBody).toHaveProperty("api_key");
    expect(keyBody).toHaveProperty("id");
    apiKey = keyBody.api_key;
    apiKeyId = keyBody.id;

    // Create a minimal flow using the API key (owner must match the API key)
    const createRes = await request.post("/api/v1/flows/", {
      headers: { "x-api-key": apiKey },
      data: {
        name: `Run Test Flow - ${Date.now()}`,
        description: "Flow for API run tests",
        data: { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
        is_component: false,
      },
    });
    expect(createRes.status()).toBe(201);
    const body = await createRes.json();
    flowId = body.id;
  });

  test.afterAll(async ({ request }) => {
    // Delete flow
    if (flowId) {
      await request.delete(`/api/v1/flows/${flowId}`, {
        headers: { "x-api-key": apiKey },
      });
    }
    // Delete temporary API key
    if (apiKeyId) {
      await request.delete(`/api/v1/api_key/${apiKeyId}`, {
        headers: { Authorization: bearerToken },
      });
    }
  });

  test(
    "executes flow with input_value and returns outputs",
    { tag: ["@stable", "@release", "@api", "@regression"] },
    async ({ request }) => {
      const response = await request.post(`/api/v1/run/${flowId}`, {
        headers: { "x-api-key": apiKey },
        data: {
          input_value: "Hello, Langflow!",
          input_type: "chat",
          output_type: "chat",
        },
      });

      expect(response.status()).toBe(200);
      const body = await response.json();
      expect(body).toHaveProperty("outputs");
      expect(Array.isArray(body.outputs)).toBeTruthy();
    },
  );

  test(
    "executes flow with custom session_id and returns it in response",
    { tag: ["@stable", "@release", "@api", "@regression"] },
    async ({ request }) => {
      const customSessionId = `test-session-${Date.now()}`;

      const response = await request.post(`/api/v1/run/${flowId}`, {
        headers: { "x-api-key": apiKey },
        data: {
          input_value: "Test with session",
          input_type: "chat",
          output_type: "chat",
          session_id: customSessionId,
        },
      });

      expect(response.status()).toBe(200);
      const body = await response.json();
      expect(body).toHaveProperty("session_id");
      expect(body.session_id).toBe(customSessionId);
    },
  );

  test(
    "returns 404 for non-existent flow ID",
    { tag: ["@stable", "@release", "@api", "@regression"] },
    async ({ request }) => {
      const fakeFlowId = "00000000-0000-0000-0000-000000000000";

      const response = await request.post(`/api/v1/run/${fakeFlowId}`, {
        headers: { "x-api-key": apiKey },
        data: {
          input_value: "Hello",
          input_type: "chat",
          output_type: "chat",
        },
      });

      expect(response.status()).toBe(404);
    },
  );
});
