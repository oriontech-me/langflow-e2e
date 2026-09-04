import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import { deleteProject } from "../../../../helpers/flows/delete-project";

// Folders use the /api/v1/projects/ endpoint (legacy alias kept for compatibility).
// The alias itself — seven 307 redirects — is asserted by
// api/projects/api-folders-alias-redirects.spec.ts, and the projects contract this
// file only samples is covered by api/projects/api-projects-crud.spec.ts (#1707).
// The apiCoverage declarations below are that adoption: they credit the operations
// these tests already drive and assert, and the fixture fails the test if a declared
// operation is never issued.
test.describe("Folder (Projects) CRUD via API", () => {
  // Id-scoped cleanup: each test pushes the ids it creates from the POST 201
  // response, and afterEach deletes exactly those. Inline cleanup at the end of
  // a test never runs when an assertion throws first, leaking folders/flows —
  // afterEach always runs. Targeted delete only (never a global wipe), which
  // under the suite's parallelism would nuke concurrent workers' data.
  const createdFolderIds: string[] = [];
  const createdFlowIds: string[] = [];

  test.afterEach(async ({ request }) => {
    const authToken = await getAuthToken(request);
    // Flows first — a folder holding flows may refuse deletion otherwise.
    for (const id of createdFlowIds) {
      await deleteFlow(request, id, { headers: { Authorization: authToken } });
    }
    for (const id of createdFolderIds) {
      // deleteProject, not a bare request.delete: the endpoint answers 500
      // instead of 204 under concurrent writes (#965, a product defect), and a
      // bare call resolves on any status — so every such teardown used to leave
      // a permanent orphan project behind. The helper verifies the deletion and
      // retries the transient 5xx; a still-failing cleanup is logged rather than
      // failing this hook, so it can never mask the assertion that already ran.
      await deleteProject(request, id, {
        headers: { Authorization: authToken },
      }).catch((error) => {
        console.warn(`⚠️ Orphan project left behind (${id}): ${error}`);
      });
    }
    createdFlowIds.length = 0;
    createdFolderIds.length = 0;
  });

  test(
    "POST creates folder and returns ID and name",
    { tag: ["@stable", "@release", "@api", "@regression"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare(["POST /api/v1/projects/"]);
      const authToken = await getAuthToken(request);
      const folderName = `Test Folder ${Date.now()}`;

      const createRes = await request.post("/api/v1/projects/", {
        headers: { Authorization: authToken },
        data: { name: folderName, description: "Folder created by the test" },
      });

      expect(createRes.status()).toBe(201);

      const folder = await createRes.json();
      createdFolderIds.push(folder.id);
      expect(folder).toHaveProperty("id");
      expect(typeof folder.id).toBe("string");
      expect(folder.name).toBe(folderName);
    },
  );

  test(
    "GET lists folders and includes the created one",
    { tag: ["@stable", "@release", "@api", "@regression"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare(["POST /api/v1/projects/", "GET /api/v1/projects/"]);
      const authToken = await getAuthToken(request);
      const folderName = `List Folder ${Date.now()}`;

      const createRes = await request.post("/api/v1/projects/", {
        headers: { Authorization: authToken },
        data: { name: folderName },
      });
      expect(createRes.status()).toBe(201);
      const { id } = await createRes.json();
      createdFolderIds.push(id);

      const listRes = await request.get("/api/v1/projects/", {
        headers: { Authorization: authToken },
      });
      expect(listRes.status()).toBe(200);

      const folders = await listRes.json();
      const folderList = Array.isArray(folders) ? folders : (folders.folders ?? []);
      const found = folderList.find((f: any) => f.id === id);
      expect(found).toBeDefined();
      expect(found.name).toBe(folderName);
    },
  );

  // Quarantine lifted (#965). This test was `test.fixme` against LE-2020
  // (https://datastax.jira.com/browse/LE-2020): the DELETE answered HTTP 500
  // (`sqlite3.OperationalError: database is locked`) instead of the contracted
  // 204, and the folder survived — measured at 11/24 and 12/24 with 2 concurrent
  // clients. Upstream shipped `services/database/lock_retry.py` and wrapped this
  // endpoint in `run_with_lock_retry` (langflow#14308, forward-ported to
  // `release-1.12.0`); the module and the call site are both present in
  // `1.12.0.dev23`, and the repro script now measures 24/24 at P=2 and 32/32 at
  // P=4 (`docs/upstream-bugs/scripts/scout-965-scope.py`). The 204 assertion
  // deliberately stays bare — it is what surfaced the defect.
  test(
    "DELETE removes folder and it no longer appears in listing",
    { tag: ["@stable", "@release", "@api", "@regression"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        "POST /api/v1/projects/",
        "GET /api/v1/projects/",
        "DELETE /api/v1/projects/{project_id}",
      ]);
      const authToken = await getAuthToken(request);
      const folderName = `Delete Folder ${Date.now()}`;

      const createRes = await request.post("/api/v1/projects/", {
        headers: { Authorization: authToken },
        data: { name: folderName },
      });
      expect(createRes.status()).toBe(201);
      const { id } = await createRes.json();
      createdFolderIds.push(id);

      const deleteRes = await request.delete(`/api/v1/projects/${id}`, {
        headers: { Authorization: authToken },
      });
      // Projects DELETE returns 204 No Content
      expect(deleteRes.status()).toBe(204);

      // Folder must not appear in listing after deletion
      const listRes = await request.get("/api/v1/projects/", {
        headers: { Authorization: authToken },
      });
      expect(listRes.status()).toBe(200);
      const folders = await listRes.json();
      const folderList = Array.isArray(folders) ? folders : (folders.folders ?? []);
      const found = folderList.find((f: any) => f.id === id);
      expect(found).toBeUndefined();
    },
  );

  // Quarantine lifted (#932). Same root cause and same upstream ticket as the
  // DELETE above (LE-2020), on a second endpoint: `PATCH /api/v1/flows/{id}`
  // answered 500 on `UPDATE flow SET folder_id` with two concurrent writers
  // (14/24 at P=2, 0/30 serial), which Playwright rendered as an "Object.is
  // equality" mismatch and made this read as a stale association. `flows.py` now
  // wraps its update path in `run_with_lock_retry` on `release-1.12.0`, present
  // in `1.12.0.dev23`; the probe measures 32/32 PATCH 200 with the association
  // persisted at P=4 (`docs/upstream-bugs/scripts/scout-932-probe.py`).
  test(
    "moving flow between folders via PATCH folder_id updates association",
    { tag: ["@stable", "@release", "@api", "@regression"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        "POST /api/v1/projects/",
        "POST /api/v1/flows/",
        "PATCH /api/v1/flows/{flow_id}",
        "GET /api/v1/flows/{flow_id}",
      ]);
      const authToken = await getAuthToken(request);

      // Create two folders
      const folder1Res = await request.post("/api/v1/projects/", {
        headers: { Authorization: authToken },
        data: { name: `Folder A ${Date.now()}` },
      });
      expect(folder1Res.status()).toBe(201);
      const folder1 = await folder1Res.json();
      createdFolderIds.push(folder1.id);

      const folder2Res = await request.post("/api/v1/projects/", {
        headers: { Authorization: authToken },
        data: { name: `Folder B ${Date.now()}` },
      });
      expect(folder2Res.status()).toBe(201);
      const folder2 = await folder2Res.json();
      createdFolderIds.push(folder2.id);

      // Create a flow in folder 1
      const flowRes = await request.post("/api/v1/flows/", {
        headers: { Authorization: authToken },
        data: {
          name: `Move Test Flow ${Date.now()}`,
          folder_id: folder1.id,
          data: { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
          is_component: false,
        },
      });
      expect(flowRes.status()).toBe(201);
      const flow = await flowRes.json();
      createdFlowIds.push(flow.id);

      // Verify flow is in folder 1
      expect(flow.folder_id).toBe(folder1.id);

      // Move flow to folder 2 via PATCH
      const patchRes = await request.patch(`/api/v1/flows/${flow.id}`, {
        headers: { Authorization: authToken },
        data: { folder_id: folder2.id },
      });
      expect(patchRes.status()).toBe(200);

      // Verify flow now belongs to folder 2
      const getRes = await request.get(`/api/v1/flows/${flow.id}`, {
        headers: { Authorization: authToken },
      });
      expect(getRes.status()).toBe(200);
      const updatedFlow = await getRes.json();
      expect(updatedFlow.folder_id).toBe(folder2.id);
    },
  );
});
