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

      await test.step("open Duplicate row edit modal", async () => {
        const duplicateRow = page
          .locator("[role='row']")
          .filter({ hasText: "Duplicate" })
          .first();
        await expect(duplicateRow).toBeVisible({ timeout: 5000 });
        await duplicateRow.dblclick();

        await expect(
          page.getByText("Key Combination", { exact: true }),
        ).toBeVisible({ timeout: 5000 });
        await expect(
          page.getByText("Recording your keyboard"),
        ).toBeVisible({ timeout: 5000 });
      });

      await test.step("record Ctrl/Cmd+Alt+U and apply", async () => {
        await page.keyboard.press("ControlOrMeta+Alt+U");

        await page
          .getByRole("button", { name: "Apply", exact: true })
          .click();

        await expect(
          page.getByText("Duplicate shortcut successfully changed"),
        ).toBeVisible({ timeout: 5000 });

        const duplicateRowAfter = page
          .locator("[role='row']")
          .filter({ hasText: "Duplicate" })
          .first();
        await expect(duplicateRowAfter).toContainText(/Alt/i, { timeout: 5000 });
        await expect(duplicateRowAfter).toContainText("U", { timeout: 5000 });
      });

      await test.step("open a blank flow", async () => {
        await page.goto("/");
        await page.waitForSelector('[id="new-project-btn"]', { timeout: 30000 });
        await page.getByTestId("new-project-btn").click();
        await page.waitForSelector('[data-testid="blank-flow"]', {
          timeout: 10000,
        });
        await page.getByTestId("blank-flow").click();
      });

      await test.step("add one Ollama node to the canvas", async () => {
        await page.getByTestId("sidebar-search-input").click();
        await page.getByTestId("sidebar-search-input").fill("ollama");

        await page.waitForSelector('[data-testid="ollamaOllama"]', {
          timeout: 5000,
        });

        await page
          .getByTestId("ollamaOllama")
          .dragTo(page.locator('//*[@id="react-flow-id"]'));
        await page.mouse.up();
        await page.mouse.down();

        await expect(page.getByTestId("title-Ollama")).toHaveCount(1, {
          timeout: 10000,
        });
      });

      await test.step("press the new combination and confirm duplication", async () => {
        await page.getByTestId("title-Ollama").click();
        await page.keyboard.press("ControlOrMeta+Alt+U");

        await expect(page.getByTestId("title-Ollama")).toHaveCount(2, {
          timeout: 5000,
        });
      });
    },
  );
});
