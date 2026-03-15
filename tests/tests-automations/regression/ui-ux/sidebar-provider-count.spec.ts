import { expect, test } from "../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";

test.describe("Sidebar Provider Search", () => {
  test.beforeEach(async ({ page }) => {
    await awaitBootstrapTest(page);
    await page.waitForSelector('[data-testid="blank-flow"]', { timeout: 30000 });
    await page.getByTestId("blank-flow").click();
    // Wait for sidebar to be ready
    await page.waitForSelector('[data-testid="sidebar-search-input"]', {
      timeout: 15000,
    });
  });

  test(
    "sidebar search returns results for known providers",
    { tag: ["@release", "@regression"] },
    async ({ page }) => {
      const searchInput = page.getByTestId("sidebar-search-input");

      // Search for OpenAI
      await searchInput.click();
      await searchInput.fill("OpenAI");
      await page.waitForTimeout(1000);

      // At least one result with "openai" in its testid should be visible
      const openaiResult = page.locator('[data-testid*="openai"]').first();
      await expect(openaiResult).toBeVisible({ timeout: 10000 });

      // Search for Anthropic
      await searchInput.click();
      await searchInput.fill("Anthropic");
      await page.waitForTimeout(1000);

      const anthropicResult = page
        .locator('[data-testid*="anthropic"], [data-testid*="Anthropic"]')
        .first();
      await expect(anthropicResult).toBeVisible({ timeout: 10000 });
    },
  );

  test(
    "clearing search shows all components",
    { tag: ["@release", "@regression"] },
    async ({ page }) => {
      const searchInput = page.getByTestId("sidebar-search-input");

      // Search for something that should yield no results
      await searchInput.click();
      await searchInput.fill("nonexistent_xyz_abc_123");
      await page.waitForTimeout(1000);

      // There should be no standard component categories visible
      const noResults = page.locator(
        '[data-testid^="input_output"], [data-testid^="models_and_agents"]',
      );
      const countAfterBadSearch = await noResults.count();
      // We expect 0 or very few matches for a nonsense search term
      expect(countAfterBadSearch).toBe(0);

      // Clear the search field
      await searchInput.click();
      await searchInput.fill("");
      await page.waitForTimeout(1000);

      // After clearing, the sidebar shows category sections (not individual components)
      // Verify the sidebar is restored by checking for the search input (still visible)
      // and that the "no results" state is gone (sidebar has content)
      await expect(searchInput).toHaveValue("");
      // The sidebar should show some category headings or component sections
      const sidebarContent = page.locator(
        '[class*="sidebar"] [class*="category"], [data-testid*="sidebar"] button, .overflow-y-auto button',
      ).first();
      await expect(sidebarContent).toBeVisible({ timeout: 10000 });
    },
  );
});
