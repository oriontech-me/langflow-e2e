import { expect, test } from "../../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../../helpers/other/await-bootstrap-test";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";

test(
  "creating a flow in a specific folder via API places it in that folder",
  { tag: ["@release", "@workspace", "@regression"] },
  async ({ request }) => {
    const authToken = await getAuthToken(request);

    // Create a folder
    const folderRes = await request.post("/api/v1/folders/", {
      headers: { Authorization: authToken },
      data: {
        name: `test-folder-${Date.now()}`,
        description: "Created by regression test",
      },
    });
    expect(folderRes.status()).toBe(201);
    const { id: folderId } = await folderRes.json();

    let flowId: string | undefined;
    try {
      // Create a flow inside that folder
      const flowRes = await request.post("/api/v1/flows/", {
        headers: { Authorization: authToken },
        data: {
          name: `folder-flow-${Date.now()}`,
          folder_id: folderId,
          data: {
            nodes: [],
            edges: [],
            viewport: { x: 0, y: 0, zoom: 1 },
          },
          is_component: false,
        },
      });
      expect(flowRes.status()).toBe(201);
      const flow = await flowRes.json();
      flowId = flow.id;

      // The API must echo back the same folder_id
      expect(flow.folder_id).toBe(folderId);
    } finally {
      if (flowId) {
        await request
          .delete(`/api/v1/flows/${flowId}`, {
            headers: { Authorization: authToken },
          })
          .catch(() => {});
      }
      await request
        .delete(`/api/v1/folders/${folderId}`, {
          headers: { Authorization: authToken },
        })
        .catch(() => {});
    }
  },
);

test(
  "moving a flow to another folder via API PATCH updates folder_id",
  { tag: ["@release", "@workspace", "@regression"] },
  async ({ request }) => {
    const authToken = await getAuthToken(request);

    // Create two folders
    const folder1Res = await request.post("/api/v1/folders/", {
      headers: { Authorization: authToken },
      data: {
        name: `move-src-${Date.now()}`,
        description: "Source folder",
      },
    });
    expect(folder1Res.status()).toBe(201);
    const { id: folder1Id } = await folder1Res.json();

    const folder2Res = await request.post("/api/v1/folders/", {
      headers: { Authorization: authToken },
      data: {
        name: `move-dst-${Date.now()}`,
        description: "Destination folder",
      },
    });
    expect(folder2Res.status()).toBe(201);
    const { id: folder2Id } = await folder2Res.json();

    let flowId: string | undefined;
    try {
      // Create a flow in folder 1
      const flowRes = await request.post("/api/v1/flows/", {
        headers: { Authorization: authToken },
        data: {
          name: `move-flow-${Date.now()}`,
          folder_id: folder1Id,
          data: {
            nodes: [],
            edges: [],
            viewport: { x: 0, y: 0, zoom: 1 },
          },
          is_component: false,
        },
      });
      expect(flowRes.status()).toBe(201);
      const flow = await flowRes.json();
      flowId = flow.id;
      expect(flow.folder_id).toBe(folder1Id);

      // Move the flow to folder 2 via PATCH
      const patchRes = await request.patch(`/api/v1/flows/${flowId}`, {
        headers: { Authorization: authToken },
        data: { folder_id: folder2Id },
      });
      expect(patchRes.status()).toBe(200);
      const updated = await patchRes.json();

      // The flow must now belong to folder 2
      expect(updated.folder_id).toBe(folder2Id);
    } finally {
      if (flowId) {
        await request
          .delete(`/api/v1/flows/${flowId}`, {
            headers: { Authorization: authToken },
          })
          .catch(() => {});
      }
      await request
        .delete(`/api/v1/folders/${folder1Id}`, {
          headers: { Authorization: authToken },
        })
        .catch(() => {});
      await request
        .delete(`/api/v1/folders/${folder2Id}`, {
          headers: { Authorization: authToken },
        })
        .catch(() => {});
    }
  },
);

test(
  "folder listing shows flows correctly via UI",
  { tag: ["@release", "@workspace", "@regression"] },
  async ({ page, request }) => {
    const authToken = await getAuthToken(request);
    const folderName = `ui-folder-${Date.now()}`;
    const flowName = `ui-flow-${Date.now()}`;

    // Create folder and flow via API
    const folderRes = await request.post("/api/v1/folders/", {
      headers: { Authorization: authToken },
      data: { name: folderName, description: "UI test folder" },
    });
    expect(folderRes.status()).toBe(201);
    const { id: folderId } = await folderRes.json();

    let flowId: string | undefined;
    try {
      const flowRes = await request.post("/api/v1/flows/", {
        headers: { Authorization: authToken },
        data: {
          name: flowName,
          folder_id: folderId,
          data: {
            nodes: [],
            edges: [],
            viewport: { x: 0, y: 0, zoom: 1 },
          },
          is_component: false,
        },
      });
      expect(flowRes.status()).toBe(201);
      const flow = await flowRes.json();
      flowId = flow.id;

      // Navigate to the home page and wait for it to load
      await awaitBootstrapTest(page, { skipModal: true });

      // The folder must appear in the left sidebar
      await expect(
        page.getByTestId(`sidebar-nav-${folderName}`),
      ).toBeVisible({ timeout: 15000 });

      // Click the folder in the sidebar
      await page.getByTestId(`sidebar-nav-${folderName}`).click();

      // The flow we created must appear in the main content area
      await expect(page.getByText(flowName)).toBeVisible({ timeout: 15000 });
    } finally {
      if (flowId) {
        await request
          .delete(`/api/v1/flows/${flowId}`, {
            headers: { Authorization: authToken },
          })
          .catch(() => {});
      }
      await request
        .delete(`/api/v1/folders/${folderId}`, {
          headers: { Authorization: authToken },
        })
        .catch(() => {});
    }
  },
);
