import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";

// The versions sub-family (`{flow_id}/versions/`), hidden from /openapi.json — five
// operations no spec drove and no document described. Spec doc:
// docs/api/flows/api-flows-versions.md
//
// The load-bearing measured contract: activating a version is non-destructive — the
// state being replaced is snapshotted first as a new version ("Auto-saved before
// activating vN"). A regression dropping that snapshot would lose work silently.
test.describe("Flows API — versions", () => {
  const MINIMAL_NODE = {
    id: "n1",
    type: "genericNode",
    position: { x: 0, y: 0 },
    data: { id: "n1", type: "ChatInput", node: { template: {} } },
  };
  const UNKNOWN_ID = "00000000-0000-4000-8000-000000000000";

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
  ): Promise<{ id: string; name: string }> {
    const res = await request.post("/api/v1/flows/", {
      headers: { Authorization: authToken },
      data: {
        name: `api-flows-versions ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        description: "versions",
        data: { nodes: [], edges: [] },
      },
    });
    expect(res.status()).toBe(201);
    const flow = (await res.json()) as { id: string; name: string };
    createdFlowIds.push(flow.id);
    return flow;
  }

  test(
    "versions lifecycle: create, list, read, activate with auto-snapshot, delete",
    { tag: ["@stable", "@api", "@workspace"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        "POST /api/v1/flows/",
        "PUT /api/v1/flows/{flow_id}",
        "GET /api/v1/flows/{flow_id}",
        "GET /api/v1/flows/{flow_id}/versions/",
        "POST /api/v1/flows/{flow_id}/versions/",
        "GET /api/v1/flows/{flow_id}/versions/{version_id}",
        "POST /api/v1/flows/{flow_id}/versions/{version_id}/activate",
        "DELETE /api/v1/flows/{flow_id}/versions/{version_id}",
      ]);
      const authToken = await getAuthToken(request);
      const headers = { Authorization: authToken };
      const flow = await createFlow(request, authToken);
      const flowId = flow.id;
      const base = `/api/v1/flows/${flowId}/versions/`;

      await test.step("a fresh flow has no versions and a cap of 50", async () => {
        const res = await request.get(base, { headers });
        expect(res.status()).toBe(200);
        expect(await res.json()).toEqual({ entries: [], max_entries: 50 });
      });

      let v1 = { id: "" };

      await test.step("POST {} snapshots the empty graph as v1", async () => {
        const res = await request.post(base, { headers, data: {} });
        expect(res.status()).toBe(201);
        v1 = await res.json();
        expect(v1).toMatchObject({
          flow_id: flowId,
          version_number: 1,
          version_tag: "v1",
          description: null,
        });
      });

      await test.step("PUT one node into the flow so the next snapshot differs", async () => {
        // `name` is PUT's one required field (api-flows-put-and-bulk-delete.spec.ts
        // pins the 422 without it); everything else is merged.
        const res = await request.put(`/api/v1/flows/${flowId}`, {
          headers,
          data: { name: flow.name, data: { nodes: [MINIMAL_NODE], edges: [] } },
        });
        expect(res.status()).toBe(200);
        expect((await res.json()).data.nodes).toHaveLength(1);
      });

      let v2 = { id: "" };

      await test.step("POST with description snapshots v2; name is ignored", async () => {
        const res = await request.post(base, {
          headers,
          data: { name: "ignored", description: "second" },
        });
        expect(res.status()).toBe(201);
        v2 = await res.json();
        expect(v2).toMatchObject({
          version_number: 2,
          version_tag: "v2",
          description: "second",
        });
        expect(v2).not.toHaveProperty("name");
      });

      await test.step("GET one version carries the snapshot data and is_deployed", async () => {
        const res = await request.get(`${base}${v2.id}`, { headers });
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(body.id).toBe(v2.id);
        expect(body.data.nodes).toHaveLength(1);
        expect(body).toHaveProperty("is_deployed");
      });

      await test.step("activating v1 returns the FLOW with v1's graph live", async () => {
        const res = await request.post(`${base}${v1.id}/activate`, { headers });
        expect(res.status()).toBe(200);
        const flow = await res.json();
        expect(flow.id).toBe(flowId);
        expect(flow.data.nodes).toEqual([]);
      });

      await test.step("activation auto-snapshotted the replaced state as v3, and GET agrees", async () => {
        const list = await request.get(base, { headers });
        expect(list.status()).toBe(200);
        const entries = (await list.json()).entries as Array<{
          id: string;
          version_number: number;
          description: string | null;
        }>;
        expect(entries).toHaveLength(3);
        const newest = entries.find((e) => e.version_number === 3);
        expect(newest?.description).toBe("Auto-saved before activating v1");

        const flow = await request.get(`/api/v1/flows/${flowId}`, { headers });
        expect((await flow.json()).data.nodes).toEqual([]);
      });

      await test.step("DELETE removes v2 and only v2", async () => {
        const res = await request.delete(`${base}${v2.id}`, { headers });
        expect(res.status()).toBe(204);
        const list = await request.get(base, { headers });
        const ids = (await list.json()).entries.map((e: { id: string }) => e.id);
        expect(ids).toHaveLength(2);
        expect(ids).not.toContain(v2.id);
        expect(ids).toContain(v1.id);
      });
    },
  );

  test(
    "unknown version ids are refused with distinct messages",
    { tag: ["@stable", "@api", "@workspace"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        "POST /api/v1/flows/",
        "GET /api/v1/flows/{flow_id}/versions/{version_id}",
        "DELETE /api/v1/flows/{flow_id}/versions/{version_id}",
      ]);
      const authToken = await getAuthToken(request);
      const headers = { Authorization: authToken };
      const flowId = (await createFlow(request, authToken)).id;
      const base = `/api/v1/flows/${flowId}/versions/`;

      const get = await request.get(`${base}${UNKNOWN_ID}`, { headers });
      expect(get.status()).toBe(404);
      expect((await get.json()).detail).toBe("Version entry not found");

      // Recorded rather than judged: the two messages differ in shape, and each is
      // pinned as measured so a unification upstream is noticed, not absorbed.
      const del = await request.delete(`${base}${UNKNOWN_ID}`, { headers });
      expect(del.status()).toBe(404);
      expect((await del.json()).detail).toBe(`Version entry ${UNKNOWN_ID} not found`);
    },
  );
});
