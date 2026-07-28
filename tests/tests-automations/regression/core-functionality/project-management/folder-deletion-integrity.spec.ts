import { expect, test } from "../../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../../helpers/other/await-bootstrap-test";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { deleteProject } from "../../../../helpers/flows/delete-project";
import { MainPage } from "../../../../pages/MainPage";

/**
 * Tests for folder deletion integrity
 *
 * These tests verify that:
 * 1. After deleting a folder, the UI properly updates (no stale data)
 * 2. Deleting a folder when another exists keeps the app functional
 * 3. Creating folders after deletion works correctly
 * 4. Deleting every folder lands on the empty-state screen
 *
 * The create/rename/delete-empty CRUD lifecycle itself is owned by the
 * canonical (validated, @stable) folder-crud.spec.ts — these tests focus on
 * the integrity properties around deletion and set their fixtures up via the
 * REST API so they don't repeat the UI create/rename steps.
 */

test(
  "deleting a folder should update the folder list immediately",
  { tag: ["@release", "@api"] },
  async ({ page, request }) => {
    const authToken = await getAuthToken(request);
    const folderName = `del-integrity-${Date.now()}`;

    // Set up the folder via API so the deletion target is deterministic and we
    // don't re-test the UI create/rename flow (owned by folder-crud.spec.ts).
    const folderRes = await request.post("/api/v1/projects/", {
      headers: { Authorization: authToken },
      data: { name: folderName, description: "Deletion integrity test" },
    });
    expect(folderRes.status()).toBe(201);
    const { id: folderId } = await folderRes.json();

    let folderDeleted = false;
    try {
      await awaitBootstrapTest(page, { skipModal: true });
      const mainPage = new MainPage(page);

      const folderBeforeDelete = page.getByTestId(`sidebar-nav-${folderName}`);
      await expect(folderBeforeDelete).toBeVisible({ timeout: 15000 });

      await mainPage.deleteProject(folderName);

      // Verify success message
      await expect(page.getByText("Project deleted successfully")).toBeVisible({
        timeout: 15000,
      });

      // Verify the folder is removed from the sidebar immediately (no stale data)
      await expect(
        page.getByTestId(`sidebar-nav-${folderName}`),
      ).not.toBeVisible({ timeout: 10000 });
      folderDeleted = true;

      // Verify the page is still functional by checking for the add project button
      await expect(page.getByTestId("add-project-button")).toBeVisible({
        timeout: 5000,
      });
    } finally {
      if (!folderDeleted) {
        // deleteProject retries the 500 the endpoint returns under concurrent
        // writes (#965), which the bare request.delete accepted as done.
        await deleteProject(request, folderId, {
          headers: { Authorization: authToken },
        }).catch((error) => {
          console.warn(`⚠️ Orphan project left behind (${folderId}): ${error}`);
        });
      }
    }
  },
);

test(
  "deleting one folder should not affect other folders",
  { tag: ["@release", "@api"] },
  async ({ page }) => {
    await awaitBootstrapTest(page);

    // Navigate to templates
    await page.getByTestId("side_nav_options_all-templates").click();
    await page.getByRole("heading", { name: "Basic Prompting" }).click();

    await page.waitForSelector('[data-testid="sidebar-search-input"]', {
      timeout: 30000,
    });

    // Go back to folder view
    await page.getByTestId("icon-ChevronLeft").first().click();

    await page.waitForSelector('[data-testid="add-project-button"]', {
      timeout: 30000,
    });

    // Create first folder
    await page.getByTestId("add-project-button").click();

    await page
      .locator("[data-testid='project-sidebar']")
      .getByText("New Project")
      .last()
      .waitFor({ state: "visible", timeout: 10000 });

    await page
      .locator("[data-testid='project-sidebar']")
      .getByText("New Project")
      .last()
      .dblclick();

    await page.getByTestId("input-project").fill("folder-alpha");
    await page.keyboard.press("Enter");

    await page.getByText("folder-alpha").last().waitFor({
      state: "visible",
      timeout: 10000,
    });

    // Create second folder
    await page.getByTestId("add-project-button").click();

    await page
      .locator("[data-testid='project-sidebar']")
      .getByText("New Project")
      .last()
      .waitFor({ state: "visible", timeout: 10000 });

    await page
      .locator("[data-testid='project-sidebar']")
      .getByText("New Project")
      .last()
      .dblclick();

    await page.getByTestId("input-project").fill("folder-beta");
    await page.keyboard.press("Enter");

    await page.getByText("folder-beta").last().waitFor({
      state: "visible",
      timeout: 10000,
    });

    // Verify both folders exist
    await expect(page.getByTestId("sidebar-nav-folder-alpha")).toBeVisible({
      timeout: 5000,
    });
    await expect(page.getByTestId("sidebar-nav-folder-beta")).toBeVisible({
      timeout: 5000,
    });

    // Delete the first folder
    const folderAlpha = page.getByTestId("sidebar-nav-folder-alpha");
    await folderAlpha.hover();
    await page.getByTestId("more-options-button_folder-alpha").click();
    await page.getByTestId("btn-delete-project").click();
    await page.getByText("Delete").last().click();

    // Verify success message
    await expect(page.getByText("Project deleted successfully")).toBeVisible({
      timeout: 15000,
    });

    // Verify folder-alpha is removed
    await expect(page.getByTestId("sidebar-nav-folder-alpha")).not.toBeVisible({
      timeout: 5000,
    });

    // Verify folder-beta still exists and is accessible
    const folderBeta = page.getByTestId("sidebar-nav-folder-beta");
    await expect(folderBeta).toBeVisible({ timeout: 5000 });

    // Click on folder-beta to ensure the app is functional
    await folderBeta.click();

    // The page should still be functional
    await page.waitForSelector('[data-testid="mainpage_title"]', {
      timeout: 10000,
    });

    // Clean up - delete the remaining folder
    await folderBeta.hover();
    await page.getByTestId("more-options-button_folder-beta").click();
    await page.getByTestId("btn-delete-project").click();
    await page.getByText("Delete").last().click();

    await expect(page.getByText("Project deleted successfully")).toBeVisible({
      timeout: 15000,
    });
  },
);

test(
  "creating a new folder after deletion should work correctly",
  { tag: ["@release", "@api"] },
  async ({ page }) => {
    await awaitBootstrapTest(page);

    // Navigate to templates
    await page.getByTestId("side_nav_options_all-templates").click();
    await page.getByRole("heading", { name: "Basic Prompting" }).click();

    await page.waitForSelector('[data-testid="sidebar-search-input"]', {
      timeout: 30000,
    });

    // Go back to folder view
    await page.getByTestId("icon-ChevronLeft").first().click();

    await page.waitForSelector('[data-testid="add-project-button"]', {
      timeout: 30000,
    });

    // Create first folder
    await page.getByTestId("add-project-button").click();

    await page
      .locator("[data-testid='project-sidebar']")
      .getByText("New Project")
      .last()
      .waitFor({ state: "visible", timeout: 10000 });

    await page
      .locator("[data-testid='project-sidebar']")
      .getByText("New Project")
      .last()
      .dblclick();

    await page.getByTestId("input-project").fill("folder-one");
    await page.keyboard.press("Enter");

    await page.getByText("folder-one").last().waitFor({
      state: "visible",
      timeout: 10000,
    });

    // Delete the folder
    const folderOne = page.getByTestId("sidebar-nav-folder-one");
    await folderOne.hover();
    await page.getByTestId("more-options-button_folder-one").click();
    await page.getByTestId("btn-delete-project").click();
    await page.getByText("Delete").last().click();

    await expect(page.getByText("Project deleted successfully")).toBeVisible({
      timeout: 15000,
    });

    // Verify folder is deleted
    await expect(page.getByTestId("sidebar-nav-folder-one")).not.toBeVisible({
      timeout: 5000,
    });

    // Create a new folder immediately after deletion
    await page.getByTestId("add-project-button").click();

    await page
      .locator("[data-testid='project-sidebar']")
      .getByText("New Project")
      .last()
      .waitFor({ state: "visible", timeout: 10000 });

    await page
      .locator("[data-testid='project-sidebar']")
      .getByText("New Project")
      .last()
      .dblclick();

    await page.getByTestId("input-project").fill("folder-two");
    await page.keyboard.press("Enter");

    // The new folder should be created successfully without any stale data issues
    await page.getByText("folder-two").last().waitFor({
      state: "visible",
      timeout: 10000,
    });

    const folderTwo = page.getByTestId("sidebar-nav-folder-two");
    await expect(folderTwo).toBeVisible({ timeout: 5000 });

    // Clean up
    await folderTwo.hover();
    await page.getByTestId("more-options-button_folder-two").click();
    await page.getByTestId("btn-delete-project").click();
    await page.getByText("Delete").last().click();

    await expect(page.getByText("Project deleted successfully")).toBeVisible({
      timeout: 15000,
    });
  },
);

// NOTE: destructive — this test deletes EVERY folder of the shared superuser.
// Under fullyParallel it can race with sibling folder tests (delete their
// folders / be prevented from reaching zero). Proper isolation (a per-test user)
// is tracked separately; CI retries currently absorb the rare collision.
test(
  "deleting every folder lands on the empty project screen",
  { tag: ["@release", "@api"] },
  async ({ page, request }) => {
    // Guarantee there is at least one folder holding a flow, so the
    // "delete everything" path is exercised against real content.
    const authToken = await getAuthToken(request);
    const folderRes = await request.post("/api/v1/projects/", {
      headers: { Authorization: authToken },
      data: { name: `del-all-folder-${Date.now()}`, description: "Delete-all" },
    });
    expect(folderRes.status()).toBe(201);
    const { id: folderId } = await folderRes.json();

    const flowRes = await request.post("/api/v1/flows/", {
      headers: { Authorization: authToken },
      data: {
        name: `del-all-flow-${Date.now()}`,
        folder_id: folderId,
        data: { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
        is_component: false,
      },
    });
    expect(flowRes.status()).toBe(201);

    await awaitBootstrapTest(page, { skipModal: true });

    // Get all folders in the sidebar and delete them one by one
    const projectSidebar = page.locator("[data-testid='project-sidebar']");

    // Delete all folders until none are left
    let folderCount = await projectSidebar
      .locator('[data-testid^="sidebar-nav-"]')
      .filter({ hasNotText: "add_note" })
      .count();

    while (folderCount > 0) {
      // Get the first folder
      const firstFolder = projectSidebar
        .locator('[data-testid^="sidebar-nav-"]')
        .filter({ hasNotText: "add_note" })
        .first();
      const folderTestId = await firstFolder.getAttribute("data-testid");

      if (!folderTestId) {
        break;
      }

      // Extract folder name from testid (e.g., "sidebar-nav-Starter Project" -> "starter-project")
      const folderName = folderTestId.replace("sidebar-nav-", "");
      const kebabName = folderName.toLowerCase().replace(/\s+/g, "-");

      // Hover and click more options
      await firstFolder.hover();

      // Try to find and click the more options button
      const moreOptionsButton = page.getByTestId(
        `more-options-button_${kebabName}`,
      );

      if (await moreOptionsButton.isVisible()) {
        await moreOptionsButton.click();
      } else {
        // Try with the original name format
        const altMoreOptions = page
          .locator(`[data-testid^="more-options-button_"]`)
          .first();
        await altMoreOptions.click();
      }

      await page.getByTestId("btn-delete-project").click();
      await page.getByText("Delete").last().click();

      // Wait for deletion to complete
      await expect(page.getByText("Project deleted successfully")).toBeVisible({
        timeout: 15000,
      });

      // Wait a bit for UI to update
      await page.waitForTimeout(500);

      // Recount folders
      folderCount = await projectSidebar
        .locator('[data-testid^="sidebar-nav-"]')
        .filter({ hasNotText: "add_note" })
        .count();
    }

    // Deleting every folder (including the initial folder, which is now
    // deletable) lands on the empty project screen: no folder entries remain,
    // the sidebar shows its empty message and the empty-page CTA is shown.
    expect(folderCount).toBe(0);
    await expect(
      projectSidebar.getByText("Start creating a project or flow"),
    ).toBeVisible({ timeout: 15000 });
    await expect(
      page.getByTestId("new_project_btn_empty_page"),
    ).toBeVisible({ timeout: 15000 });
  },
);
