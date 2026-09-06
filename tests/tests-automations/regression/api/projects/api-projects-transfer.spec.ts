import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import { deleteProject } from "../../../../helpers/flows/delete-project";
import { createProjectViaApi } from "../../../../helpers/flows/create-project-via-api";

// The two transfer operations of the projects family — export as an archive and
// import one back. Spec doc: docs/api/projects/api-projects-transfer.md
//
// The finding this file pins is the asymmetry with the sibling importer:
// POST /api/v1/flows/upload/ UPSERTS by id (measured in #1699), while
// POST /api/v1/projects/upload/ REFUSES the same collision with a 422.
test.describe("Projects API — download and upload", () => {
  const createdFlowIds: string[] = [];
  const createdProjectIds: string[] = [];
  // Names an import is EXPECTED to create, registered before the upload rather
  // than after it. The imported project's id only exists in a later response, so
  // a failure between the upload and that read used to leak it — measured: a
  // force-fail mutation on the id assertion left `pimp-…` behind. The name is
  // unique per run, so sweeping by it is still id-scoped in effect.
  const importedProjectNames: string[] = [];

  // Short names: creating a project derives an MCP server named
  // `lf-${sanitize_mcp_name(name)[:26]}` which must be unique per user, so two
  // projects sharing their first 26 characters are refused with a 409 (#1409).
  // The UPLOADED FILE NAME becomes the imported project's name, so it is subject
  // to the same rule.
  const uniqueName = (label: string) =>
    `${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

  test.afterEach(async ({ request }) => {
    const headers = { Authorization: await getAuthToken(request) };
    // Resolve any project an import may have created, however the test ended.
    if (importedProjectNames.length > 0) {
      const list = await request.get("/api/v1/projects/", { headers });
      if (list.ok()) {
        const rows = (await list.json()) as Array<{ id: string; name: string }>;
        for (const row of rows) {
          if (!importedProjectNames.includes(row.name)) continue;
          if (!createdProjectIds.includes(row.id)) createdProjectIds.push(row.id);
          const read = await request.get(`/api/v1/projects/${row.id}`, { headers });
          if (!read.ok()) continue;
          for (const flow of (await read.json()).flows ?? []) {
            if (!createdFlowIds.includes(flow.id)) createdFlowIds.push(flow.id);
          }
        }
      }
      importedProjectNames.length = 0;
    }
    for (const id of createdFlowIds) {
      await deleteFlow(request, id, { headers }).catch((error) => {
        console.warn(`⚠️ Orphan flow left behind (${id}): ${error}`);
      });
    }
    for (const id of createdProjectIds) {
      await deleteProject(request, id, { headers }).catch((error) => {
        console.warn(`⚠️ Orphan project left behind (${id}): ${error}`);
      });
    }
    createdFlowIds.length = 0;
    createdProjectIds.length = 0;
  });

  /** A project with one trivial flow in it — the smallest downloadable subject. */
  async function projectWithOneFlow(
    request: APIRequestContext,
    headers: Record<string, string>,
    label: string,
  ): Promise<{ projectId: string; flowId: string }> {
    const project = await createProjectViaApi(request, headers, {
      namePrefix: label,
      description: "transfer spec fixture",
    });
    createdProjectIds.push(project.projectId);

    const res = await request.post("/api/v1/flows/", {
      headers,
      data: {
        name: `${project.name}-flow`,
        description: "transfer spec fixture",
        data: { nodes: [], edges: [] },
        folder_id: project.projectId,
      },
    });
    expect(res.status(), await res.text()).toBe(201);
    const flowId = (await res.json()).id as string;
    createdFlowIds.push(flowId);
    return { projectId: project.projectId, flowId };
  }

  test(
    "download refuses an empty project and returns a ZIP for a populated one",
    { tag: ["@stable", "@api", "@workspace"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare(["GET /api/v1/projects/download/{project_id}"]);
      const headers = { Authorization: await getAuthToken(request) };
      const project = await createProjectViaApi(request, headers, {
        namePrefix: "pdl",
        description: "transfer spec fixture",
      });
      createdProjectIds.push(project.projectId);

      await test.step("an empty project is not downloadable", async () => {
        const res = await request.get(`/api/v1/projects/download/${project.projectId}`, {
          headers,
        });
        expect(res.status()).toBe(404);
        expect((await res.json()).detail).toBe("No flows found in project");
      });

      await test.step("with one flow the body is a ZIP archive", async () => {
        const flowRes = await request.post("/api/v1/flows/", {
          headers,
          data: {
            name: `${project.name}-flow`,
            description: "transfer spec fixture",
            data: { nodes: [], edges: [] },
            folder_id: project.projectId,
          },
        });
        expect(flowRes.status(), await flowRes.text()).toBe(201);
        createdFlowIds.push((await flowRes.json()).id);

        const res = await request.get(`/api/v1/projects/download/${project.projectId}`, {
          headers,
        });
        expect(res.status()).toBe(200);
        const body = await res.body();
        // Asserted by magic bytes, not by Content-Type: the endpoint sets none.
        expect(body.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
        expect(body.byteLength).toBeGreaterThan(100);
      });
    },
  );

  test(
    "upload refuses colliding flow ids and imports the archive once they are gone",
    { tag: ["@stable", "@api", "@workspace"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare(["POST /api/v1/projects/upload/"]);
      const headers = { Authorization: await getAuthToken(request) };
      const { projectId, flowId } = await projectWithOneFlow(request, headers, "pup");
      const fileName = uniqueName("pimp");

      const download = await request.get(`/api/v1/projects/download/${projectId}`, { headers });
      expect(download.status()).toBe(200);
      const archive = await download.body();

      const upload = async (name: string, buffer: Buffer, mimeType: string) => {
        // Registered BEFORE the request: a successful upload creates a project
        // named after the file, and the teardown must know about it even if the
        // assertion that reads its id never runs.
        importedProjectNames.push(name.replace(/\.[^.]+$/, ""));
        return request.post("/api/v1/projects/upload/", {
          headers,
          multipart: { file: { name, mimeType, buffer } },
        });
      };

      await test.step("re-importing while the flow still exists is refused on the id", async () => {
        const res = await upload(`${fileName}.zip`, archive, "application/zip");
        expect(res.status()).toBe(422);
        const detail = (await res.json()).detail as string;
        expect(detail).toContain("already exist");
        // The id is named, which is what makes this a refusal and not a generic
        // validation error — and it is why the happy path needs a clean slate.
        expect(detail).toContain(flowId);
      });

      await test.step("with the source gone the archive imports and keeps the flow id", async () => {
        await deleteFlow(request, flowId, { headers });
        createdFlowIds.length = 0;
        await deleteProject(request, projectId, { headers });
        createdProjectIds.length = 0;

        const res = await upload(`${fileName}.zip`, archive, "application/zip");
        expect(res.status(), await res.text()).toBe(201);
        const flows = await res.json();
        // The body is the imported FLOWS, not the project that now holds them.
        expect(Array.isArray(flows)).toBe(true);
        expect(flows).toHaveLength(1);
        expect(flows[0].id).toBe(flowId);
        createdFlowIds.push(flows[0].id);
      });

      await test.step("the imported project is named after the uploaded file", async () => {
        const list = await request.get("/api/v1/projects/", { headers });
        expect(list.status()).toBe(200);
        const rows = (await list.json()) as Array<{ id: string; name: string }>;
        // Id-scoped by construction: the file name is unique to this run, so this
        // never matches another worker's project.
        const imported = rows.find((r) => r.name === fileName);
        expect(imported, `no project named "${fileName}" after the import`).toBeTruthy();
        createdProjectIds.push(imported!.id);

        const read = await request.get(`/api/v1/projects/${imported!.id}`, { headers });
        expect(read.status()).toBe(200);
        expect((await read.json()).flows.map((f: { id: string }) => f.id)).toEqual([flowId]);
      });

      await test.step("a part that is not an archive is refused as unparseable", async () => {
        const res = await upload(
          `${uniqueName("pbad")}.txt`,
          Buffer.from("not an archive"),
          "text/plain",
        );
        expect(res.status()).toBe(400);
        expect((await res.json()).detail).toContain("Invalid JSON file");
      });
    },
  );
});
