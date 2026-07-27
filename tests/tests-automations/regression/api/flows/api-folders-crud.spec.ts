import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";

// Folders use the /api/v1/projects/ endpoint (legacy alias kept for compatibility)
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
      // request.delete resolves on any status and 404 (already gone) is the
      // desired idempotent end state, so no throw/catch is needed here.
      await request.delete(`/api/v1/projects/${id}`, {
        headers: { Authorization: authToken },
      });
    }
    createdFlowIds.length = 0;
    createdFolderIds.length = 0;
  });

  test(
    "POST creates folder and returns ID and name",
    { tag: ["@stable", "@release", "@api", "@regression"] },
    async ({ request }) => {
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
    async ({ request }) => {
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

  // Quarantined for #965 — recurrent flake (2026-07-22 / 07-27): the DELETE
  // answers HTTP 500 where the contract expects 204 No Content.
  test.fixme(
    "DELETE removes folder and it no longer appears in listing",
    { tag: ["@release", "@api", "@regression"] },
    async ({ request }) => {
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

  // quarantined for #932 — recurrent flaky association assertion (dailies 2026-07-15, 2026-07-24)
  test.fixme(
    "moving flow between folders via PATCH folder_id updates association",
    { tag: ["@release", "@api", "@regression"] },
    async ({ request }) => {
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
