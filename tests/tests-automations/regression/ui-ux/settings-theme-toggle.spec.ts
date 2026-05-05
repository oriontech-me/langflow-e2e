import { expect, test } from "../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";

test.describe("Settings — Theme Toggle", () => {
  test(
    "dark and light mode toggle correctly updates the body class",
    { tag: ["@release", "@stable", "@settings", "@ui-ux"] },
    async ({ page }) => {
      await test.step("load home page", async () => {
        await awaitBootstrapTest(page, { skipModal: true });
      });

      await test.step("normalize to light mode", async () => {
        await page.getByTestId("user-profile-settings").click();
        await expect(page.getByTestId("menu_light_button")).toBeVisible({
          timeout: 5000,
        });
        await page.getByTestId("menu_light_button").click();
        await expect(page.locator("#body.dark")).not.toBeAttached({
          timeout: 5000,
        });
        // Theme buttons are not DropdownMenuItems and do not close the dropdown automatically.
        // Press Escape to dismiss the menu before the next step.
        await page.keyboard.press("Escape");
        await expect(page.getByRole("menu")).toBeHidden({ timeout: 5000 });
      });

      await test.step("switch to dark mode and verify body class", async () => {
        await page.getByTestId("user-profile-settings").click();
        await expect(page.getByTestId("menu_dark_button")).toBeVisible({
          timeout: 5000,
        });
        await page.getByTestId("menu_dark_button").click();
        await expect(page.locator("#body.dark")).toBeAttached({ timeout: 5000 });
        await page.keyboard.press("Escape");
        await expect(page.getByRole("menu")).toBeHidden({ timeout: 5000 });
      });

      await test.step("switch to light mode and verify body class", async () => {
        await page.getByTestId("user-profile-settings").click();
        await expect(page.getByTestId("menu_light_button")).toBeVisible({
          timeout: 5000,
        });
        await page.getByTestId("menu_light_button").click();
        await expect(page.locator("#body.dark")).not.toBeAttached({
          timeout: 5000,
        });
        await page.keyboard.press("Escape");
        await expect(page.getByRole("menu")).toBeHidden({ timeout: 5000 });
      });

      await test.step("restore system theme", async () => {
        await page.getByTestId("user-profile-settings").click();
        await expect(page.getByTestId("menu_system_button")).toBeVisible({
          timeout: 5000,
        });
        await page.getByTestId("menu_system_button").click();
        await page.keyboard.press("Escape");
        await expect(page.getByRole("menu")).toBeHidden({ timeout: 5000 });
      });
    },
  );
});
