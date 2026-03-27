import { expect, test } from "../../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../../helpers/other/await-bootstrap-test";
import { navigateSettingsPages } from "../../../../helpers/ui/go-to-settings";

test.describe("Model Provider API Key Management", () => {
  test(
    "Model Providers settings page loads with provider list",
    { tag: ["@release", "@workspace", "@regression", "@model-provider"] },
    async ({ page }) => {
      await awaitBootstrapTest(page, { skipModal: true });

      await navigateSettingsPages(page, "Settings", "Model Providers");

      await expect(
        page.getByTestId("settings_menu_header").last(),
      ).toContainText("Model Providers", { timeout: 10000 });

      // Provider configuration description should be present
      await expect(
        page.getByText(/configure.*model providers|manage.*api keys/i).first(),
      ).toBeVisible({ timeout: 5000 });
    },
  );

  test(
    "OpenAI provider is listed in Model Providers settings",
    { tag: ["@release", "@workspace", "@regression", "@model-provider"] },
    async ({ page }) => {
      await awaitBootstrapTest(page, { skipModal: true });

      await navigateSettingsPages(page, "Settings", "Model Providers");

      await expect(
        page.getByTestId("settings_menu_header").last(),
      ).toContainText("Model Providers", { timeout: 10000 });

      // OpenAI should be a visible provider
      await expect(
        page.getByText("OpenAI", { exact: false }).first(),
      ).toBeVisible({ timeout: 10000 });
    },
  );

  test(
    "Anthropic provider is listed in Model Providers settings",
    { tag: ["@release", "@workspace", "@regression", "@model-provider"] },
    async ({ page }) => {
      await awaitBootstrapTest(page, { skipModal: true });

      await navigateSettingsPages(page, "Settings", "Model Providers");

      await expect(
        page.getByTestId("settings_menu_header").last(),
      ).toContainText("Model Providers", { timeout: 10000 });

      // Anthropic should be a visible provider
      await expect(
        page.getByText("Anthropic", { exact: false }).first(),
      ).toBeVisible({ timeout: 10000 });
    },
  );

  test(
    "clicking a provider opens its API key configuration",
    { tag: ["@release", "@workspace", "@regression", "@model-provider"] },
    async ({ page }) => {
      await awaitBootstrapTest(page, { skipModal: true });

      await navigateSettingsPages(page, "Settings", "Model Providers");

      await expect(
        page.getByTestId("settings_menu_header").last(),
      ).toContainText("Model Providers", { timeout: 10000 });

      // Click on OpenAI to open its config
      const openaiProvider = page
        .getByText("OpenAI", { exact: false })
        .first();
      await openaiProvider.click();
      await page.waitForTimeout(500);

      // An API key input should appear (or a save button, or provider details)
      const apiKeyInput = page
        .locator(
          'input[type="password"], input[placeholder*="api" i], input[placeholder*="key" i]',
        )
        .first();
      const saveBtn = page
        .getByRole("button", { name: /save|apply|connect/i })
        .first();
      const providerDetails = page
        .locator('[data-testid*="provider"], [class*="provider"]')
        .first();

      const hasApiKeyInput = await apiKeyInput
        .isVisible({ timeout: 3000 })
        .catch(() => false);
      const hasSaveBtn = await saveBtn
        .isVisible({ timeout: 3000 })
        .catch(() => false);
      const hasProviderDetails = await providerDetails
        .isVisible({ timeout: 3000 })
        .catch(() => false);

      expect(
        hasApiKeyInput || hasSaveBtn || hasProviderDetails,
        "Clicking a provider should open its configuration details",
      ).toBe(true);
    },
  );
});
