import type { Page } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../../helpers/other/await-bootstrap-test";
import { cleanOldFolders } from "../../../../helpers/filesystem/clean-old-folders";
import { convertTestName } from "../../../../helpers/filesystem/convert-test-name";
import { deleteProject } from "../../../../helpers/flows/delete-project";
import { navigateSettingsPages } from "../../../../helpers/ui/go-to-settings";

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

// Quarantined at triage (daily #1361): the project kebab never resolves under
// the name-derived `more-options-button_<name>` testid — see #1363.
test.fixme(
  "user must be able to see starter projects for mcp servers",
  { tag: ["@release", "@workspace", "@components", "@mcp"] },
  async ({ page }) => {
    //starter mcp project

    await awaitBootstrapTest(page, {
      skipModal: true,
    });

    await cleanOldFolders(page);
    await removeLeftoverRenamedProject(page);

    await navigateSettingsPages(page, "Settings", "MCP Servers");

    await expect(mcpServerRow(page, "lf-starter_project")).toHaveCount(1);

    await page.getByTestId("icon-ChevronLeft").first().click();

    //add new folders

    await page.getByTestId("add-project-button").click();
    await page.getByTestId("add-project-button").click();

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

    const getFirstFolderName = convertTestName(
      (await page.getByText("New Project").first().textContent()) as string,
    );

    await page
      .getByText("New Project")
      .first()
      .hover()
      .then(async () => {
        await page
          .getByTestId(`more-options-button_${getFirstFolderName}`)
          .last()
          .click();
        await page.getByText("Rename", { exact: true }).last().click();
        await page.getByTestId("input-project").last().fill(RENAMED_PROJECT);
        await page.keyboard.press("Enter");
        await page.waitForTimeout(1000);
      });

    await navigateSettingsPages(page, "Settings", "MCP Servers");

    await expect(mcpServerRow(page, "lf-starter_project")).toHaveCount(1);

    await expect(
      page.getByText("lf-renamed_project", { exact: true }),
    ).toHaveCount(1);

    //delete a folder

    await page.getByTestId("icon-ChevronLeft").first().click();
    await page
      .getByTestId("sidebar-nav-renamed_project")
      .hover()
      .then(async () => {
        await page
          .getByTestId("more-options-button_renamed_project")
          .last()
          .click();
        await page.getByText("Delete", { exact: true }).last().click();
        await page.getByText("Delete", { exact: true }).last().click();
        await page.waitForTimeout(1000);
      });

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
