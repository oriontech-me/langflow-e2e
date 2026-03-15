import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";

// Folders use the /api/v1/projects/ endpoint (legacy alias kept for compatibility)
test.describe("Folder (Projects) CRUD via API", () => {
  test(
    "POST creates folder and returns ID and name",
    { tag: ["@release", "@api", "@regression"] },
    async ({ request }) => {
      const authToken = await getAuthToken(request);
      const folderName = `Test Folder ${Date.now()}`;

      const createRes = await request.post("/api/v1/projects/", {
        headers: { Authorization: authToken },
        data: { name: folderName, description: "Folder criado pelo teste" },
      });

      expect(createRes.status()).toBe(201);

      const folder = await createRes.json();
      expect(folder).toHaveProperty("id");
      expect(typeof folder.id).toBe("string");
      expect(folder.name).toBe(folderName);

      // Cleanup
      await request.delete(`/api/v1/projects/${folder.id}`, {
        headers: { Authorization: authToken },
      });
    },
  );

  test(
    "GET lists folders and includes the created one",
    { tag: ["@release", "@api", "@regression"] },
    async ({ request }) => {
      const authToken = await getAuthToken(request);
      const folderName = `List Folder ${Date.now()}`;

      const createRes = await request.post("/api/v1/projects/", {
        headers: { Authorization: authToken },
        data: { name: folderName },
      });
      expect(createRes.status()).toBe(201);
      const { id } = await createRes.json();

      const listRes = await request.get("/api/v1/projects/", {
        headers: { Authorization: authToken },
      });
      expect(listRes.status()).toBe(200);

      const folders = await listRes.json();
      const folderList = Array.isArray(folders) ? folders : (folders.folders ?? []);
      const found = folderList.find((f: any) => f.id === id);
      expect(found).toBeDefined();
      expect(found.name).toBe(folderName);

      // Cleanup
      await request.delete(`/api/v1/projects/${id}`, {
        headers: { Authorization: authToken },
      });
    },
  );

  test(
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

  test(
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

      const folder2Res = await request.post("/api/v1/projects/", {
        headers: { Authorization: authToken },
        data: { name: `Folder B ${Date.now()}` },
      });
      expect(folder2Res.status()).toBe(201);
      const folder2 = await folder2Res.json();

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

      // Cleanup
      await request.delete(`/api/v1/flows/${flow.id}`, {
        headers: { Authorization: authToken },
      });
      await request.delete(`/api/v1/projects/${folder1.id}`, {
        headers: { Authorization: authToken },
      });
      await request.delete(`/api/v1/projects/${folder2.id}`, {
        headers: { Authorization: authToken },
      });
    },
  );
});
