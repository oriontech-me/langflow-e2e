import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";

const FLOW_BASE = {
  name: "",
  description: "Criado pelo teste automatizado Playwright",
  data: { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
  is_component: false,
};

test.describe("CRUD /api/v1/flows", () => {
  // Each test manages its own flow to remain independent
  test(
    "POST creates flow and returns ID",
    { tag: ["@release", "@api", "@regression"] },
    async ({ request }) => {
      const authToken = await getAuthToken(request);
      const flowName = `API Test Flow - ${Date.now()}`;

      const createRes = await request.post("/api/v1/flows/", {
        headers: { Authorization: authToken },
        data: { ...FLOW_BASE, name: flowName },
      });

      expect(createRes.status()).toBe(201);

      const body = await createRes.json();
      expect(body).toHaveProperty("id");
      expect(typeof body.id).toBe("string");
      expect(body.id.length).toBeGreaterThan(0);
      expect(body.name).toBe(flowName);

      // Cleanup
      await request.delete(`/api/v1/flows/${body.id}`, {
        headers: { Authorization: authToken },
      });
    },
  );

  test(
    "GET lists flows and includes the created one",
    { tag: ["@release", "@api", "@regression"] },
    async ({ request }) => {
      const authToken = await getAuthToken(request);
      const flowName = `API Test Flow List - ${Date.now()}`;

      const createRes = await request.post("/api/v1/flows/", {
        headers: { Authorization: authToken },
        data: { ...FLOW_BASE, name: flowName },
      });
      expect(createRes.status()).toBe(201);
      const { id } = await createRes.json();

      const listRes = await request.get("/api/v1/flows/", {
        headers: { Authorization: authToken },
      });
      expect(listRes.status()).toBe(200);

      const flows = await listRes.json();
      const flowList = Array.isArray(flows) ? flows : (flows.flows ?? []);
      const found = flowList.find((f: any) => f.id === id);
      expect(found).toBeDefined();
      expect(found.name).toBe(flowName);

      // Cleanup
      await request.delete(`/api/v1/flows/${id}`, {
        headers: { Authorization: authToken },
      });
    },
  );

  test(
    "GET by ID returns correct flow",
    { tag: ["@release", "@api", "@regression"] },
    async ({ request }) => {
      const authToken = await getAuthToken(request);
      const flowName = `API Test Flow Get - ${Date.now()}`;

      const createRes = await request.post("/api/v1/flows/", {
        headers: { Authorization: authToken },
        data: { ...FLOW_BASE, name: flowName },
      });
      expect(createRes.status()).toBe(201);
      const { id } = await createRes.json();

      const getRes = await request.get(`/api/v1/flows/${id}`, {
        headers: { Authorization: authToken },
      });
      expect(getRes.status()).toBe(200);

      const flow = await getRes.json();
      expect(flow.id).toBe(id);
      expect(flow.name).toBe(flowName);

      // Cleanup
      await request.delete(`/api/v1/flows/${id}`, {
        headers: { Authorization: authToken },
      });
    },
  );

  test(
    "PATCH updates flow name",
    { tag: ["@release", "@api", "@regression"] },
    async ({ request }) => {
      const authToken = await getAuthToken(request);
      const flowName = `API Test Flow Patch - ${Date.now()}`;
      const updatedName = `${flowName} - Updated`;

      const createRes = await request.post("/api/v1/flows/", {
        headers: { Authorization: authToken },
        data: { ...FLOW_BASE, name: flowName },
      });
      expect(createRes.status()).toBe(201);
      const { id } = await createRes.json();

      const patchRes = await request.patch(`/api/v1/flows/${id}`, {
        headers: { Authorization: authToken },
        data: { name: updatedName },
      });
      expect(patchRes.status()).toBe(200);

      const updated = await patchRes.json();
      expect(updated.name).toBe(updatedName);

      // Confirm via GET
      const getRes = await request.get(`/api/v1/flows/${id}`, {
        headers: { Authorization: authToken },
      });
      const fetched = await getRes.json();
      expect(fetched.name).toBe(updatedName);

      // Cleanup
      await request.delete(`/api/v1/flows/${id}`, {
        headers: { Authorization: authToken },
      });
    },
  );

  test(
    "DELETE removes flow and returns 200",
    { tag: ["@release", "@api", "@regression"] },
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
    { tag: ["@release", "@api", "@regression"] },
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
    { tag: ["@release", "@api", "@regression"] },
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
    { tag: ["@release", "@api", "@regression"] },
    async ({ request }) => {
      const authToken = await getAuthToken(request);

      const res = await request.post("/api/v1/flows/", {
        headers: { Authorization: authToken },
        data: { description: "Flow sem nome" },
      });
      // 422 Unprocessable Entity for missing required field
      expect([400, 422]).toContain(res.status());
    },
  );

  test(
    "deleted flow does not appear in flows listing",
    { tag: ["@release", "@api", "@regression"] },
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

      const flows = await listRes.json();
      const flowList = Array.isArray(flows) ? flows : (flows.flows ?? []);
      const found = flowList.find((f: any) => f.id === id);
      expect(found).toBeUndefined();
    },
  );
});
