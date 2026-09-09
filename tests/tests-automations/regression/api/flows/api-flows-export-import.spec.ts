import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import {
  createProjectViaApi,
  type CreatedProject,
} from "../../../../helpers/flows/create-project-via-api";

// Export (`download/`) and import (`upload/`) as a round-trip contract. Spec doc:
// docs/api/flows/api-flows-export-import.md
//
// Measured on 1.13.0.dev0: one id downloads as a single JSON object stripped of the
// server-side fields, two ids download as a ZIP; an upload is an UPSERT keyed by the
// export's `id` — it updates a live flow in place, recreates a deleted one under the
// same id, and mints a new id only when the export carries none.
test.describe("Flows API — export and import", () => {
  const FLOW_BASE = { description: "export-import", data: { nodes: [], edges: [] } };
  const uniqueName = (label: string) =>
    `api-flows-export ${label} ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

  const createdFlowIds: string[] = [];
  const createdProjects: CreatedProject[] = [];

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
    // Projects last: deleting one can take its flows with it, and the id-scoped
    // flow sweep above must not be turned into a stream of 404s by that.
    for (const project of createdProjects) {
      await project.deleteProject(request).catch((error) => {
        console.warn(`⚠️ Orphan project left behind (${project.projectId}): ${error}`);
      });
    }
    createdProjects.length = 0;
  });

  async function createFlow(
    request: Parameters<typeof getAuthToken>[0],
    authToken: string,
    label: string,
    folderId?: string,
  ): Promise<{ id: string; name: string; updated_at: string }> {
    const res = await request.post("/api/v1/flows/", {
      headers: { Authorization: authToken },
      data: {
        ...FLOW_BASE,
        name: uniqueName(label),
        ...(folderId ? { folder_id: folderId } : {}),
      },
    });
    expect(res.status()).toBe(201);
    const flow = await res.json();
    createdFlowIds.push(flow.id);
    return flow;
  }

  // Scoped to ONE project, which is the whole point (#1773): a global count is
  // state every parallel worker also writes.
  //
  // `get_all=false` is load-bearing. The default `get_all=true` branch of
  // `read_flows` returns every flow the user owns and never applies `folder_id`
  // — measured, it answered 37 for a project holding 1 — and only the paginated
  // branch honours the filter, answering an envelope rather than a bare list.
  async function countFlowsInProject(
    request: Parameters<typeof getAuthToken>[0],
    authToken: string,
    projectId: string,
  ): Promise<number> {
    const res = await request.get(
      `/api/v1/flows/?get_all=false&folder_id=${projectId}`,
      { headers: { Authorization: authToken } },
    );
    expect(res.status()).toBe(200);
    const page = await res.json();
    expect(
      page,
      "get_all=false answers a paginated envelope, not a list",
    ).toHaveProperty("total");
    return page.total as number;
  }

  async function upload(
    request: Parameters<typeof getAuthToken>[0],
    authToken: string,
    exportJson: Buffer,
  ): Promise<
    Array<{ id: string; updated_at: string; name: string; folder_id: string }>
  > {
    const res = await request.post("/api/v1/flows/upload/", {
      headers: { Authorization: authToken },
      multipart: {
        file: { name: "flow.json", mimeType: "application/json", buffer: exportJson },
      },
    });
    expect(res.status()).toBe(201);
    const flows = await res.json();
    expect(Array.isArray(flows)).toBe(true);
    for (const f of flows) {
      if (!createdFlowIds.includes(f.id)) createdFlowIds.push(f.id);
    }
    return flows;
  }

  test(
    "exports one flow as JSON and two as a ZIP",
    { tag: ["@stable", "@api", "@workspace"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare(["POST /api/v1/flows/", "POST /api/v1/flows/download/"]);
      const authToken = await getAuthToken(request);
      const a = await createFlow(request, authToken, "zip-a");
      const b = await createFlow(request, authToken, "zip-b");

      await test.step("one id downloads as a portable JSON object", async () => {
        const res = await request.post("/api/v1/flows/download/", {
          headers: { Authorization: authToken },
          data: [a.id],
        });
        expect(res.status()).toBe(200);
        expect(res.headers()["content-type"]).toContain("application/json");
        const body = await res.json();
        expect(body.id).toBe(a.id);
        expect(body.name).toBe(a.name);
        expect(body.data).toEqual({ nodes: [], edges: [] });
        // The export is portable, not a database row: the server-side fields are
        // absent, and asserting only the presence of `id` would miss a leak of them.
        for (const key of ["updated_at", "user_id", "folder_id"]) {
          expect(body, `export must not carry ${key}`).not.toHaveProperty(key);
        }
      });

      await test.step("two ids download as a ZIP holding both", async () => {
        const res = await request.post("/api/v1/flows/download/", {
          headers: { Authorization: authToken },
          data: [a.id, b.id],
        });
        expect(res.status()).toBe(200);
        expect(res.headers()["content-type"]).toBe("application/x-zip-compressed");
        const zip = await res.body();
        expect(zip.subarray(0, 4)).toEqual(ZIP_MAGIC);
        const asText = zip.toString("latin1");
        expect(asText).toContain(`${a.name}.json`);
        expect(asText).toContain(`${b.name}.json`);
      });
    },
  );

  test(
    "importing an export of an existing flow updates it in place",
    { tag: ["@stable", "@api", "@workspace"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        "POST /api/v1/projects/",
        "POST /api/v1/flows/",
        "POST /api/v1/flows/download/",
        "POST /api/v1/flows/upload/",
        "GET /api/v1/flows/",
        "DELETE /api/v1/projects/{project_id}",
      ]);
      const authToken = await getAuthToken(request);

      // The isolation boundary. The flow count either side of the upload used to
      // be read GLOBALLY, over a flow space every parallel worker also writes:
      // a neighbour creating a flow inside the download/upload window reddened it
      // (`Expected: 27, Received: 29`, run 34304431241), and a neighbour that
      // created one flow and deleted another left it unchanged while a duplicate
      // existed. Nobody else writes into a project this test just created, so
      // inside it "no row appeared" is legitimate again (#1773).
      const project = await createProjectViaApi(
        request,
        { Authorization: authToken },
        { namePrefix: "api-flows-export-upsert" },
      );
      createdProjects.push(project);

      const flow = await createFlow(request, authToken, "upsert", project.projectId);
      const before = await countFlowsInProject(request, authToken, project.projectId);
      expect(before, "the test's project holds only its own flow").toBe(1);

      const exported = await request.post("/api/v1/flows/download/", {
        headers: { Authorization: authToken },
        data: [flow.id],
      });
      expect(exported.status()).toBe(200);
      const exportJson = await exported.body();

      await test.step("upload answers 201 with the SAME id and a newer updated_at", async () => {
        const uploaded = await upload(request, authToken, exportJson);
        expect(uploaded).toHaveLength(1);
        expect(uploaded[0].id).toBe(flow.id);
        expect(new Date(uploaded[0].updated_at).getTime()).toBeGreaterThanOrEqual(
          new Date(flow.updated_at).getTime(),
        );
        // The export carries no `folder_id`, so the upsert takes its destination
        // from the row it updates. Asserted, not assumed: the day that changes,
        // the project scope below would silently stop covering the flow.
        expect(uploaded[0].folder_id).toBe(project.projectId);
      });

      await test.step("no copy was created", async () => {
        // Both halves matter: the preserved id alone would also be satisfied by an
        // endpoint that created a duplicate and echoed the export's id back.
        expect(
          await countFlowsInProject(request, authToken, project.projectId),
        ).toBe(before);
      });
    },
  );

  test(
    "an import keeps the export's id, or mints one when it has none",
    { tag: ["@stable", "@api", "@workspace"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        "POST /api/v1/flows/",
        "POST /api/v1/flows/download/",
        "DELETE /api/v1/flows/{flow_id}",
        "GET /api/v1/flows/{flow_id}",
        "POST /api/v1/flows/upload/",
      ]);
      const authToken = await getAuthToken(request);
      const flow = await createFlow(request, authToken, "recreate");

      const exported = await request.post("/api/v1/flows/download/", {
        headers: { Authorization: authToken },
        data: [flow.id],
      });
      expect(exported.status()).toBe(200);
      const exportJson = await exported.body();

      await test.step("delete the original", async () => {
        const del = await request.delete(`/api/v1/flows/${flow.id}`, {
          headers: { Authorization: authToken },
        });
        expect(del.status()).toBe(200);
        const gone = await request.get(`/api/v1/flows/${flow.id}`, {
          headers: { Authorization: authToken },
        });
        expect(gone.status()).toBe(404);
      });

      await test.step("re-importing the export recreates the flow under its old id", async () => {
        const uploaded = await upload(request, authToken, exportJson);
        expect(uploaded).toHaveLength(1);
        expect(uploaded[0].id).toBe(flow.id);
      });

      await test.step("an export without an id is imported under a new one", async () => {
        const stripped = JSON.parse(exportJson.toString("utf8"));
        delete stripped.id;
        stripped.name = uniqueName("no-id");
        const uploaded = await upload(
          request,
          authToken,
          Buffer.from(JSON.stringify(stripped)),
        );
        expect(uploaded).toHaveLength(1);
        expect(uploaded[0].id).not.toBe(flow.id);
        expect(uploaded[0].name).toBe(stripped.name);
      });
    },
  );
});
