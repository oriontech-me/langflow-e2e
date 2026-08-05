import type { Page } from "@playwright/test";
import {
  expect,
  test,
  type PageWithErrorHooks,
} from "../../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../../helpers/other/await-bootstrap-test";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import {
  createProjectThroughSidebar,
  renameProjectThroughSidebar,
} from "../../../../helpers/flows/create-project-through-sidebar";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
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

// Ids of flows and projects a test created, deleted id-scoped in afterEach
// (#515 — never a global cleanAllFlows, which wipes what other workers are
// building). Tests 2 and 3 open a starter template to reach the folder view
// through the real navigation path, and opening it CREATES a flow; nothing used
// to delete it, so every run left one behind (47 flows on the local instance, 20
// of them stray "Basic Prompting" copies, before this was added).
const createdFlowIds = new Set<string>();
const createdProjectIds = new Set<string>();

/**
 * Records every flow the PAGE creates, so teardown deletes exactly those.
 *
 * A listener rather than a push at the one call site (#1023): besides the
 * starter template, `awaitBootstrapTest`'s modal path can itself land on a
 * freshly-created "New Flow" (see `openNewFlowTemplatesModal` — the 1.10.0
 * welcome-overlay branch), and nothing tracked that one. Six `--workers=2` runs
 * of this folder left two stray `New Flow` copies behind on the local instance.
 */
function trackCreatedFlows(page: Page): void {
  page.on("response", (response) => {
    if (response.request().method() !== "POST" || response.status() !== 201) {
      return;
    }
    if (new URL(response.url()).pathname.replace(/\/$/, "") !== "/api/v1/flows") {
      return;
    }
    response
      .json()
      .then((body: { id?: string }) => {
        if (body?.id) createdFlowIds.add(body.id);
      })
      .catch(() => {});
  });
}

test.afterEach(async ({ page, request }, testInfo) => {
  const flowIds = [...createdFlowIds];
  const projectIds = [...createdProjectIds];
  createdFlowIds.clear();
  createdProjectIds.clear();
  if (flowIds.length === 0 && projectIds.length === 0) return;

  // Playwright's own `screenshot: only-on-failure` fires while the page fixture
  // tears down, which is AFTER this hook — so the navigation below would hand
  // the report a blank canvas. Capture the failure state first: #1061 was
  // diagnosed entirely from that artifact showing the wrong flow open.
  if (testInfo.status !== testInfo.expectedStatus) {
    try {
      testInfo.annotations.push({
        type: "url-at-teardown",
        description: page.url(),
      });
      await testInfo.attach("page-at-teardown", {
        body: await page.screenshot({ fullPage: true }),
        contentType: "image/png",
      });
    } catch {
      // The page may already be gone — the cleanup below is what matters.
    }
  }

  // Take the page off the flow canvas BEFORE deleting anything (#1023).
  //
  // Deleting a flow underneath a mounted editor makes the editor keep asking
  // for a flow that no longer exists. Measured on `1.12.0.dev9` with a probe
  // that varies only the page's location at delete time:
  //   - page on the folder view  → 0 backend errors;
  //   - editor open and idle     → 404 on `/api/v1/flows/{id}/events?since=`;
  //   - editor still mounting    → 404 on `GET /api/v1/flows/{id}` **and** on
  //     `/events?since=` — the signature #1023 reports, and the state a test
  //     that dies inside `openTemplateAndReturnToFolders` leaves behind.
  //
  // Those 404s are an artifact of teardown ORDER, not a product defect, but the
  // fixture logs each one as `🚨 Backend Error` and the deterministic pipeline's
  // VALIDATE gate hard-stops on them. `about:blank` (rather than `/`) is used so
  // the teardown adds no backend traffic of its own.
  await page.goto("about:blank").catch(() => {});

  const authToken = await getAuthToken(request);
  const headers = { Authorization: authToken };
  for (const id of flowIds) {
    // Not swallowed silently: a failed cleanup is reported, never hidden — but it
    // must not fail the hook and mask the assertion that already ran.
    await deleteFlow(request, id, { headers }).catch((error) => {
      console.warn(`⚠️ Orphan flow left behind (${id}): ${error}`);
    });
  }
  // Folders created through the UI are deleted through the UI by the tests
  // themselves — but that delete is NOT reliable cleanup: `DELETE
  // /api/v1/projects/{id}` answers 500 under contention while the toast still
  // reads "Project deleted successfully", so the folder survives (#965/LE-2020).
  // Measured: six `--workers=2` runs from a clean instance left 11 orphan
  // folders, and tests 2 and 3 then failed every run from the second onwards.
  // `deleteProject` retries the 500 and treats 404 (already deleted by the UI,
  // the happy path) as done.
  for (const id of projectIds) {
    await deleteProject(request, id, { headers }).catch((error) => {
      console.warn(`⚠️ Orphan project left behind (${id}): ${error}`);
    });
  }
});

/**
 * Opens the starter-template gallery, creates a flow from "Basic Prompting" and
 * comes back to the folder view — the navigation round-trip tests 2 and 3 use to
 * reach the sidebar the way a user does. The created flow is picked up by
 * `trackCreatedFlows` and deleted id-scoped in afterEach.
 */
async function openTemplateAndReturnToFolders(page: Page) {
  const flowCreation = page.waitForResponse(
    (resp) =>
      resp.url().includes("/api/v1/flows") &&
      resp.request().method() === "POST" &&
      resp.status() === 201,
    { timeout: 30000 },
  );

  await page.getByTestId("side_nav_options_all-templates").click();
  await page.getByRole("heading", { name: "Basic Prompting" }).click();

  await flowCreation;

  await page.waitForSelector('[data-testid="sidebar-search-input"]', {
    timeout: 30000,
  });

  // Go back to folder view
  await page.getByTestId("icon-ChevronLeft").first().click();

  await page.waitForSelector('[data-testid="add-project-button"]', {
    timeout: 30000,
  });
}

test(
  "deleting a folder should update the folder list immediately",
  { tag: ["@stable", "@release", "@api"] },
  async ({ page, request }) => {
    // Registered even though this test opens no template: on an instance with no
    // flows left (the `@destructive` sibling empties it in its own lane)
    // `awaitBootstrapTest` seeds one through `addFlowToTestOnEmptyLangflow`, and
    // that flow was the last untracked leak in this file (#1023).
    trackCreatedFlows(page);
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

      // Verify the page is still functional by checking for the add project button
      await expect(page.getByTestId("add-project-button")).toBeVisible({
        timeout: 5000,
      });
    } finally {
      // Unconditional, not "only if the UI delete did not complete" (#1023):
      // the sidebar entry disappearing does NOT prove the folder is gone. The
      // UI removes it optimistically and `DELETE /api/v1/projects/{id}` answers
      // 500 under contention while the toast still reads "deleted successfully"
      // (#965/LE-2020) — one of those landed in a 7/7-green run here and left
      // the folder on the instance. `deleteProject` retries the 500 and treats
      // 404 (the happy path, where the UI really did delete it) as done.
      await deleteProject(request, folderId, {
        headers: { Authorization: authToken },
      }).catch((error) => {
        console.warn(`⚠️ Orphan project left behind (${folderId}): ${error}`);
      });
    }
  },
);

test(
  "deleting one folder should not affect other folders",
  { tag: ["@stable", "@release", "@api"] },
  async ({ page }) => {
    trackCreatedFlows(page);
    await awaitBootstrapTest(page);

    // Template round-trip to reach the folder view the way a user does; the
    // created flow is tracked and deleted in afterEach.
    await openTemplateAndReturnToFolders(page);

    // Per-run names (#1023): the fixed `folder-alpha` / `folder-beta` could be
    // satisfied by a leftover from an earlier failed run, or collide with a
    // sibling worker's folder under `fullyParallel`.
    const stamp = Date.now();
    const alpha = `folder-alpha-${stamp}`;
    const beta = `folder-beta-${stamp}`;

    // Create both folders. `createProjectThroughSidebar` returns the name the
    // backend actually assigned, so the rename addresses THIS folder instead of
    // guessing with `getByText("New Project").last()` — see the helper's note.
    const alphaProject = await createProjectThroughSidebar(page);
    createdProjectIds.add(alphaProject.id);
    await renameProjectThroughSidebar(page, alphaProject.name, alpha);

    const betaProject = await createProjectThroughSidebar(page);
    createdProjectIds.add(betaProject.id);
    await renameProjectThroughSidebar(page, betaProject.name, beta);

    // Verify both folders exist
    await expect(page.getByTestId(`sidebar-nav-${alpha}`)).toBeVisible({
      timeout: 5000,
    });
    await expect(page.getByTestId(`sidebar-nav-${beta}`)).toBeVisible({
      timeout: 5000,
    });

    // Delete the first folder
    const folderAlpha = page.getByTestId(`sidebar-nav-${alpha}`);
    await folderAlpha.hover();
    await page.getByTestId(`more-options-button_${alpha}`).click();
    await page.getByTestId("btn-delete-project").click();
    await page.getByText("Delete").last().click();

    // Verify success message
    await expect(page.getByText("Project deleted successfully")).toBeVisible({
      timeout: 15000,
    });

    // Verify the deleted folder is removed
    await expect(page.getByTestId(`sidebar-nav-${alpha}`)).not.toBeVisible({
      timeout: 5000,
    });

    // Verify the sibling folder still exists and is accessible
    const folderBeta = page.getByTestId(`sidebar-nav-${beta}`);
    await expect(folderBeta).toBeVisible({ timeout: 5000 });

    // Click it to ensure the app is functional
    await folderBeta.click();

    // The page should still be functional
    await page.waitForSelector('[data-testid="mainpage_title"]', {
      timeout: 10000,
    });

    // Clean up - delete the remaining folder through the same UI path. afterEach
    // still deletes both ids via the API: this UI delete can 500 silently
    // (#965), and the toast alone does not prove the folder is gone.
    await folderBeta.hover();
    await page.getByTestId(`more-options-button_${beta}`).click();
    await page.getByTestId("btn-delete-project").click();
    await page.getByText("Delete").last().click();

    await expect(page.getByText("Project deleted successfully")).toBeVisible({
      timeout: 15000,
    });
  },
);

test(
  "creating a new folder after deletion should work correctly",
  { tag: ["@stable", "@release", "@api"] },
  async ({ page }) => {
    trackCreatedFlows(page);
    await awaitBootstrapTest(page);

    // Template round-trip to reach the folder view the way a user does; the
    // created flow is tracked and deleted in afterEach.
    await openTemplateAndReturnToFolders(page);

    // Per-run names (#1023) — see the sibling test for why the fixed
    // `folder-one` / `folder-two` were replaced.
    const stamp = Date.now();
    const one = `folder-one-${stamp}`;
    const two = `folder-two-${stamp}`;

    // Create the first folder
    const oneProject = await createProjectThroughSidebar(page);
    createdProjectIds.add(oneProject.id);
    await renameProjectThroughSidebar(page, oneProject.name, one);

    // Delete it
    const folderOne = page.getByTestId(`sidebar-nav-${one}`);
    await folderOne.hover();
    await page.getByTestId(`more-options-button_${one}`).click();
    await page.getByTestId("btn-delete-project").click();
    await page.getByText("Delete").last().click();

    await expect(page.getByText("Project deleted successfully")).toBeVisible({
      timeout: 15000,
    });

    // Verify folder is deleted
    await expect(page.getByTestId(`sidebar-nav-${one}`)).not.toBeVisible({
      timeout: 5000,
    });

    // Create a new folder immediately after the deletion — the assertion under
    // test: no stale-cache collision between a deletion and the next creation.
    const twoProject = await createProjectThroughSidebar(page);
    createdProjectIds.add(twoProject.id);
    await renameProjectThroughSidebar(page, twoProject.name, two);

    const folderTwo = page.getByTestId(`sidebar-nav-${two}`);
    await expect(folderTwo).toBeVisible({ timeout: 5000 });

    // Clean up through the UI; afterEach still deletes both ids via the API
    // because this delete can 500 silently (#965).
    await folderTwo.hover();
    await page.getByTestId(`more-options-button_${two}`).click();
    await page.getByTestId("btn-delete-project").click();
    await page.getByText("Delete").last().click();

    await expect(page.getByText("Project deleted successfully")).toBeVisible({
      timeout: 15000,
    });
  },
);

// Destructive — this test deletes EVERY folder of the shared superuser, so the
// `@destructive` tag keeps it out of every normal run and confines it to the
// low-concurrency lane (`PW_DESTRUCTIVE=1`, workers pinned to 1 in
// playwright.config.ts). It used to run under fullyParallel beside its own
// file-siblings and beside folder-crud / bulk-actions /
// flow-navigation-between-folders: it emptied the account mid-flight and their
// awaitBootstrapTest then took the empty-instance branch and timed out waiting
// for a welcome overlay (#1010 — 1 of 3 measured runs failed that way, with 404s
// on project ids the siblings still owned).
//
// The assertions below are unchanged: the deletion is real and the empty-project
// screen is the real one. Per-test user isolation was measured and is NOT
// possible while LANGFLOW_AUTO_LOGIN=true — the app re-mints a superuser token on
// mount. See docs/core-functionality/project-management/folder-deletion-integrity.md
// (§"The destructive lane") for the rejected alternatives and the daily's known gap.
test(
  "deleting every folder lands on the empty project screen",
  { tag: ["@release", "@api", "@destructive"] },
  async ({ page, request }) => {
    trackCreatedFlows(page);

    // The zero-project state this test exists to reach makes the frontend fire
    // the paginated flows query with a literal `undefined` project id, and the
    // backend correctly rejects it with a `422 uuid_parsing`. Upstream frontend
    // defect, confirmed on the release-1.12.0 line the nightly is built from
    // (#1008) — the chain is:
    //
    //   `useGetFolders` sets `myCollectionId = data.find(default)?.id ?? data[0]?.id`,
    //   which is `undefined` once no project is left; `HomePage` then passes
    //   `id: folderId ?? myCollectionId!` — the `!` silences the type error, not
    //   the value — and `use-get-folder.ts` nests its existence guard inside
    //   `if (params.id)`, so it is skipped for exactly the `undefined` case it
    //   should block, and `` `${PROJECTS}/${params.id}` `` interpolates the string.
    //
    // Declared rather than silenced with `allowHttpErrors()`: this test deletes N
    // projects through the UI, and `DELETE /api/v1/projects/{id}` answering 500
    // while the toast reads "deleted successfully" is a separate filed defect
    // (#965/LE-2020) that this loop is unusually well placed to catch. The
    // declaration is verified — if the 422 stops firing, the fixture fails this
    // test and tells us to close #1008.
    (page as PageWithErrorHooks).expectKnownHttpError({
      pathname: "/api/v1/projects/undefined",
      status: 422,
      reason:
        "#1008 — after the last project is deleted the frontend queries GET /api/v1/projects/undefined; upstream frontend defect, the backend's 422 is correct",
    });

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
