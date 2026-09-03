import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";

// PUT semantics and the bulk DELETE of the flows router. Spec doc:
// docs/api/flows/api-flows-put-and-bulk-delete.md
//
// Neither operation was driven as a contract before #1699: every spec PATCHes, and
// the bulk delete is issued by cleanup helpers only. Measured on 1.13.0.dev0, PUT is
// NOT a replace (fields the body omits survive) and the bulk delete answers
// `{"deleted": N}` with a 200 even when N is 0.
test.describe("Flows API — PUT and bulk DELETE", () => {
  const FLOW_BASE = {
    description: "kept",
    data: { nodes: [], edges: [] },
  };
  const MINIMAL_NODE = {
    id: "n1",
    type: "genericNode",
    position: { x: 0, y: 0 },
    data: { id: "n1", type: "ChatInput", node: { template: {} } },
  };
  const uniqueName = (label: string) =>
    `api-flows-put ${label} ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // Id-scoped cleanup (#553/#518). The bulk-delete tests delete their own flows AS
  // the assertion, so the hook finds nothing and tolerates the 404 `deleteFlow`
  // treats as done.
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

  async function createFlow(
    request: Parameters<typeof getAuthToken>[0],
    authToken: string,
    label: string,
  ): Promise<{ id: string; name: string; folder_id: string }> {
    const res = await request.post("/api/v1/flows/", {
      headers: { Authorization: authToken },
      data: { ...FLOW_BASE, name: uniqueName(label) },
    });
    expect(res.status()).toBe(201);
    const flow = await res.json();
    createdFlowIds.push(flow.id);
    return flow;
  }

  test(
    "PUT merges into the flow instead of replacing it",
    { tag: ["@stable", "@api", "@workspace"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        "POST /api/v1/flows/",
        "PUT /api/v1/flows/{flow_id}",
        "GET /api/v1/flows/{flow_id}",
      ]);
      const authToken = await getAuthToken(request);
      const flow = await createFlow(request, authToken, "merge");
      const renamed = uniqueName("renamed");

      await test.step("PUT without a name is refused — name is the one required field", async () => {
        const res = await request.put(`/api/v1/flows/${flow.id}`, {
          headers: { Authorization: authToken },
          data: { description: "x" },
        });
        expect(res.status()).toBe(422);
        const detail = (await res.json()).detail[0];
        expect(detail.loc).toEqual(["body", "name"]);
        expect(detail.type).toBe("missing");
      });

      await test.step("PUT with only a name keeps every field the body omitted", async () => {
        const res = await request.put(`/api/v1/flows/${flow.id}`, {
          headers: { Authorization: authToken },
          data: { name: renamed },
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(body.name).toBe(renamed);
        // The half that pins the semantics: a true replace would null these.
        expect(body.description).toBe("kept");
        expect(body.id).toBe(flow.id);
        expect(body.folder_id).toBe(flow.folder_id);
      });

      await test.step("GET agrees with the PUT response", async () => {
        const res = await request.get(`/api/v1/flows/${flow.id}`, {
          headers: { Authorization: authToken },
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(body.name).toBe(renamed);
        expect(body.description).toBe("kept");
      });

      await test.step("PUT with data replaces the graph and still keeps the description", async () => {
        const res = await request.put(`/api/v1/flows/${flow.id}`, {
          headers: { Authorization: authToken },
          data: {
            name: uniqueName("renamed-2"),
            data: { nodes: [MINIMAL_NODE], edges: [] },
          },
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(body.data.nodes).toHaveLength(1);
        expect(body.data.nodes[0].id).toBe("n1");
        expect(body.description).toBe("kept");
      });
    },
  );

  test(
    "bulk DELETE removes exactly the ids it is given",
    { tag: ["@stable", "@api", "@workspace"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        "POST /api/v1/flows/",
        "DELETE /api/v1/flows/",
        "GET /api/v1/flows/{flow_id}",
        "GET /api/v1/flows/",
      ]);
      const authToken = await getAuthToken(request);
      const a = await createFlow(request, authToken, "bulk-a");
      const b = await createFlow(request, authToken, "bulk-b");

      await test.step("DELETE /api/v1/flows/ with both ids reports exactly 2", async () => {
        const res = await request.delete("/api/v1/flows/", {
          headers: { Authorization: authToken },
          data: [a.id, b.id],
        });
        expect(res.status()).toBe(200);
        expect(await res.json()).toEqual({ deleted: 2 });
      });

      await test.step("both flows are gone by id and from the listing", async () => {
        for (const id of [a.id, b.id]) {
          const res = await request.get(`/api/v1/flows/${id}`, {
            headers: { Authorization: authToken },
          });
          expect(res.status()).toBe(404);
          expect((await res.json()).detail).toBe("Flow not found");
        }
        const list = await request.get("/api/v1/flows/?header_flows=true", {
          headers: { Authorization: authToken },
        });
        expect(list.status()).toBe(200);
        const ids = (await list.json()).map((f: { id: string }) => f.id);
        expect(ids).not.toContain(a.id);
        expect(ids).not.toContain(b.id);
      });
    },
  );

  test(
    "bulk DELETE of an unknown id reports zero, not an error",
    { tag: ["@stable", "@api", "@workspace"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare(["DELETE /api/v1/flows/"]);
      const authToken = await getAuthToken(request);
      // Recorded, not judged: a 200 for "nothing deleted" gives a caller passing a
      // stale id the same status as a successful delete. Whether that should be a
      // 404 is a product choice; this pins what the build does.
      const res = await request.delete("/api/v1/flows/", {
        headers: { Authorization: authToken },
        data: ["00000000-0000-4000-8000-000000000000"],
      });
      expect(res.status()).toBe(200);
      expect(await res.json()).toEqual({ deleted: 0 });
    },
  );
});
