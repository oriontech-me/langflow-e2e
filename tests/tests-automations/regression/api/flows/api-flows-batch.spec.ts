import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";

// Batch create: `POST /api/v1/flows/batch/`. Spec doc: docs/api/flows/api-flows-batch.md
//
// Re-scoped in #1699. The first version of this file asserted a bulk-DELETE endpoint
// that does not exist — it POSTed `{flow_ids}` to `/api/v1/flows/batch` (no trailing
// slash, which falls through to `/api/v1/flows/{flow_id}` and answers 405) and had
// been red on the nightly, invisible to the daily because it carried no @stable. The
// real bulk delete is `DELETE /api/v1/flows/` (api-flows-put-and-bulk-delete.spec.ts);
// this endpoint is batch CREATE, body `{"flows": [...]}`. Its second test, a
// "pagination" check that asserted `length >= 0` on the array the endpoint actually
// returns, is dropped — `GET /api/v1/flows/` is covered and declared by the CRUD spec.
test.describe("Batch flow creation via API", () => {
  const FLOW_BASE = {
    description: "Created by api-flows-batch.spec.ts",
    data: { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
    is_component: false,
  };

  // Id-scoped cleanup from the 201 list — never a listing diff (#553/#518).
  const createdFlowIds: string[] = [];

  test.afterEach(async ({ request }) => {
    const authToken = await getAuthToken(request);
    for (const id of createdFlowIds) {
      await deleteFlow(request, id, {
        headers: { Authorization: authToken },
      }).catch((error) => {
        console.warn(`⚠️ Orphan flow left behind (${id}): ${error}`);
      });
    }
    createdFlowIds.length = 0;
  });

  test(
    "batch create makes every flow in the list and refuses a duplicate name",
    { tag: ["@stable", "@api", "@workspace"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        "POST /api/v1/flows/batch/",
        "GET /api/v1/flows/{flow_id}",
      ]);
      const authToken = await getAuthToken(request);
      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const nameA = `Batch A ${suffix}`;
      const nameB = `Batch B ${suffix}`;

      await test.step("POST batch/ creates both flows", async () => {
        const res = await request.post("/api/v1/flows/batch/", {
          headers: { Authorization: authToken },
          data: {
            flows: [
              { ...FLOW_BASE, name: nameA },
              { ...FLOW_BASE, name: nameB },
            ],
          },
        });
        expect(res.status()).toBe(201);
        const created = await res.json();
        expect(Array.isArray(created)).toBe(true);
        expect(created).toHaveLength(2);
        for (const flow of created) {
          expect(flow.id).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
          );
          expect(flow.access_type).toBe("PRIVATE");
          createdFlowIds.push(flow.id);
        }
        expect(created.map((f: { name: string }) => f.name).sort()).toEqual(
          [nameA, nameB].sort(),
        );
      });

      await test.step("each created flow is readable by id", async () => {
        // Server-side existence, not just the response echo.
        for (const id of createdFlowIds) {
          const res = await request.get(`/api/v1/flows/${id}`, {
            headers: { Authorization: authToken },
          });
          expect(res.status()).toBe(200);
          expect([nameA, nameB]).toContain((await res.json()).name);
        }
      });

      await test.step("a duplicate name is refused with 409 and nothing is created", async () => {
        const res = await request.post("/api/v1/flows/batch/", {
          headers: { Authorization: authToken },
          data: { flows: [{ ...FLOW_BASE, name: nameA }] },
        });
        expect(res.status()).toBe(409);
        expect((await res.json()).detail).toBe("Name must be unique");
      });

      await test.step("an empty list is accepted and creates nothing", async () => {
        const res = await request.post("/api/v1/flows/batch/", {
          headers: { Authorization: authToken },
          data: { flows: [] },
        });
        expect(res.status()).toBe(201);
        expect(await res.json()).toEqual([]);
      });

      await test.step("without the trailing slash the request lands on {flow_id} and answers 405", async () => {
        // The trap the first version of this file fell into: `/api/v1/flows/batch`
        // matches `/api/v1/flows/{flow_id}`, which has no POST. Pinned so the next
        // author does not rediscover it. Not declared: this call never reaches the
        // batch operation.
        const res = await request.post("/api/v1/flows/batch", {
          headers: { Authorization: authToken },
          data: { flows: [{ ...FLOW_BASE, name: `Batch C ${suffix}` }] },
        });
        expect(res.status()).toBe(405);
      });
    },
  );
});
