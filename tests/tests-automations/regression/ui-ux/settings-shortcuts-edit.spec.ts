import { expect, test } from "../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";

test.describe("Settings — Edit Shortcut", () => {
  test.afterEach(async ({ page }) => {
    // Cleanup: restore default shortcuts so subsequent tests start clean.
    // Implemented in Task 5.
  });

  test(
    "editing the Duplicate shortcut persists and triggers the action on canvas",
    { tag: ["@release", "@regression", "@settings", "@ui-ux"] },
    async ({ page }) => {
      await test.step("load home", async () => {
        await awaitBootstrapTest(page, { skipModal: true });
      });

      await test.step("navigate to Settings → Shortcuts", async () => {
        await page.getByTestId("user-profile-settings").click();
        await page.getByTestId("menu_settings_button").click();

        await page.waitForSelector('[data-testid="settings_menu_header"]', {
          timeout: 10000,
        });

        await page.getByRole("link", { name: "Shortcuts", exact: true }).click();

        await expect(page.getByTestId("settings_menu_header")).toContainText(
          "Shortcuts",
          { timeout: 5000 },
        );
      });
    },
  );
});
