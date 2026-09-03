import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";

// Read-side operations of the flows router nothing drove as a contract: the public
// read, note translations, the starter examples and the hidden `expand/`. Spec doc:
// docs/api/flows/api-flows-public-and-metadata.md
test.describe("Flows API — public read and metadata", () => {
  const FLOW_BASE = { description: "public-metadata", data: { nodes: [], edges: [] } };
  const uniqueName = (label: string) =>
    `api-flows-public ${label} ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

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
  ): Promise<{ id: string; access_type: string }> {
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
    "public_flow hides a private flow and serves a public one, even anonymously",
    { tag: ["@stable", "@api", "@workspace"] },
    async ({ request, apiCoverage, playwright }) => {
      apiCoverage.declare([
        "POST /api/v1/flows/",
        "GET /api/v1/flows/public_flow/{flow_id}",
        "PATCH /api/v1/flows/{flow_id}",
      ]);
      const authToken = await getAuthToken(request);
      const flow = await createFlow(request, authToken, "public");
      expect(flow.access_type).toBe("PRIVATE");

      await test.step("a PRIVATE flow is invisible through public_flow (404, not 403)", async () => {
        const res = await request.get(`/api/v1/flows/public_flow/${flow.id}`, {
          headers: { Authorization: authToken },
        });
        expect(res.status()).toBe(404);
        expect((await res.json()).detail).toBe("Flow not found");
      });

      await test.step("PATCH access_type to PUBLIC", async () => {
        const res = await request.patch(`/api/v1/flows/${flow.id}`, {
          headers: { Authorization: authToken },
          data: { access_type: "PUBLIC" },
        });
        expect(res.status()).toBe(200);
        expect((await res.json()).access_type).toBe("PUBLIC");
      });

      let authenticatedBody: Record<string, unknown> = {};
      await test.step("the PUBLIC flow is served with its public_access block", async () => {
        const res = await request.get(`/api/v1/flows/public_flow/${flow.id}`, {
          headers: { Authorization: authToken },
        });
        expect(res.status()).toBe(200);
        authenticatedBody = await res.json();
        expect(authenticatedBody.id).toBe(flow.id);
        expect(authenticatedBody.public_access).toEqual({
          can_read: true,
          can_execute: true,
        });
      });

      await test.step("the same read works with NO Authorization header, byte for byte", async () => {
        // A fresh context: no cookies, no headers — nothing the auto-login could have
        // seeded. The `request` fixture is not used here on purpose, so this call is
        // not recorded; the declared operation was issued above, authenticated.
        const anonymous = await playwright.request.newContext({
          baseURL: test.info().project.use.baseURL,
        });
        try {
          const res = await anonymous.get(`/api/v1/flows/public_flow/${flow.id}`);
          expect(res.status()).toBe(200);
          // Equality is the assertion: a future change that leaks extra fields to
          // anonymous readers, or hides `public_access` from them, is caught.
          expect(await res.json()).toEqual(authenticatedBody);
        } finally {
          await anonymous.dispose();
        }
      });
    },
  );

  test(
    "note_translations is an empty map for a flow without notes",
    { tag: ["@stable", "@api", "@workspace"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        "POST /api/v1/flows/",
        "GET /api/v1/flows/{flow_id}/note_translations",
      ]);
      const authToken = await getAuthToken(request);
      const flow = await createFlow(request, authToken, "notes");
      const res = await request.get(`/api/v1/flows/${flow.id}/note_translations`, {
        headers: { Authorization: authToken },
      });
      expect(res.status()).toBe(200);
      expect(await res.json()).toEqual({});
    },
  );

  test(
    "basic_examples lists the starter flows",
    { tag: ["@stable", "@api", "@workspace"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare(["GET /api/v1/flows/basic_examples/"]);
      const authToken = await getAuthToken(request);
      // The backend localises this endpoint by Accept-Language (#1400): pinned so the
      // asserted name is the English one regardless of the runner's locale.
      const res = await request.get("/api/v1/flows/basic_examples/", {
        headers: { Authorization: authToken, "Accept-Language": "en-US" },
      });
      expect(res.status()).toBe(200);
      const examples = await res.json();
      expect(Array.isArray(examples)).toBe(true);
      expect(examples.length).toBeGreaterThan(0);
      for (const example of examples) {
        expect(typeof example.name).toBe("string");
        expect(typeof example.description).toBe("string");
        expect(Array.isArray(example.data?.nodes)).toBe(true);
      }
      expect(examples.map((e: { name: string }) => e.name)).toContain("Simple Agent");
    },
  );

  test(
    "expand/ validates the compact body and echoes an empty graph",
    { tag: ["@stable", "@api", "@workspace"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare(["POST /api/v1/flows/expand/"]);
      const authToken = await getAuthToken(request);

      await test.step("an empty body is refused with 400 and a text report naming the schema", async () => {
        // Measured: 400 with pydantic's TEXT report, where the rest of the router
        // answers 422 with a structured detail. Recorded as measured, not judged.
        const res = await request.post("/api/v1/flows/expand/", {
          headers: { Authorization: authToken },
          data: {},
        });
        expect(res.status()).toBe(400);
        const detail = (await res.json()).detail;
        expect(typeof detail).toBe("string");
        expect(detail).toContain("CompactFlowData");
        expect(detail).toContain("nodes");
        expect(detail).toContain("edges");
      });

      await test.step("an empty compact graph expands to itself", async () => {
        const res = await request.post("/api/v1/flows/expand/", {
          headers: { Authorization: authToken },
          data: { nodes: [], edges: [] },
        });
        expect(res.status()).toBe(200);
        expect(await res.json()).toEqual({ nodes: [], edges: [] });
      });
    },
  );
});
