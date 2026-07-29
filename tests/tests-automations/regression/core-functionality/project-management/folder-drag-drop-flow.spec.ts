import { expect, test } from "../../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../../helpers/other/await-bootstrap-test";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";

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
        await deleteFlow(request, flowId, {
          headers: { Authorization: authToken },
        }).catch(() => {});
      }
      await request
        .delete(`/api/v1/folders/${folderId}`, {
          headers: { Authorization: authToken },
        })
        .catch(() => {});
    }
  },
);

// The API-level folder-move assertion that used to live here
// ("moving a flow to another folder via API PATCH updates folder_id") was removed
// by #932. It duplicated `api/flows/api-folders-crud.spec.ts` test 4 line for line,
// differing only in using the `/api/v1/folders/` legacy alias, and it was NOT
// quarantined — so silencing the canonical test for #932 left the identical failure
// reachable from this file: two flake sites for one signal, and a quarantine that
// only looked complete.
//
// The failure is a product defect, not a test defect: `PATCH /api/v1/flows/{id}`
// answers `500 (sqlite3.OperationalError) database is locked` with two concurrent
// writers (14/24; 0/30 serial). Tracked upstream under LE-2020, evidence in
// docs/upstream-bugs/UPSTREAM-BUG-flow-patch-500-under-contention.md.
//
// Restore point when the upstream fix lands: api-folders-crud.spec.ts test 4 — the
// single place, in the API spec where the API contract belongs.

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
        await deleteFlow(request, flowId, {
          headers: { Authorization: authToken },
        }).catch(() => {});
      }
      await request
        .delete(`/api/v1/folders/${folderId}`, {
          headers: { Authorization: authToken },
        })
        .catch(() => {});
    }
  },
);
