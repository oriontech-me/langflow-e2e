import { expect, test } from "../../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../../helpers/other/await-bootstrap-test";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import {
  createProjectThroughSidebar,
  renameProjectThroughSidebar,
} from "../../../../helpers/flows/create-project-through-sidebar";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import { deleteProject } from "../../../../helpers/flows/delete-project";
import {
  projectSidebarEntry,
  type ProjectRef,
} from "../../../../helpers/ui/project-sidebar";
import { MainPage } from "../../../../pages/MainPage";

/**
 * Folder (Project) CRUD lifecycle via the home sidebar.
 *
 * Exercises the MainPage folder helpers (addProject / renameProject /
 * deleteProject / clickProject) end to end:
 *   1. Create → rename → delete an empty folder entirely through the UI.
 *   2. Delete a folder that contains a flow and confirm the contained flow
 *      is removed with it (set up deterministically via the REST API).
 *
 * Empty-folder deletion integrity, create-after-delete-all and API-level
 * move/placement are covered by sibling specs (folder-deletion-integrity,
 * folder-drag-drop-flow) and are intentionally not repeated here.
 */

test(
  "creates, renames and deletes an empty project folder via the UI",
  { tag: ["@stable", "@release", "@workspace", "@mainpage"] },
  async ({ page, request }) => {
    await awaitBootstrapTest(page, { skipModal: true });

    const mainPage = new MainPage(page);
    const renamedFolder = `crud-folder-${Date.now()}`;
    let createdId: string | undefined;
    let project: ProjectRef | undefined;

    try {
      await test.step("Create a new folder from the sidebar", async () => {
        // `createProjectThroughSidebar` returns the id AND the name the backend
        // assigned — "New Project" only while that name is free, `New Project
        // (N)` otherwise. Asserting on the literal `sidebar-nav-New Project` was
        // a bet on the instance having no other folder by that name (#1023);
        // since #1363 the entry is addressed by that pair, because the nightly
        // keys the testid on the id and 1.11.x still keys it on the name.
        project = await createProjectThroughSidebar(page);
        createdId = project.id;
      });

      await test.step("Rename the folder to a unique name", async () => {
        project = await renameProjectThroughSidebar(
          page,
          project!,
          renamedFolder,
        );
        // Asserting on the unique renamed entry is enough to prove the rename
        // committed. We deliberately do NOT assert that "New Project" is gone:
        // several specs create folders via the UI in parallel against the same
        // backend, so a generic "New Project" entry from another worker may
        // legitimately exist at the same time.
        await expect(projectSidebarEntry(page, project)).toContainText(
          renamedFolder,
          { timeout: 15000 },
        );
      });

      await test.step("Delete the folder", async () => {
        await mainPage.deleteProject(project!);
        await expect(
          page.getByText("Project deleted successfully"),
        ).toBeVisible({ timeout: 15000 });
        await expect(projectSidebarEntry(page, project!)).not.toBeVisible({
          timeout: 10000,
        });
      });
    } finally {
      // The UI delete above is the assertion, NOT the cleanup (#1023): the
      // sidebar entry disappears optimistically while `DELETE
      // /api/v1/projects/{id}` can answer 500 under contention (#965/LE-2020),
      // leaving the folder on the instance for every later run to trip over.
      // `deleteProject` retries the 500 and treats 404 (the happy path) as done.
      if (createdId) {
        await deleteProject(request, createdId, {
          headers: { Authorization: await getAuthToken(request) },
        }).catch((error) => {
          console.warn(`⚠️ Orphan project left behind (${createdId}): ${error}`);
        });
      }
    }
  },
);

test(
  "deleting a folder that contains a flow removes the flow with it",
  { tag: ["@stable", "@release", "@workspace", "@mainpage"] },
  async ({ page, request }) => {
    const authToken = await getAuthToken(request);
    const folderName = `crud-del-folder-${Date.now()}`;
    const flowName = `crud-del-flow-${Date.now()}`;

    // Create the folder via API so the UI deletion target is deterministic.
    const folderRes = await request.post("/api/v1/projects/", {
      headers: { Authorization: authToken },
      data: { name: folderName, description: "Folder CRUD deletion test" },
    });
    expect(folderRes.status()).toBe(201);
    const { id: folderId } = await folderRes.json();

    let flowId: string | undefined;
    let folderDeleted = false;

    try {
      const flowRes = await request.post("/api/v1/flows/", {
        headers: { Authorization: authToken },
        data: {
          name: flowName,
          folder_id: folderId,
          data: { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
          is_component: false,
        },
      });
      expect(flowRes.status()).toBe(201);
      const flow = await flowRes.json();
      flowId = flow.id;
      expect(flow.folder_id).toBe(folderId);

      await awaitBootstrapTest(page, { skipModal: true });
      const mainPage = new MainPage(page);

      const project: ProjectRef = { id: folderId, name: folderName };

      await test.step("The folder and its flow are listed", async () => {
        await expect(projectSidebarEntry(page, project)).toBeVisible({
          timeout: 15000,
        });
        await mainPage.clickProject(project);
        await expect(page.getByText(flowName)).toBeVisible({ timeout: 15000 });
      });

      await test.step("Delete the folder", async () => {
        await mainPage.deleteProject(project);
        await expect(
          page.getByText("Project deleted successfully"),
        ).toBeVisible({ timeout: 15000 });
        await expect(projectSidebarEntry(page, project)).not.toBeVisible({
          timeout: 10000,
        });
        folderDeleted = true;
      });

      await test.step("The contained flow is deleted as well", async () => {
        const check = await request.get(`/api/v1/flows/${flowId}`, {
          headers: { Authorization: authToken },
        });
        expect(check.status()).toBe(404);
      });
    } finally {
      if (flowId) {
        await deleteFlow(request, flowId, {
          headers: { Authorization: authToken },
        }).catch(() => {});
      }
      if (!folderDeleted) {
        // deleteProject retries the 500 the endpoint returns under concurrent
        // writes (#965) — a bare request.delete resolved on that status and left
        // the folder behind for good.
        await deleteProject(request, folderId, {
          headers: { Authorization: authToken },
        }).catch((error) => {
          console.warn(`⚠️ Orphan project left behind (${folderId}): ${error}`);
        });
      }
    }
  },
);
