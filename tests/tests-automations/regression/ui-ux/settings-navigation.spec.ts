import { expect, test } from "../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";

test(
  "user can access Settings page from the profile menu",
  { tag: ["@release", "@workspace", "@regression"] },
  async ({ page }) => {
    await awaitBootstrapTest(page, { skipModal: true });

    // Navigate to Settings via profile menu
    await page.getByTestId("user-profile-settings").click();
    await page.getByTestId("menu_settings_button").click();

    // Settings page must load with the General section as default
    await page.waitForSelector('[data-testid="settings_menu_header"]', {
      timeout: 10000,
    });
    await expect(page.getByTestId("settings_menu_header")).toBeVisible();
  },
);

test(
  "Settings page shows all main sections in sidebar navigation",
  { tag: ["@release", "@workspace", "@regression"] },
  async ({ page }) => {
    await awaitBootstrapTest(page, { skipModal: true });

    await page.getByTestId("user-profile-settings").click();
    await page.getByTestId("menu_settings_button").click();

    await page.waitForSelector('[data-testid="settings_menu_header"]', {
      timeout: 10000,
    });

    // All main settings sections must be listed as navigation links in the sidebar
    await expect(page.getByRole("link", { name: "General", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Model Providers", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Shortcuts", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Messages", exact: true })).toBeVisible();
  },
);

test(
  "Settings Shortcuts section lists keyboard shortcuts",
  { tag: ["@release", "@workspace", "@regression"] },
  async ({ page }) => {
    await awaitBootstrapTest(page, { skipModal: true });

    await page.getByTestId("user-profile-settings").click();
    await page.getByTestId("menu_settings_button").click();

    await page.waitForSelector('[data-testid="settings_menu_header"]', {
      timeout: 10000,
    });

    // Navigate to Shortcuts section
    await page.getByText("Shortcuts", { exact: true }).click();
    await page.waitForTimeout(500);

    // Shortcuts header must appear
    await expect(page.getByTestId("settings_menu_header")).toContainText(
      "Shortcuts",
    );

    // Must list at least some keyboard shortcuts (key bindings shown in the table)
    const shortcutRows = page.locator("table tbody tr, [role='row']");
    await expect(shortcutRows.first()).toBeVisible({ timeout: 5000 });
  },
);

test(
  "Settings Model Providers section loads with provider configuration",
  { tag: ["@release", "@workspace", "@regression"] },
  async ({ page }) => {
    await awaitBootstrapTest(page, { skipModal: true });

    await page.getByTestId("user-profile-settings").click();
    await page.getByTestId("menu_settings_button").click();

    await page.waitForSelector('[data-testid="settings_menu_header"]', {
      timeout: 10000,
    });

    // Navigate to Model Providers
    await page.getByText("Model Providers", { exact: true }).click();
    await page.waitForTimeout(500);

    await expect(page.getByTestId("settings_menu_header").last()).toContainText(
      "Model Providers",
      { timeout: 5000 },
    );

    // Page should contain provider configuration description
    await expect(
      page.getByText(
        "Configure AI model providers and manage their API keys.",
      ),
    ).toBeVisible({ timeout: 5000 });
  },
);
