import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";

type Flow = { id: string; name: string; description?: string };

const FLOW_BASE = {
  name: "",
  description: "Created by Playwright automated test",
  data: { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
  is_component: false,
};

test.describe("CRUD /api/v1/flows", () => {
  // Each test manages its own flow to remain independent
  test(
    "POST creates flow and returns ID",
    { tag: ["@stable", "@release", "@api", "@regression"] },
    async ({ request }) => {
      const authToken = await getAuthToken(request);
      const flowName = `API Test Flow - ${Date.now()}`;

      const createRes = await request.post("/api/v1/flows/", {
        headers: { Authorization: authToken },
        data: { ...FLOW_BASE, name: flowName },
      });

      expect(createRes.status()).toBe(201);

      const body = await createRes.json();

      try {
        expect(body).toHaveProperty("id");
        expect(typeof body.id).toBe("string");
        expect(body.id.length).toBeGreaterThan(0);
        expect(body.name).toBe(flowName);
      } finally {
        await request
          .delete(`/api/v1/flows/${body.id}`, {
            headers: { Authorization: authToken },
          })
          .catch(() => {});
      }
    },
  );

  test(
    "GET lists flows and includes the created one",
    { tag: ["@stable", "@release", "@api", "@regression"] },
    async ({ request }) => {
      const authToken = await getAuthToken(request);
      const flowName = `API Test Flow List - ${Date.now()}`;

      const createRes = await request.post("/api/v1/flows/", {
        headers: { Authorization: authToken },
        data: { ...FLOW_BASE, name: flowName },
      });
      expect(createRes.status()).toBe(201);
      const { id } = await createRes.json();

      try {
        const listRes = await request.get("/api/v1/flows/", {
          headers: { Authorization: authToken },
        });
        expect(listRes.status()).toBe(200);

        const flows = (await listRes.json()) as Flow[];
        const found = flows.find((f) => f.id === id);
        expect(found).toBeDefined();
        expect(found?.name).toBe(flowName);
      } finally {
        await request
          .delete(`/api/v1/flows/${id}`, {
            headers: { Authorization: authToken },
          })
          .catch(() => {});
      }
    },
  );

  test(
    "GET by ID returns correct flow",
    { tag: ["@stable", "@release", "@api", "@regression"] },
    async ({ request }) => {
      const authToken = await getAuthToken(request);
      const flowName = `API Test Flow Get - ${Date.now()}`;

      const createRes = await request.post("/api/v1/flows/", {
        headers: { Authorization: authToken },
        data: { ...FLOW_BASE, name: flowName },
      });
      expect(createRes.status()).toBe(201);
      const { id } = await createRes.json();

      try {
        const getRes = await request.get(`/api/v1/flows/${id}`, {
          headers: { Authorization: authToken },
        });
        expect(getRes.status()).toBe(200);

        const flow = await getRes.json();
        expect(flow.id).toBe(id);
        expect(flow.name).toBe(flowName);
      } finally {
        await request
          .delete(`/api/v1/flows/${id}`, {
            headers: { Authorization: authToken },
          })
          .catch(() => {});
      }
    },
  );

  test(
    "PATCH updates flow name and description",
    { tag: ["@stable", "@release", "@api", "@regression"] },
    async ({ request }) => {
      const authToken = await getAuthToken(request);
      const flowName = `API Test Flow Patch - ${Date.now()}`;
      const updatedName = `${flowName} - Updated`;
      const updatedDescription = "Updated description via PATCH";

      const createRes = await request.post("/api/v1/flows/", {
        headers: { Authorization: authToken },
        data: { ...FLOW_BASE, name: flowName },
      });
      expect(createRes.status()).toBe(201);
      const { id } = await createRes.json();

      try {
        const patchRes = await request.patch(`/api/v1/flows/${id}`, {
          headers: { Authorization: authToken },
          data: { name: updatedName, description: updatedDescription },
        });
        expect(patchRes.status()).toBe(200);

        const updated = await patchRes.json();
        expect(updated.name).toBe(updatedName);
        expect(updated.description).toBe(updatedDescription);

        // Confirm via GET
        const getRes = await request.get(`/api/v1/flows/${id}`, {
          headers: { Authorization: authToken },
        });
        const fetched = await getRes.json();
        expect(fetched.name).toBe(updatedName);
        expect(fetched.description).toBe(updatedDescription);
      } finally {
        await request
          .delete(`/api/v1/flows/${id}`, {
            headers: { Authorization: authToken },
          })
          .catch(() => {});
      }
    },
  );

  test(
    "DELETE removes flow and returns 200",
    { tag: ["@stable", "@release", "@api", "@regression"] },
    async ({ request }) => {
      const authToken = await getAuthToken(request);
      const flowName = `API Test Flow Delete - ${Date.now()}`;

      const createRes = await request.post("/api/v1/flows/", {
        headers: { Authorization: authToken },
        data: { ...FLOW_BASE, name: flowName },
      });
      expect(createRes.status()).toBe(201);
      const { id } = await createRes.json();

      const deleteRes = await request.delete(`/api/v1/flows/${id}`, {
        headers: { Authorization: authToken },
      });
      expect(deleteRes.status()).toBe(200);
    },
  );

  test(
    "GET after DELETE returns 404",
    { tag: ["@stable", "@release", "@api", "@regression"] },
    async ({ request }) => {
      const authToken = await getAuthToken(request);
      const flowName = `API Test Flow 404 - ${Date.now()}`;

      const createRes = await request.post("/api/v1/flows/", {
        headers: { Authorization: authToken },
        data: { ...FLOW_BASE, name: flowName },
      });
      expect(createRes.status()).toBe(201);
      const { id } = await createRes.json();

      await request.delete(`/api/v1/flows/${id}`, {
        headers: { Authorization: authToken },
      });

      const getRes = await request.get(`/api/v1/flows/${id}`, {
        headers: { Authorization: authToken },
      });
      expect(getRes.status()).toBe(404);
    },
  );

  test(
    "GET non-existent flow returns 404",
    { tag: ["@stable", "@release", "@api", "@regression"] },
    async ({ request }) => {
      const authToken = await getAuthToken(request);
      const fakeId = "00000000-0000-0000-0000-000000000000";

      const res = await request.get(`/api/v1/flows/${fakeId}`, {
        headers: { Authorization: authToken },
      });
      expect(res.status()).toBe(404);
    },
  );

  test(
    "POST with missing name returns 422",
    { tag: ["@stable", "@release", "@api", "@regression"] },
    async ({ request }) => {
      const authToken = await getAuthToken(request);

      const res = await request.post("/api/v1/flows/", {
        headers: { Authorization: authToken },
        data: { description: "Flow without name" },
      });
      // Accept 400 or 422: FastAPI returns 422 for missing required fields,
      // but the boundary may shift with backend stack changes.
      expect([400, 422]).toContain(res.status());
    },
  );

  test(
    "deleted flow does not appear in flows listing",
    { tag: ["@stable", "@release", "@api", "@regression"] },
    async ({ request }) => {
      const authToken = await getAuthToken(request);
      const flowName = `API Test Flow Deleted List - ${Date.now()}`;

      const createRes = await request.post("/api/v1/flows/", {
        headers: { Authorization: authToken },
        data: { ...FLOW_BASE, name: flowName },
      });
      expect(createRes.status()).toBe(201);
      const { id } = await createRes.json();

      await request.delete(`/api/v1/flows/${id}`, {
        headers: { Authorization: authToken },
      });

      const listRes = await request.get("/api/v1/flows/", {
        headers: { Authorization: authToken },
      });
      expect(listRes.status()).toBe(200);

      const flows = (await listRes.json()) as Flow[];
      const found = flows.find((f) => f.id === id);
      expect(found).toBeUndefined();
    },
  );
});
