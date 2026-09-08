import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import { describeFlowReadback } from "../../../../helpers/flows/describe-flow-readback";

type Flow = { id: string; name: string; description?: string };

const FLOW_BASE = {
  name: "",
  description: "Created by Playwright automated test",
  data: { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
  is_component: false,
};

// Every test declares the operations it asserts through the `apiCoverage` fixture
// (#1699): the declaration is verified against what the test actually issued, so the
// five CRUD operations count in `npm run api:coverage` — where they counted for
// nothing before, despite being driven as contracts here since the spec was written.
// No assertion changed. Cleanup deletes through `deleteFlow` are not declared: the
// helper verifies them, but the DELETE contract is asserted by the two tests that
// issue a RAW delete ("DELETE removes flow and returns 200" and "deleted flow does
// not appear in flows listing"), and those two do declare it.
//
// `describeFlowReadback` is deliberately NOT declared anywhere in this file. It is
// called only on the branch where an assertion is about to fail, and the coverage
// gate FAILS a declaration the test never issues (fixtures/api-coverage-gate.spec.ts
// §4) — declaring `GET /api/v1/flows/{flow_id}` for it would redden three tests on
// every green run. An undeclared request is tolerated, which is what makes this safe.
test.describe("CRUD /api/v1/flows", () => {
  // Each test manages its own flow to remain independent
  test(
    "POST creates flow and returns ID",
    { tag: ["@stable", "@release", "@api", "@regression"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare(["POST /api/v1/flows/"]);
      const authToken = await getAuthToken(request);
      const flowName = `API Test Flow - ${Date.now()}`;

      const body = await test.step("POST /api/v1/flows/ with valid payload", async () => {
        const createRes = await request.post("/api/v1/flows/", {
          headers: { Authorization: authToken },
          data: { ...FLOW_BASE, name: flowName },
        });
        expect(createRes.status()).toBe(201);
        return createRes.json();
      });

      try {
        await test.step("response body contains a non-empty id and matching name", async () => {
          expect(body).toHaveProperty("id");
          expect(typeof body.id).toBe("string");
          expect(body.id.length).toBeGreaterThan(0);
          expect(body.name).toBe(flowName);
        });
      } finally {
        await test.step("cleanup created flow", async () => {
          await deleteFlow(request, body.id, {
            headers: { Authorization: authToken },
          }).catch(() => {});
        });
      }
    },
  );

  // `POST /api/v1/flows/` returns 201 and the very next `GET /api/v1/flows/` does not
  // contain the created flow. Recurrent under the same assertion on the 2026-08-19 and
  // 2026-09-08 dailies. Not wedge collateral — the attempt ran at 12:41:27Z and
  // finished in 418 ms, ~2.5 min before the earliest measured outage window on any
  // shard (12:43:57Z).
  //
  // NO `@stable`, and #1759 stays open until it comes back: the investigation reached a
  // PRODUCT verdict (`LE-2552`), so the tag is restored only after the upstream fix
  // lands in the nightly and is re-validated there — never on a test-side change.
  //
  // The triage quarantine (`test.fixme`) is LIFTED, and that is a decision: `test.fixme`
  // runs in no context at all, and this is the one of the three symptoms whose failure
  // is NOT yet attributable to LE-2552's mechanism (it goes through `read_flows`, a
  // different query, and did not reproduce in six local configurations). Its readback
  // below is the discriminant, and a discriminant on a muted test is never read. Without
  // `@stable` it runs in the PR gate and the full suite and stays out of the daily.
  test(
    "GET lists flows and includes the created one",
    { tag: ["@release", "@api", "@regression"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare(["POST /api/v1/flows/", "GET /api/v1/flows/"]);
      const authToken = await getAuthToken(request);
      const flowName = `API Test Flow List - ${Date.now()}`;

      const id = await test.step("create a flow via POST", async () => {
        const createRes = await request.post("/api/v1/flows/", {
          headers: { Authorization: authToken },
          data: { ...FLOW_BASE, name: flowName },
        });
        expect(createRes.status()).toBe(201);
        const json = await createRes.json();
        return json.id as string;
      });

      try {
        await test.step("GET /api/v1/flows/ returns 200 and includes the created flow", async () => {
          const listRes = await request.get("/api/v1/flows/", {
            headers: { Authorization: authToken },
          });
          expect(listRes.status()).toBe(200);

          const flows = (await listRes.json()) as Flow[];
          const found = flows.find((f) => f.id === id);
          // Readback ONLY on the branch that is about to fail, so the green path
          // pays no extra request. Its line goes into the assertion MESSAGE
          // because `error.message` is what `results.json` carries and what the
          // daily triage reads — an attachment would not be there. Which of two
          // defects this is turns on the readback's status: 200 means the row
          // exists and the LIST did not return it; 404 means the row is absent.
          const diagnosis = found
            ? undefined
            : await describeFlowReadback(
                request,
                id,
                { headers: { Authorization: authToken } },
                `list returned ${flows.length} flow(s)`,
              );
          expect(found, diagnosis).toBeDefined();
          expect(found?.name).toBe(flowName);
        });
      } finally {
        await test.step("cleanup created flow", async () => {
          await deleteFlow(request, id, {
            headers: { Authorization: authToken },
          }).catch(() => {});
        });
      }
    },
  );

  test(
    "GET by ID returns correct flow",
    { tag: ["@stable", "@release", "@api", "@regression"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare(["POST /api/v1/flows/", "GET /api/v1/flows/{flow_id}"]);
      const authToken = await getAuthToken(request);
      const flowName = `API Test Flow Get - ${Date.now()}`;

      const id = await test.step("create a flow via POST", async () => {
        const createRes = await request.post("/api/v1/flows/", {
          headers: { Authorization: authToken },
          data: { ...FLOW_BASE, name: flowName },
        });
        expect(createRes.status()).toBe(201);
        const json = await createRes.json();
        return json.id as string;
      });

      try {
        await test.step("GET /api/v1/flows/{id} returns 200 and matches the created flow", async () => {
          const getRes = await request.get(`/api/v1/flows/${id}`, {
            headers: { Authorization: authToken },
          });
          expect(getRes.status()).toBe(200);

          const flow = await getRes.json();
          expect(flow.id).toBe(id);
          expect(flow.name).toBe(flowName);
        });
      } finally {
        await test.step("cleanup created flow", async () => {
          await deleteFlow(request, id, {
            headers: { Authorization: authToken },
          }).catch(() => {});
        });
      }
    },
  );

  test(
    "PATCH updates flow name and description",
    { tag: ["@stable", "@release", "@api", "@regression"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare(["POST /api/v1/flows/", "PATCH /api/v1/flows/{flow_id}", "GET /api/v1/flows/{flow_id}"]);
      const authToken = await getAuthToken(request);
      const flowName = `API Test Flow Patch - ${Date.now()}`;
      const updatedName = `${flowName} - Updated`;
      const updatedDescription = "Updated description via PATCH";

      const id = await test.step("create a flow via POST", async () => {
        const createRes = await request.post("/api/v1/flows/", {
          headers: { Authorization: authToken },
          data: { ...FLOW_BASE, name: flowName },
        });
        expect(createRes.status()).toBe(201);
        const json = await createRes.json();
        return json.id as string;
      });

      try {
        await test.step("PATCH /api/v1/flows/{id} returns 200 with updated name and description", async () => {
          const patchRes = await request.patch(`/api/v1/flows/${id}`, {
            headers: { Authorization: authToken },
            data: { name: updatedName, description: updatedDescription },
          });
          expect(patchRes.status()).toBe(200);

          const updated = await patchRes.json();
          expect(updated.name).toBe(updatedName);
          expect(updated.description).toBe(updatedDescription);
        });

        await test.step("subsequent GET reflects the new name and description", async () => {
          const getRes = await request.get(`/api/v1/flows/${id}`, {
            headers: { Authorization: authToken },
          });
          const fetched = await getRes.json();
          expect(fetched.name).toBe(updatedName);
          expect(fetched.description).toBe(updatedDescription);
        });
      } finally {
        await test.step("cleanup created flow", async () => {
          await deleteFlow(request, id, {
            headers: { Authorization: authToken },
          }).catch(() => {});
        });
      }
    },
  );

  test(
    "DELETE removes flow and returns 200",
    { tag: ["@stable", "@release", "@api", "@regression"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare(["POST /api/v1/flows/", "DELETE /api/v1/flows/{flow_id}"]);
      const authToken = await getAuthToken(request);
      const flowName = `API Test Flow Delete - ${Date.now()}`;

      const id = await test.step("create a flow via POST", async () => {
        const createRes = await request.post("/api/v1/flows/", {
          headers: { Authorization: authToken },
          data: { ...FLOW_BASE, name: flowName },
        });
        expect(createRes.status()).toBe(201);
        const json = await createRes.json();
        return json.id as string;
      });

      try {
        await test.step("DELETE /api/v1/flows/{id} returns 200", async () => {
          // Raw DELETE on purpose: this call's status IS the assertion. `deleteFlow`
          // absorbs 404-as-done and retries one 5xx, which would erase what this test
          // checks (§3.1).
          const deleteRes = await request.delete(`/api/v1/flows/${id}`, {
            headers: { Authorization: authToken },
          });
          // A 404 here does not say whether the id is wrong or the row was merely
          // not visible to that read — the two faces of LE-2552. The readback
          // separates them, in the message the daily triage actually reads.
          const diagnosis =
            deleteRes.status() === 200
              ? undefined
              : await describeFlowReadback(
                  request,
                  id,
                  { headers: { Authorization: authToken } },
                  `DELETE body: ${(await deleteRes.text()).slice(0, 200)}`,
                );
          expect(deleteRes.status(), diagnosis).toBe(200);
        });
      } finally {
        // The raw DELETE is the assertion, so when it does NOT answer 200 the flow
        // survives and nothing else removes it — this test leaked one orphan per
        // failure onto the shared superuser until #1759 (the 2026-09-08 daily left
        // two, from the two failed attempts). A 404 here is the desired end state
        // and `deleteFlow` treats it as such, so the green path costs one no-op.
        await test.step("cleanup created flow", async () => {
          await deleteFlow(request, id, {
            headers: { Authorization: authToken },
          }).catch(() => {});
        });
      }
    },
  );

  test(
    "GET after DELETE returns 404",
    { tag: ["@stable", "@release", "@api", "@regression"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare(["POST /api/v1/flows/", "GET /api/v1/flows/{flow_id}"]);
      const authToken = await getAuthToken(request);
      const flowName = `API Test Flow 404 - ${Date.now()}`;

      const id = await test.step("create a flow via POST", async () => {
        const createRes = await request.post("/api/v1/flows/", {
          headers: { Authorization: authToken },
          data: { ...FLOW_BASE, name: flowName },
        });
        expect(createRes.status()).toBe(201);
        const json = await createRes.json();
        return json.id as string;
      });

      await test.step("DELETE the flow", async () => {
        await deleteFlow(request, id, { headers: { Authorization: authToken } });
      });

      await test.step("GET /api/v1/flows/{id} returns 404 after deletion", async () => {
        const getRes = await request.get(`/api/v1/flows/${id}`, {
          headers: { Authorization: authToken },
        });
        expect(getRes.status()).toBe(404);
      });
    },
  );

  test(
    "GET non-existent flow returns 404",
    { tag: ["@stable", "@release", "@api", "@regression"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare(["GET /api/v1/flows/{flow_id}"]);
      const authToken = await getAuthToken(request);
      const fakeId = "00000000-0000-0000-0000-000000000000";

      await test.step("GET /api/v1/flows/{fakeUUID} returns 404", async () => {
        const res = await request.get(`/api/v1/flows/${fakeId}`, {
          headers: { Authorization: authToken },
        });
        expect(res.status()).toBe(404);
      });
    },
  );

  test(
    "POST with missing name returns 422",
    { tag: ["@stable", "@release", "@api", "@regression"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare(["POST /api/v1/flows/"]);
      const authToken = await getAuthToken(request);

      await test.step("POST /api/v1/flows/ without required name returns 400 or 422", async () => {
        const res = await request.post("/api/v1/flows/", {
          headers: { Authorization: authToken },
          data: { description: "Flow without name" },
        });
        // Accept 400 or 422: FastAPI returns 422 for missing required fields,
        // but the boundary may shift with backend stack changes.
        expect([400, 422]).toContain(res.status());
      });
    },
  );

  test(
    "deleted flow does not appear in flows listing",
    { tag: ["@stable", "@release", "@api", "@regression"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        "POST /api/v1/flows/",
        "DELETE /api/v1/flows/{flow_id}",
        "GET /api/v1/flows/",
      ]);
      const authToken = await getAuthToken(request);
      const flowName = `API Test Flow Deleted List - ${Date.now()}`;

      const id = await test.step("create a flow via POST", async () => {
        const createRes = await request.post("/api/v1/flows/", {
          headers: { Authorization: authToken },
          data: { ...FLOW_BASE, name: flowName },
        });
        expect(createRes.status()).toBe(201);
        const json = await createRes.json();
        return json.id as string;
      });

      try {
        await test.step("DELETE /api/v1/flows/{id} returns 200", async () => {
          // Raw and ASSERTED, where this used to call `deleteFlow`. That is a
          // strengthening, not a loosening: the helper treats 404 as the desired
          // end state — right for idempotent cleanup, wrong for a test whose
          // subject is what the delete reported. Swallowing that 404 is why this
          // test and "DELETE removes flow and returns 200" read as two separate
          // defects on the 2026-09-08 daily when they were one (#1759 / LE-2552).
          const deleteRes = await request.delete(`/api/v1/flows/${id}`, {
            headers: { Authorization: authToken },
          });
          const diagnosis =
            deleteRes.status() === 200
              ? undefined
              : await describeFlowReadback(
                  request,
                  id,
                  { headers: { Authorization: authToken } },
                  `DELETE body: ${(await deleteRes.text()).slice(0, 200)}`,
                );
          expect(deleteRes.status(), diagnosis).toBe(200);
        });

        await test.step("GET /api/v1/flows/ does not include the deleted flow", async () => {
          const listRes = await request.get("/api/v1/flows/", {
            headers: { Authorization: authToken },
          });
          expect(listRes.status()).toBe(200);

          const flows = (await listRes.json()) as Flow[];
          const found = flows.find((f) => f.id === id);
          // A 2xx from DELETE is not proof of removal (LE-2552), so when the list
          // still carries the id the readback says which it is: 200 means the
          // delete reported success and removed nothing; 404 means the row is gone
          // and only the LIST still shows it.
          const diagnosis = found
            ? await describeFlowReadback(
                request,
                id,
                { headers: { Authorization: authToken } },
                `list returned ${flows.length} flow(s)`,
              )
            : undefined;
          expect(found, diagnosis).toBeUndefined();
        });
      } finally {
        // Same hole as the raw-DELETE test above: with the delete asserted rather
        // than delegated, a failure leaves the flow behind and nothing else
        // removes it. A 404 is the desired end state here, which `deleteFlow`
        // accepts, so the green path costs one no-op request.
        await test.step("cleanup created flow", async () => {
          await deleteFlow(request, id, {
            headers: { Authorization: authToken },
          }).catch(() => {});
        });
      }
    },
  );
});
