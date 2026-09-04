import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import { deleteProject } from "../../../../helpers/flows/delete-project";

// Six of the eight /api/v1/projects operations as a contract.
// Spec doc: docs/api/projects/api-projects-crud.md
//
// The projects endpoints are the subject here, so every one of them is issued
// with a raw request.* call — createProjectViaApi asserts the create response
// itself and would hide the shape this file is about.
test.describe("Projects API — CRUD", () => {
  const UNKNOWN_ID = "00000000-0000-4000-8000-000000000000";

  // Keys measured on 1.13.0.dev0. Asserted as exact sets, not one property at a
  // time: the finding this file pins is that the three reads return three
  // different shapes, which a toHaveProperty("id") cannot see.
  const CREATE_KEYS = ["auth_settings", "description", "id", "name", "parent_id"];
  const LIST_ROW_KEYS = [...CREATE_KEYS, "is_owner", "owner_username"].sort();
  const READ_KEYS = [...CREATE_KEYS, "flows"].sort();

  const createdFlowIds: string[] = [];
  const createdProjectIds: string[] = [];

  // Names are kept SHORT on purpose, and the reason is a filed product defect.
  // Creating a project derives an MCP server named `lf-${sanitize_mcp_name(name)[:26]}`
  // (`MAX_MCP_SERVER_NAME_LENGTH` = 30 minus the `lf-` prefix) which must be unique
  // per user, so two projects whose names share their first 26 characters are
  // refused with `409 MCP server name conflict` — #1409, reproducible with two
  // ordinary names, documented in docs/mcp/server/mcp-server-project-config.md.
  // It bites this file twice: the label + base36 timestamp + suffix has to stay
  // inside the cut, and the duplicate-name test needs room for the ` (1)` the API
  // appends (` (1)` sanitizes to `_1`), or the twin truncates back onto the
  // original slug and the 201 this file asserts becomes a 409.
  const uniqueName = (label: string) =>
    `${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

  test.afterEach(async ({ request }) => {
    const headers = { Authorization: await getAuthToken(request) };
    // Flows first: a project delete cascades, but a flow whose project is
    // already gone would be unreachable by this id-scoped sweep.
    for (const id of createdFlowIds) {
      await deleteFlow(request, id, { headers }).catch((error) => {
        console.warn(`⚠️ Orphan flow left behind (${id}): ${error}`);
      });
    }
    for (const id of createdProjectIds) {
      // deleteProject, not a bare delete: it verifies the deletion and retries
      // the transient 500 of #965 in TEARDOWN only. The assertion under test
      // below stays a bare 204 — it is what surfaced that defect.
      await deleteProject(request, id, { headers }).catch((error) => {
        console.warn(`⚠️ Orphan project left behind (${id}): ${error}`);
      });
    }
    createdFlowIds.length = 0;
    createdProjectIds.length = 0;
  });

  async function createProject(
    request: APIRequestContext,
    headers: Record<string, string>,
    name: string,
    description?: string,
  ) {
    const res = await request.post("/api/v1/projects/", {
      headers,
      data: description === undefined ? { name } : { name, description },
    });
    expect(res.status(), await res.text()).toBe(201);
    const body = await res.json();
    createdProjectIds.push(body.id);
    return body;
  }

  test(
    "a project is created, listed, read with its flows and deleted by id",
    { tag: ["@stable", "@api", "@workspace"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        "POST /api/v1/projects/",
        "GET /api/v1/projects/",
        "GET /api/v1/projects/{project_id}",
        "DELETE /api/v1/projects/{project_id}",
      ]);
      const headers = { Authorization: await getAuthToken(request) };
      const name = uniqueName("pcrud");
      let projectId = "";
      let flowId = "";

      await test.step("POST returns the created project, without a flows key", async () => {
        const body = await createProject(request, headers, name, "created by the CRUD spec");
        projectId = body.id;
        expect(Object.keys(body).sort()).toEqual([...CREATE_KEYS].sort());
        expect(body.name).toBe(name);
        expect(body.description).toBe("created by the CRUD spec");
        expect(body.parent_id).toBeNull();
      });

      await test.step("the list row carries ownership the create response does not", async () => {
        const res = await request.get("/api/v1/projects/", { headers });
        expect(res.status()).toBe(200);
        const rows = await res.json();
        expect(Array.isArray(rows)).toBe(true);
        // Id-scoped: the list is instance-wide and other workers create projects
        // in parallel, so a length or an "only mine" assertion would be a race.
        const mine = rows.find((r: { id: string }) => r.id === projectId);
        expect(mine, `project ${projectId} missing from GET /api/v1/projects/`).toBeTruthy();
        expect(Object.keys(mine).sort()).toEqual(LIST_ROW_KEYS);
        expect(mine.is_owner).toBe(true);
        expect(typeof mine.owner_username).toBe("string");
        expect(mine.owner_username.length).toBeGreaterThan(0);
      });

      await test.step("GET by id adds the project's flows", async () => {
        const flowRes = await request.post("/api/v1/flows/", {
          headers,
          data: {
            name: `${name}-flow`,
            description: "flow of the CRUD spec",
            data: { nodes: [], edges: [] },
            folder_id: projectId,
          },
        });
        expect(flowRes.status(), await flowRes.text()).toBe(201);
        flowId = (await flowRes.json()).id;
        createdFlowIds.push(flowId);

        const res = await request.get(`/api/v1/projects/${projectId}`, { headers });
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(Object.keys(body).sort()).toEqual(READ_KEYS);
        expect(body.flows.map((f: { id: string }) => f.id)).toEqual([flowId]);
      });

      await test.step("the same read with page/size answers a different envelope", async () => {
        const res = await request.get(`/api/v1/projects/${projectId}?page=1&size=1`, { headers });
        expect(res.status()).toBe(200);
        const body = await res.json();
        // One operation, two shapes: the paginated read returns the project
        // under `folder` and the page under `flows`, with no top-level id.
        expect(Object.keys(body).sort()).toEqual(["flows", "folder"]);
        expect(body.folder.id).toBe(projectId);
      });

      await test.step("DELETE answers 204, cascades to the flows, and is not repeatable", async () => {
        const res = await request.delete(`/api/v1/projects/${projectId}`, { headers });
        // Bare 204 on purpose — the assertion that surfaced LE-2020 (#965).
        expect(res.status()).toBe(204);
        createdProjectIds.length = 0;

        const flow = await request.get(`/api/v1/flows/${flowId}`, { headers });
        expect(flow.status(), "deleting a project deletes the flows inside it").toBe(404);
        createdFlowIds.length = 0;

        const again = await request.delete(`/api/v1/projects/${projectId}`, { headers });
        expect(again.status()).toBe(404);
        expect((await again.json()).detail).toBe("Project not found");
      });
    },
  );

  test(
    "PATCH is partial, PUT merges but refuses a body without a name",
    { tag: ["@stable", "@api", "@workspace"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        "PATCH /api/v1/projects/{project_id}",
        "PUT /api/v1/projects/{project_id}",
      ]);
      const headers = { Authorization: await getAuthToken(request) };
      const name = uniqueName("pverb");
      const project = await createProject(request, headers, name, "description-original");

      await test.step("PATCH with only a description keeps the name", async () => {
        const res = await request.patch(`/api/v1/projects/${project.id}`, {
          headers,
          data: { description: "description-patched" },
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(body.description).toBe("description-patched");
        expect(body.name).toBe(name);
      });

      await test.step("PUT without a name is refused on the field, not on the id", async () => {
        const res = await request.put(`/api/v1/projects/${project.id}`, {
          headers,
          data: { description: "description-put" },
        });
        expect(res.status()).toBe(422);
        const detail = (await res.json()).detail[0];
        expect(detail.loc).toEqual(["body", "name"]);
        expect(detail.type).toBe("missing");
      });

      await test.step("PUT with a name merges — the description survives it", async () => {
        const res = await request.put(`/api/v1/projects/${project.id}`, {
          headers,
          data: { name: `${name}-r` },
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(body.name).toBe(`${name}-r`);
        // The finding: PUT and PATCH differ in what they REQUIRE, not in what
        // they do with the rest of the row.
        expect(body.description).toBe("description-patched");
      });

      await test.step("the read confirms the last write and nothing else moved", async () => {
        const res = await request.get(`/api/v1/projects/${project.id}`, { headers });
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(body.name).toBe(`${name}-r`);
        expect(body.description).toBe("description-patched");
        expect(body.flows).toEqual([]);
      });
    },
  );

  test(
    "a duplicate name is suffixed and the required field is enforced",
    { tag: ["@stable", "@api", "@workspace"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare(["POST /api/v1/projects/", "GET /api/v1/projects/{project_id}"]);
      const headers = { Authorization: await getAuthToken(request) };
      const name = uniqueName("pdup");

      const first = await createProject(request, headers, name, "the first one");

      await test.step("the second project with the same name is accepted and suffixed", async () => {
        const twin = await createProject(request, headers, name, "the second one");
        expect(twin.name).toBe(`${name} (1)`);
        // Only the NAME is rewritten — the rest of the body is stored as sent.
        expect(twin.description).toBe("the second one");
        expect(twin.id).not.toBe(first.id);
      });

      await test.step("a body with no name is refused on the field", async () => {
        const res = await request.post("/api/v1/projects/", {
          headers,
          data: { description: "nameless" },
        });
        expect(res.status()).toBe(422);
        const detail = (await res.json()).detail[0];
        expect(detail.loc).toEqual(["body", "name"]);
        expect(detail.type).toBe("missing");
      });

      await test.step("an unknown id is a 404 with the documented message", async () => {
        const res = await request.get(`/api/v1/projects/${UNKNOWN_ID}`, { headers });
        expect(res.status()).toBe(404);
        expect((await res.json()).detail).toBe("Project not found");
      });
    },
  );
});
