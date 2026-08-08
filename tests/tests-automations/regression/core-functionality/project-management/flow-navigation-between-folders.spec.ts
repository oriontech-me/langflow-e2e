import { expect, test } from "../../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../../helpers/other/await-bootstrap-test";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import { deleteProject } from "../../../../helpers/flows/delete-project";
import {
  projectSidebarEntry,
  type ProjectRef,
} from "../../../../helpers/ui/project-sidebar";
import { MainPage } from "../../../../pages/MainPage";

/**
 * Folder-to-folder navigation on the home page (QA-CHECKLIST §10.2 "Navigate
 * between folders"): selecting a folder in the project sidebar scopes the flow
 * listing to THAT folder's flows, and switching folders swaps the listing.
 *
 * Distinct from the sibling specs, which are intentionally not repeated:
 *   - folder CRUD → folder-crud.spec.ts
 *   - flow search-by-name / API-created flows appearing → flow-navigation-folders.spec.ts
 *   - moving a flow between folders → folder-drag-drop-flow.spec.ts
 *
 * Setup is API-first for determinism: two folders (projects) and one uniquely
 * named flow inside each (via folder_id). The key assertion is MUTUAL EXCLUSION
 * — folder A shows flow A and not flow B, folder B shows flow B and not flow A —
 * which proves the sidebar navigation re-scopes the listing instead of showing a
 * global list. Cleanup is id-scoped (never a global sweep), required under
 * fullyParallel.
 */

test(
  "navigating between two folders scopes the listing to each folder's flows",
  { tag: ["@release", "@workspace", "@mainpage", "@regression"] },
  async ({ page, request }) => {
    const authToken = await getAuthToken(request);
    const headers = { Authorization: authToken };
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const folderAName = `nav-folderA-${stamp}`;
    const folderBName = `nav-folderB-${stamp}`;
    const flowAName = `nav-flowA-${stamp}`;
    const flowBName = `nav-flowB-${stamp}`;

    let folderAId: string | undefined;
    let folderBId: string | undefined;
    let flowAId: string | undefined;
    let flowBId: string | undefined;

    const createFolder = async (name: string): Promise<string> => {
      const res = await request.post("/api/v1/projects/", {
        headers,
        data: { name, description: "Folder navigation test" },
      });
      expect(res.status()).toBe(201);
      return (await res.json()).id as string;
    };

    const createFlowInFolder = async (
      name: string,
      folderId: string,
    ): Promise<string> => {
      const res = await request.post("/api/v1/flows/", {
        headers,
        data: {
          name,
          folder_id: folderId,
          data: { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
          is_component: false,
        },
      });
      expect(res.status()).toBe(201);
      const flow = await res.json();
      expect(flow.folder_id).toBe(folderId);
      return flow.id as string;
    };

    try {
      await test.step("Create two folders, each with one distinct flow (API)", async () => {
        folderAId = await createFolder(folderAName);
        folderBId = await createFolder(folderBName);
        flowAId = await createFlowInFolder(flowAName, folderAId);
        flowBId = await createFlowInFolder(flowBName, folderBId);
      });

      const mainPage = new MainPage(page);

      // Addressed by the id/name pair the create response returns: the nightly
      // keys the sidebar testid on the id, 1.11.x on the name (#1363).
      const projectA: ProjectRef = { id: folderAId!, name: folderAName };
      const projectB: ProjectRef = { id: folderBId!, name: folderBName };

      await test.step("Both folders are listed in the project sidebar", async () => {
        await awaitBootstrapTest(page, { skipModal: true });
        await expect(projectSidebarEntry(page, projectA)).toBeVisible({
          timeout: 15000,
        });
        await expect(projectSidebarEntry(page, projectB)).toBeVisible({
          timeout: 15000,
        });
      });

      await test.step("Folder A shows flow A and not flow B", async () => {
        await mainPage.clickProject(projectA);
        await expect(page.getByText(flowAName)).toBeVisible({ timeout: 15000 });
        await expect(page.getByText(flowBName)).toHaveCount(0);
      });

      await test.step("Folder B shows flow B and not flow A", async () => {
        await mainPage.clickProject(projectB);
        await expect(page.getByText(flowBName)).toBeVisible({ timeout: 15000 });
        await expect(page.getByText(flowAName)).toHaveCount(0);
      });
    } finally {
      if (flowAId) await deleteFlow(request, flowAId, { headers });
      if (flowBId) await deleteFlow(request, flowBId, { headers });
      // deleteProject retries the 500 the endpoint returns under concurrent
      // writes (#965) — the bare request.delete here resolved on that status and
      // left both folders on the instance permanently.
      for (const folderId of [folderAId, folderBId]) {
        if (!folderId) continue;
        await deleteProject(request, folderId, { headers }).catch((error) => {
          console.warn(`⚠️ Orphan project left behind (${folderId}): ${error}`);
        });
      }
    }
  },
);
