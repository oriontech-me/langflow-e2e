import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";

const FLOW_BASE = {
  name: "",
  description: "Temporary flow for invalid-key test",
  data: { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
  is_component: false,
};

test.describe("API Invalid Key Handling", () => {
  test(
    "POST /api/v1/flows/ with invalid Bearer token returns 401, 403, or 422",
    { tag: ["@release", "@workspace", "@regression"] },
    async ({ request }) => {
      const res = await request.post("/api/v1/flows/", {
        headers: { Authorization: "Bearer invalid-token-xyz" },
        data: {
          ...FLOW_BASE,
          name: `Invalid Token Test - ${Date.now()}`,
        },
      });

      expect([401, 403, 422]).toContain(res.status());
    },
  );

  test(
    "GET /api/v1/flows/ without Authorization header returns 401 or 403",
    { tag: ["@release", "@workspace", "@regression"] },
    async ({ request }) => {
      const res = await request.get("/api/v1/flows/", {
        headers: {},
      });

      expect([401, 403]).toContain(res.status());
    },
  );

  test(
    "GET /api/v1/flows/{id} with invalid Bearer token returns 401 or 403",
    { tag: ["@release", "@workspace", "@regression"] },
    async ({ request }) => {
      const fakeId = "00000000-0000-0000-0000-000000000001";

      const res = await request.get(`/api/v1/flows/${fakeId}`, {
        headers: { Authorization: "Bearer totally-invalid-token" },
      });

      expect([401, 403]).toContain(res.status());
    },
  );

  test(
    "POST /api/v1/run/{id} with invalid x-api-key returns 401 or 403",
    { tag: ["@release", "@workspace", "@regression"] },
    async ({ request }) => {
      const authToken = await getAuthToken(request);
      const flowName = `Invalid Key Run Test - ${Date.now()}`;
      let flowId: string | null = null;

      try {
        // Create a real flow with valid credentials
        const createRes = await request.post("/api/v1/flows/", {
          headers: { Authorization: authToken },
          data: { ...FLOW_BASE, name: flowName },
        });
        expect(createRes.status()).toBe(201);

        const body = await createRes.json();
        flowId = body.id;

        // Attempt to run the flow with an invalid API key
        const runRes = await request.post(`/api/v1/run/${flowId}`, {
          headers: { "x-api-key": "invalid-api-key-0000" },
          data: { input_value: "test", input_type: "chat", output_type: "chat" },
        });

        expect([401, 403]).toContain(runRes.status());
      } finally {
        if (flowId) {
          await request.delete(`/api/v1/flows/${flowId}`, {
            headers: { Authorization: authToken },
          });
        }
      }
    },
  );

  test(
    "DELETE /api/v1/flows/{id} without Authorization header returns 401 or 403",
    { tag: ["@release", "@workspace", "@regression"] },
    async ({ request }) => {
      const fakeId = "00000000-0000-0000-0000-000000000002";

      const res = await request.delete(`/api/v1/flows/${fakeId}`, {
        headers: {},
      });

      expect([401, 403]).toContain(res.status());
    },
  );

  test(
    "PATCH /api/v1/flows/{id} with wrong token does not update the flow",
    { tag: ["@release", "@workspace", "@regression"] },
    async ({ request }) => {
      const authToken = await getAuthToken(request);
      const flowName = `Invalid Patch Test - ${Date.now()}`;
      let flowId: string | null = null;

      try {
        // Create flow with valid credentials
        const createRes = await request.post("/api/v1/flows/", {
          headers: { Authorization: authToken },
          data: { ...FLOW_BASE, name: flowName },
        });
        expect(createRes.status()).toBe(201);

        const body = await createRes.json();
        flowId = body.id;

        // Try to patch with an invalid token
        const patchRes = await request.patch(`/api/v1/flows/${flowId}`, {
          headers: { Authorization: "Bearer wrong-token-here" },
          data: { name: "Should Not Update" },
        });

        expect([401, 403]).toContain(patchRes.status());

        // Verify the name was NOT changed
        const getRes = await request.get(`/api/v1/flows/${flowId}`, {
          headers: { Authorization: authToken },
        });
        expect(getRes.status()).toBe(200);
        const flow = await getRes.json();
        expect(flow.name).toBe(flowName);
      } finally {
        if (flowId) {
          await request.delete(`/api/v1/flows/${flowId}`, {
            headers: { Authorization: authToken },
          });
        }
      }
    },
  );
});
