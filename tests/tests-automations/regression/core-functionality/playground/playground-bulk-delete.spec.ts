import { expect, test } from "../../../../fixtures/fixtures";
import { setupPlayground } from "../../../../helpers/flows/setup-playground";

/**
 * Bulk session operations in the Playground sidebar.
 *
 * The select-all-checkbox and per-session checkboxes appear only for
 * non-default sessions (selectableSessions = sessions.filter(s => s !== flowId)).
 * The bulk-delete-button appears only when selectedSessions.size > 0.
 *
 * Source files:
 *   chat-sidebar.tsx    — data-testid="select-all-checkbox", "bulk-delete-button"
 *   session-selector.tsx — data-testid="session-{id}-checkbox" (dynamic)
 */

test.describe.configure({ mode: "serial" });

test.describe("Playground – Bulk Session Operations", () => {
  let createdFlowId: string | null = null;

  test.afterEach(async ({ page }) => {
    if (createdFlowId) {
      await page.goto("/");
      await page.request.delete(`/api/v1/flows/${createdFlowId}`);
      createdFlowId = null;
    }
  });

  test(
    "selecting an individual session checkbox must reveal the bulk-delete-button",
    { tag: ["@stable", "@regression", "@playground"] },
    async ({ page }) => {
      await test.step("set up ChatInput → ChatOutput flow and open playground", async () => {
        createdFlowId = await setupPlayground(page);
        await page.getByTestId("playground-btn-flow-io").click();
        await expect(page.getByTestId("input-chat-playground").last()).toBeVisible({
          timeout: 15000,
        });
      });

      await test.step("create a new session so a selectable checkbox is available", async () => {
        await page.getByTestId("new-chat").click();
        await expect(page.getByTestId("input-chat-playground").last()).toBeVisible({
          timeout: 10000,
        });
      });

      await test.step("verify bulk-delete-button is not visible before any selection", async () => {
        await expect(page.getByTestId("bulk-delete-button")).toHaveCount(0);
      });

      await test.step("click the per-session checkbox and verify bulk-delete-button appears", async () => {
        await page
          .locator('[data-testid$="-checkbox"]:not([data-testid="select-all-checkbox"])')
          .first()
          .click();
        await expect(page.getByTestId("bulk-delete-button")).toBeVisible({
          timeout: 5000,
        });
      });
    },
  );

  test(
    "select-all-checkbox must select all non-default sessions",
    { tag: ["@stable", "@regression", "@playground"] },
    async ({ page }) => {
      await test.step("set up ChatInput → ChatOutput flow and open playground", async () => {
        createdFlowId = await setupPlayground(page);
        await page.getByTestId("playground-btn-flow-io").click();
        await expect(page.getByTestId("input-chat-playground").last()).toBeVisible({
          timeout: 15000,
        });
      });

      await test.step("create two new sessions so multiple checkboxes are available", async () => {
        await page.getByTestId("new-chat").click();
        await expect(page.getByTestId("input-chat-playground").last()).toBeVisible({
          timeout: 10000,
        });
        await page.getByTestId("new-chat").click();
        await expect(page.getByTestId("input-chat-playground").last()).toBeVisible({
          timeout: 10000,
        });
      });

      await test.step("click select-all-checkbox and verify bulk-delete-button is visible", async () => {
        await expect(page.getByTestId("select-all-checkbox")).toBeVisible({ timeout: 5000 });
        await page.getByTestId("select-all-checkbox").click();
        await expect(page.getByTestId("bulk-delete-button")).toBeVisible({
          timeout: 5000,
        });
      });

      await test.step("verify all per-session checkboxes are in checked state", async () => {
        const checkboxes = page.locator(
          '[data-testid$="-checkbox"]:not([data-testid="select-all-checkbox"])',
        );
        const checkboxCount = await checkboxes.count();
        expect(
          checkboxCount,
          "Expected at least two selectable session checkboxes after creating two sessions",
        ).toBeGreaterThanOrEqual(2);
        for (let i = 0; i < checkboxCount; i++) {
          await expect(checkboxes.nth(i)).toBeChecked();
        }
      });
    },
  );

  test(
    "bulk-delete-button must remove all selected sessions from the sidebar",
    { tag: ["@stable", "@regression", "@playground"] },
    async ({ page }) => {
      await test.step("set up ChatInput → ChatOutput flow and open playground", async () => {
        createdFlowId = await setupPlayground(page);
        await page.getByTestId("playground-btn-flow-io").click();
        await expect(page.getByTestId("input-chat-playground").last()).toBeVisible({
          timeout: 15000,
        });
      });

      let totalBefore = 0;
      await test.step("create two new sessions and record total session count", async () => {
        await page.getByTestId("new-chat").click();
        await expect(page.getByTestId("input-chat-playground").last()).toBeVisible({
          timeout: 10000,
        });
        await page.getByTestId("new-chat").click();
        await expect(page.getByTestId("input-chat-playground").last()).toBeVisible({
          timeout: 10000,
        });
        totalBefore = await page.getByTestId("session-selector").count();
      });

      let selectableCount = 0;
      await test.step("select all non-default sessions via select-all-checkbox", async () => {
        await expect(page.getByTestId("select-all-checkbox")).toBeVisible({ timeout: 5000 });
        await page.getByTestId("select-all-checkbox").click();
        await expect(page.getByTestId("bulk-delete-button")).toBeVisible({
          timeout: 5000,
        });
        selectableCount = await page
          .locator('[data-testid$="-checkbox"]:not([data-testid="select-all-checkbox"])')
          .count();
      });

      await test.step("click bulk-delete-button and verify sessions are removed", async () => {
        await page.getByTestId("bulk-delete-button").click();
        await expect(page.getByTestId("session-selector")).toHaveCount(
          totalBefore - selectableCount,
          { timeout: 10000 },
        );
        // Default session must remain
        await expect(
          page.getByTestId("session-selector").filter({ hasText: "Default Session" }),
        ).toBeVisible({ timeout: 5000 });
      });
    },
  );
});
