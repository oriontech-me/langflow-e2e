import type { Page } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../../helpers/other/await-bootstrap-test";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { cleanOldFolders } from "../../../../helpers/filesystem/clean-old-folders";
import { createProjectThroughSidebar } from "../../../../helpers/flows/create-project-through-sidebar";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import { deleteProject } from "../../../../helpers/flows/delete-project";
import { navigateSettingsPages } from "../../../../helpers/ui/go-to-settings";
import { openProjectOptions } from "../../../../helpers/ui/project-sidebar";

/** The name test 1 renames its first project to. */
const RENAMED_PROJECT = "renamed_project";

/**
 * Address an MCP server row on the Settings → MCP Servers page **by name**.
 *
 * Row order is not part of the §14.1 contract and must not be asserted (#1123):
 * with `agentic_experience` enabled by default upstream, Langflow injects an
 * internal `langflow-agentic` server that is created before the starter
 * project's, and the page renders `GET /api/v2/mcp/servers` (ordered by
 * `created_at`) with no sort — so index 0 is not the starter project.
 *
 * Filtering the `mcp_server_name_<index>` rows keeps the assertion scoped to the
 * server list, so matching text elsewhere on the page cannot satisfy it.
 */
const mcpServerRow = (page: Page, name: string) =>
  page
    .getByTestId(/^mcp_server_name_\d+$/)
    .filter({ hasText: new RegExp(`^${name}$`) });

/**
 * Delete any leftover `renamed_project` before the test renames a project to it.
 *
 * `cleanOldFolders` only removes folders named "New Project*", so an attempt
 * that dies between the rename (step 4) and the delete (step 5) leaves
 * `renamed_project` on the shared superuser account. The next attempt then hits
 * `UNIQUE constraint failed: folder.user_id, folder.name` on its own rename —
 * a 500 that makes the retry fail for a reason the first attempt did not have,
 * so the retries stop being independent evidence. Observed on PR #1135's CI run
 * (3/3 attempts red, two of them on the leftover rather than the original
 * defect).
 *
 * API rather than the sidebar: this is teardown of the *previous* run, so it
 * must not depend on the UI state the test is about to assert on. `deleteProject`
 * treats 404 as the desired end state and retries the #965 contention 500.
 */
const removeLeftoverRenamedProject = async (page: Page) => {
  const response = await page.request.get("/api/v1/projects/");
  if (!response.ok()) return;

  // The /api/v1/projects/ response shape varies (sometimes a bare array,
  // sometimes `{ folders: [...] }`); mcp-server.spec.ts normalizes the same way.
  const raw = await response.json();
  const projects: Array<{ id: string; name: string }> = Array.isArray(raw)
    ? raw
    : (raw.folders ?? []);

  for (const project of projects.filter((p) => p.name === RENAMED_PROJECT)) {
    await deleteProject(page.request, project.id);
  }
};

// Ids of what a test created, deleted id-scoped in afterEach (#1376) — never a
// global sweep, which wipes what other workers are building (#515).
//
// Measured on `1.12.0.dev20` over three consecutive runs of this file, counting
// `GET /api/v1/flows/?get_all=true` and `GET /api/v1/projects/` around each:
//
//   flows     34 -> 35 -> 36 -> 37     (+1 every run, unbounded)
//   projects   1 ->  2 ->  2 ->  2     (+1, then flat)
//
// The two halves fail differently, and the second is the one worth naming. Test
// 2 opens the Basic Prompting template, which creates a flow nothing deletes —
// that leak is monotonic and visible. Test 1 creates TWO projects and only ever
// deletes the one it renames, and that leak reads as zero from run 2 onwards
// only because `cleanOldFolders` at the top of test 1 sweeps the PREVIOUS run's
// leftover. It is not absent, it is absorbed — and #1363 is the incident where
// that absorption stopped working: with the sweep silently deleting nothing,
// `New Project (N)` accumulated inside a single test's own retries.
//
// So the cleanup below is not redundant with `cleanOldFolders`. That helper
// guards against OTHER runs' leftovers; this one stops the file from producing
// them.
const createdFlowIds = new Set<string>();
const createdProjectIds = new Set<string>();

/**
 * Records every flow the PAGE creates, so teardown deletes exactly those.
 *
 * A response listener rather than a push at one call site: the flow this file
 * leaks is not created by an explicit step but as a side effect of opening a
 * starter template, and `awaitBootstrapTest`'s empty-instance branch can seed
 * one too (#1023).
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

test.afterEach(async ({ page, request }) => {
  const flowIds = [...createdFlowIds];
  const projectIds = [...createdProjectIds];
  createdFlowIds.clear();
  createdProjectIds.clear();
  if (flowIds.length === 0 && projectIds.length === 0) return;

  // Off the canvas BEFORE deleting anything (#1023): test 2 ends inside the flow
  // editor, and deleting a flow underneath a mounted editor makes it keep asking
  // for a flow that no longer exists — 404s the fixture logs as
  // `🚨 Backend Error`, an artifact of teardown order rather than a defect.
  // `about:blank` rather than `/` so teardown adds no backend traffic of its own.
  await page.goto("about:blank").catch(() => {});

  const headers = { Authorization: await getAuthToken(request) };
  for (const id of flowIds) {
    // Reported, never swallowed: a failed cleanup must not fail the hook and
    // mask the assertion that already ran, but it must not be silent either.
    await deleteFlow(request, id, { headers }).catch((error) => {
      console.warn(`⚠️ Orphan flow left behind (${id}): ${error}`);
    });
  }
  // `deleteProject` treats 404 — the project test 1 already deleted through the
  // UI — as the desired end state, and retries the 500 the endpoint answers
  // under contention (#965).
  for (const id of projectIds) {
    await deleteProject(request, id, { headers }).catch((error) => {
      console.warn(`⚠️ Orphan project left behind (${id}): ${error}`);
    });
  }
});

test(
  "user must be able to see starter projects for mcp servers",
  { tag: ["@stable", "@release", "@workspace", "@components", "@mcp"] },
  async ({ page }) => {
    //starter mcp project

    trackCreatedFlows(page);
    await awaitBootstrapTest(page, {
      skipModal: true,
    });

    await cleanOldFolders(page);
    await removeLeftoverRenamedProject(page);

    await navigateSettingsPages(page, "Settings", "MCP Servers");

    await expect(mcpServerRow(page, "lf-starter_project")).toHaveCount(1);

    await page.getByTestId("icon-ChevronLeft").first().click();

    //add new folders

    // Created through the helper rather than two bare `add-project-button`
    // clicks, so the test holds the id AND the backend-assigned name of each
    // project. Both are needed to address the sidebar entry and its kebab: the
    // nightly keys those testids on the project id, 1.11.x on its name (#1363).
    const firstProject = await createProjectThroughSidebar(page);
    const secondProject = await createProjectThroughSidebar(page);
    // Both, not just the renamed one: the second is the project this file used
    // to leave behind on every run (#1376).
    createdProjectIds.add(firstProject.id);
    createdProjectIds.add(secondProject.id);

    await navigateSettingsPages(page, "Settings", "MCP Servers");

    await expect(mcpServerRow(page, "lf-starter_project")).toHaveCount(1);

    // toHaveCount, not `expect(await ....count())`: the MCP-server row is
    // written by the backend as a side effect of the project write, so it can
    // lag the navigation. A bare .count() reads the DOM once and fails on that
    // lag; toHaveCount polls until the expectation timeout (#1135).
    await expect(page.getByText("lf-new_project", { exact: true })).toHaveCount(
      1,
    );
    await expect(
      page.getByText("lf-new_project_1", { exact: true }),
    ).toHaveCount(1);

    await page.getByTestId("icon-ChevronLeft").first().click();

    //rename a folder

    // Renamed through the kebab's own "Rename" entry (the double-click path is
    // covered by folder-crud.spec.ts), addressing the project this test created
    // instead of "whichever entry reads 'New Project' first" — a sibling worker
    // creating its own project mid-run could otherwise be the one renamed.
    await openProjectOptions(page, firstProject);
    await page.getByText("Rename", { exact: true }).last().click();
    await page.getByTestId("input-project").last().fill(RENAMED_PROJECT);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1000);

    const renamedProject = { id: firstProject.id, name: RENAMED_PROJECT };

    await navigateSettingsPages(page, "Settings", "MCP Servers");

    await expect(mcpServerRow(page, "lf-starter_project")).toHaveCount(1);

    await expect(
      page.getByText("lf-renamed_project", { exact: true }),
    ).toHaveCount(1);

    //delete a folder

    await page.getByTestId("icon-ChevronLeft").first().click();
    await openProjectOptions(page, renamedProject);
    await page.getByText("Delete", { exact: true }).last().click();
    await page.getByText("Delete", { exact: true }).last().click();
    await page.waitForTimeout(1000);

    await navigateSettingsPages(page, "Settings", "MCP Servers");

    await expect(mcpServerRow(page, "lf-starter_project")).toHaveCount(1);
    await expect(
      page.getByText("lf-renamed_project", { exact: true }),
    ).toHaveCount(0);
  },
);

test(
  "user must not be able to add duplicate mcp servers from starter projects",
  { tag: ["@stable", "@release", "@workspace", "@components", "@mcp"] },
  async ({ page }) => {
    trackCreatedFlows(page);
    await awaitBootstrapTest(page);

    await page.getByTestId("side_nav_options_all-templates").click();
    await page.getByRole("heading", { name: "Basic Prompting" }).click();

    await page.waitForSelector('[data-testid="sidebar-search-input"]', {
      timeout: 100000,
    });

    await page.getByTestId("icon-ChevronLeft").first().click();

    await page.getByTestId("mcp-btn").click();
    await page.getByText("JSON").last().click();
    await page.getByTestId("icon-copy").click();

    await navigateSettingsPages(page, "Settings", "MCP Servers");

    await page.getByTestId("add-mcp-server-button-page").click();
    await page.getByTestId("json-input").click();
    await page.keyboard.press(`ControlOrMeta+V`);
    await page.getByTestId("add-mcp-server-button").click();

    // Wait for error message to appear
    await expect(page.getByText("Server already exists.")).toBeVisible({
      timeout: 10000,
    });

    const numberOfErrors = await page
      .getByText("Server already exists.")
      .count();
    expect(numberOfErrors).toBe(1);
  },
);
