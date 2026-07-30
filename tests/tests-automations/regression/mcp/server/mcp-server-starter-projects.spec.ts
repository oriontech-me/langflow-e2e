import type { Page } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../../helpers/other/await-bootstrap-test";
import { cleanOldFolders } from "../../../../helpers/filesystem/clean-old-folders";
import { convertTestName } from "../../../../helpers/filesystem/convert-test-name";
import { navigateSettingsPages } from "../../../../helpers/ui/go-to-settings";

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

test(
  "user must be able to see starter projects for mcp servers",
  { tag: ["@stable", "@release", "@workspace", "@components", "@mcp"] },
  async ({ page }) => {
    //starter mcp project

    await awaitBootstrapTest(page, {
      skipModal: true,
    });

    await cleanOldFolders(page);

    await navigateSettingsPages(page, "Settings", "MCP Servers");

    await expect(mcpServerRow(page, "lf-starter_project")).toHaveCount(1);

    await page.getByTestId("icon-ChevronLeft").first().click();

    //add new folders

    await page.getByTestId("add-project-button").click();
    await page.getByTestId("add-project-button").click();

    await navigateSettingsPages(page, "Settings", "MCP Servers");

    await expect(mcpServerRow(page, "lf-starter_project")).toHaveCount(1);

    expect(
      await page.getByText("lf-new_project", { exact: true }).count(),
    ).toBe(1);
    expect(
      await page.getByText("lf-new_project_1", { exact: true }).count(),
    ).toBe(1);

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
        await page.getByTestId("input-project").last().fill("renamed_project");
        await page.keyboard.press("Enter");
        await page.waitForTimeout(1000);
      });

    await navigateSettingsPages(page, "Settings", "MCP Servers");

    await expect(mcpServerRow(page, "lf-starter_project")).toHaveCount(1);

    expect(
      await page.getByText("lf-renamed_project", { exact: true }).count(),
    ).toBe(1);

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
    expect(
      await page.getByText("lf-renamed_project", { exact: true }).count(),
    ).toBe(0);
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
