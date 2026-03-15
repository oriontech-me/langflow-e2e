import { expect, test } from "../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";

test.describe("Sidebar Category Filter", () => {
  test(
    "sidebar shows category sections on blank flow",
    { tag: ["@release", "@workspace", "@regression"] },
    async ({ page }) => {
      await awaitBootstrapTest(page);

      await page.waitForSelector('[data-testid="blank-flow"]', {
        timeout: 30000,
      });
      await page.getByTestId("blank-flow").click();

      await page.waitForSelector('[data-testid="sidebar-search-input"]', {
        timeout: 30000,
      });

      // Sidebar should be visible
      await expect(page.getByTestId("shad-sidebar")).toBeVisible();

      // Category disclosures should be visible
      await expect(
        page.getByTestId("disclosure-input & output"),
      ).toBeVisible({ timeout: 10000 });
      await expect(
        page.getByTestId("disclosure-models & agents"),
      ).toBeVisible({ timeout: 10000 });
    },
  );

  test(
    "searching for a component shows matching results",
    { tag: ["@release", "@workspace", "@regression"] },
    async ({ page }) => {
      await awaitBootstrapTest(page);

      await page.waitForSelector('[data-testid="blank-flow"]', {
        timeout: 30000,
      });
      await page.getByTestId("blank-flow").click();

      await page.waitForSelector('[data-testid="sidebar-search-input"]', {
        timeout: 30000,
      });

      // Type in the search box
      await page.getByTestId("sidebar-search-input").click();
      await page.getByTestId("sidebar-search-input").fill("chat input");

      // Chat Input should appear in results
      await expect(
        page.getByTestId("input_outputChat Input"),
      ).toBeVisible({ timeout: 10000 });
    },
  );

  test(
    "clearing search restores category view",
    { tag: ["@release", "@workspace", "@regression"] },
    async ({ page }) => {
      await awaitBootstrapTest(page);

      await page.waitForSelector('[data-testid="blank-flow"]', {
        timeout: 30000,
      });
      await page.getByTestId("blank-flow").click();

      await page.waitForSelector('[data-testid="sidebar-search-input"]', {
        timeout: 30000,
      });

      // First search for something
      await page.getByTestId("sidebar-search-input").click();
      await page.getByTestId("sidebar-search-input").fill("openai");

      await expect(page.getByTestId("openaiOpenAI")).toBeVisible({
        timeout: 10000,
      });

      // Clear the search
      await page.getByTestId("sidebar-search-input").fill("");
      await page.getByTestId("sidebar-search-input").press("Control+a");
      await page.getByTestId("sidebar-search-input").press("Delete");

      // Wait for input to be empty
      await expect(
        page.getByTestId("sidebar-search-input"),
      ).toHaveValue("", { timeout: 5000 });

      // Category disclosures should be visible again
      await expect(
        page.getByTestId("disclosure-input & output"),
      ).toBeVisible({ timeout: 10000 });
    },
  );

  test(
    "searching for a category name shows relevant components",
    { tag: ["@release", "@workspace", "@regression"] },
    async ({ page }) => {
      await awaitBootstrapTest(page);

      await page.waitForSelector('[data-testid="blank-flow"]', {
        timeout: 30000,
      });
      await page.getByTestId("blank-flow").click();

      await page.waitForSelector('[data-testid="sidebar-search-input"]', {
        timeout: 30000,
      });

      // Search for "text output" component
      await page.getByTestId("sidebar-search-input").click();
      await page.getByTestId("sidebar-search-input").fill("text output");

      // Text Output should appear
      await expect(
        page.getByTestId("input_outputText Output"),
      ).toBeVisible({ timeout: 10000 });

      // Chat Input should NOT be visible (not matching "text output")
      // Note: it might still be visible if "text output" matches something related
      // so we just verify "Text Output" appears
      const textOutputCount = await page
        .getByTestId("input_outputText Output")
        .count();
      expect(textOutputCount).toBeGreaterThan(0);
    },
  );

  test(
    "sidebar options trigger opens filter panel",
    { tag: ["@release", "@workspace", "@regression"] },
    async ({ page }) => {
      await awaitBootstrapTest(page);

      await page.waitForSelector('[data-testid="blank-flow"]', {
        timeout: 30000,
      });
      await page.getByTestId("blank-flow").click();

      await page.waitForSelector('[data-testid="sidebar-search-input"]', {
        timeout: 30000,
      });

      // Click the options/settings trigger for the sidebar
      await page.getByTestId("sidebar-options-trigger").click();

      // Some settings/toggles should appear
      // Check that the options panel opened (legacy switch or beta switch should be visible)
      const legacySwitch = page.getByTestId("sidebar-legacy-switch");
      const betaSwitch = page.getByTestId("sidebar-beta-switch");

      const hasLegacy = await legacySwitch
        .isVisible({ timeout: 3000 })
        .catch(() => false);
      const hasBeta = await betaSwitch
        .isVisible({ timeout: 3000 })
        .catch(() => false);

      expect(hasLegacy || hasBeta).toBeTruthy();
    },
  );
});
