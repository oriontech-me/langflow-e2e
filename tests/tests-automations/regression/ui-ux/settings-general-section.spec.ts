import { expect, test } from "../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";

// NOTE: In LANGFLOW_AUTO_LOGIN=true mode, the General settings page hides the
// password form (conditional: {!autoLogin && <PasswordFormComponent>}).
// Only GeneralPageHeaderComponent and optional profile picture form are rendered.

test.describe("Settings General Section", () => {
  test.beforeEach(async ({ page }) => {
    await awaitBootstrapTest(page, { skipModal: true });
    await page.getByTestId("user-profile-settings").click();
    await page.getByTestId("menu_settings_button").click();
    await page.waitForSelector('[data-testid="settings_menu_header"]', {
      timeout: 15000,
    });
  });

  test(
    "Settings General section loads and shows its header",
    { tag: ["@stable", "@release", "@regression", "@settings"] },
    async ({ page }) => {
      await page.getByRole("link", { name: "General", exact: true }).click();
      await page.waitForTimeout(500);

      // General section must load with its header
      await expect(page.getByTestId("settings_menu_header")).toContainText(
        "General",
        { timeout: 10000 },
      );

      // The header alone does not prove the section rendered — assert the
      // groups the General page actually ships on the 1.12 nightly. A generic
      // "some main element is visible" check passed even on an empty page.
      await expect(
        page.getByText("Language", { exact: true }).first(),
      ).toBeVisible({ timeout: 10000 });
      await expect(
        page.getByText(
          "Choose the display language for the Langflow interface.",
        ),
      ).toBeVisible({ timeout: 5000 });
      await expect(
        page.getByText("Profile Picture", { exact: true }).first(),
      ).toBeVisible({ timeout: 5000 });
    },
  );

  test(
    "Settings Messages section is accessible",
    { tag: ["@stable", "@release", "@regression", "@settings"] },
    async ({ page }) => {
      await page.getByRole("link", { name: "Messages", exact: true }).click();
      await page.waitForTimeout(500);

      await expect(page.getByTestId("settings_menu_header")).toContainText(
        "Messages",
        { timeout: 10000 },
      );
    },
  );

  test(
    "Settings Shortcuts section is accessible and lists shortcuts",
    { tag: ["@stable", "@release", "@regression", "@settings"] },
    async ({ page }) => {
      await page.getByRole("link", { name: "Shortcuts", exact: true }).click();
      await page.waitForTimeout(500);

      await expect(page.getByTestId("settings_menu_header")).toContainText(
        "Shortcuts",
        { timeout: 10000 },
      );

      // Shortcuts section shows a table of keyboard shortcuts
      const shortcutRows = page.locator("table tbody tr, [role='row']");
      await expect(shortcutRows.first()).toBeVisible({ timeout: 5000 });
    },
  );
});
