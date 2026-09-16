import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import { describeFlowReadback } from "../../../../helpers/flows/describe-flow-readback";
import { describeResponseDetail } from "../../../../helpers/flows/describe-response-detail";

const FLOW_BASE = {
  name: "",
  description: "Temporary flow for invalid-key test",
  data: { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
  is_component: false,
};

test.describe("API Invalid Key Handling", () => {
  test(
    "POST /api/v1/flows/ with invalid Bearer token returns 401, 403, or 422",
    { tag: ["@stable", "@release", "@api", "@workspace", "@regression"] },
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
    { tag: ["@stable", "@release", "@api", "@workspace", "@regression"] },
    async ({ request }) => {
      const res = await request.get("/api/v1/flows/", {
        headers: {},
      });

      expect([401, 403]).toContain(res.status());
    },
  );

  test(
    "GET /api/v1/flows/{id} with invalid Bearer token returns 401 or 403",
    { tag: ["@stable", "@release", "@api", "@workspace", "@regression"] },
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
    { tag: ["@stable", "@release", "@api", "@workspace", "@regression"] },
    async ({ request }) => {
      const authToken = await getAuthToken(request);
      const flowName = `Invalid Key Run Test - ${Date.now()}`;

      // Created outside try so finally runs only when flowId is guaranteed defined.
      const createRes = await request.post("/api/v1/flows/", {
        headers: { Authorization: authToken },
        data: { ...FLOW_BASE, name: flowName },
      });
      expect(createRes.status()).toBe(201);
      const { id: flowId } = await createRes.json();
      expect(flowId).toBeTruthy();

      try {
        const runRes = await request.post(`/api/v1/run/${flowId}`, {
          headers: { "x-api-key": "invalid-api-key-0000" },
          data: { input_value: "test", input_type: "chat", output_type: "chat" },
        });

        expect([401, 403]).toContain(runRes.status());
      } finally {
        await deleteFlow(request, flowId, {
          headers: { Authorization: authToken },
        });
      }
    },
  );

  test(
    "DELETE /api/v1/flows/{id} without Authorization header returns 401 or 403",
    { tag: ["@stable", "@release", "@api", "@workspace", "@regression"] },
    async ({ request }) => {
      const fakeId = "00000000-0000-0000-0000-000000000002";

      // Raw DELETE on purpose: this call's status IS the assertion. `deleteFlow`
      // absorbs 404-as-done and retries one 5xx, which would erase what this test
      // checks (§3.1).
      const res = await request.delete(`/api/v1/flows/${fakeId}`, {
        headers: {},
      });

      expect([401, 403]).toContain(res.status());
    },
  );

  test(
    "PATCH /api/v1/flows/{id} with wrong token does not update the flow",
    { tag: ["@stable", "@release", "@api", "@workspace", "@regression"] },
    async ({ request }) => {
      const authToken = await getAuthToken(request);
      const flowName = `Invalid Patch Test - ${Date.now()}`;

      // Created outside try so finally runs only when flowId is guaranteed defined.
      const createRes = await request.post("/api/v1/flows/", {
        headers: { Authorization: authToken },
        data: { ...FLOW_BASE, name: flowName },
      });
      expect(createRes.status()).toBe(201);
      const { id: flowId } = await createRes.json();
      expect(flowId).toBeTruthy();

      try {
        const patchRes = await request.patch(`/api/v1/flows/${flowId}`, {
          headers: { Authorization: "Bearer wrong-token-here" },
          data: { name: "Should Not Update" },
        });

        expect([401, 403]).toContain(patchRes.status());

        const getRes = await request.get(`/api/v1/flows/${flowId}`, {
          headers: { Authorization: authToken },
        });
        // The 200 is the contract and is asserted unchanged. The failing branch
        // adds attribution (#1807 / LE-2598), and this is the file where the
        // window is most misleading: a bare `Expected: 200 / Received: 404` on
        // the step that checks "the wrong-token PATCH did not change the flow"
        // reads as a SECURITY finding — a rejected write that destroyed the row
        // — in a spec whose subject is the auth boundary. It is not one YET: the
        // likely story is that the PATCH was refused before it touched anything
        // and the flow is simply not visible so far. What decides it is a read
        // taken AFTER the commit window, never these two — both miss inside an
        // open window, measured 10/10 (#1878/#1881), so a both-negative pair is
        // undecided and the doc's table reports it that way. Neither read throws,
        // both run only here, and neither is declared through apiCoverage.
        const readbackDiagnosis =
          getRes.status() === 200
            ? undefined
            : [
                `GET /api/v1/flows/${flowId} -> ${getRes.status()}`,
                await describeResponseDetail(getRes),
                await describeFlowReadback(
                  request,
                  flowId,
                  { headers: { Authorization: authToken } },
                  "second read of the same route — a 200 here means the row landed between the two",
                ),
              ].join("; ");
        expect(getRes.status(), readbackDiagnosis).toBe(200);
        const flow = await getRes.json();
        expect(flow.name).toBe(flowName);
      } finally {
        await deleteFlow(request, flowId, {
          headers: { Authorization: authToken },
        });
      }
    },
  );
});
