import { expect, test } from "../../../../fixtures/fixtures";
import { setupPlayground } from "../../../../helpers/flows/setup-playground";

/**
 * Message Logs are accessible via the session more-menu (message-logs-option).
 * The modal renders an ag-grid table (SessionView) showing messages for the session.
 * Rows can be selected via .ag-checkbox-input and deleted with delete-row-button.
 *
 * Source files:
 *   session-more-menu.tsx       — data-testid="message-logs-option"
 *   session-logs-modal.tsx      — renders SessionView inside BaseModal
 *   session-view.tsx            — ag-grid table; onDelete enabled when !playgroundPage
 *   tableComponent/TableOptions — data-testid="delete-row-button" (disabled until selection)
 *
 * playgroundPage is false in the embedded playground (flow editor),
 * so row deletion is available.
 *
 * Overlap note: playground.spec.ts (line 119-124) also opens message-logs-option
 * and asserts "Page 1 of 1". That test is a monolithic integration spec without
 * @stable; this spec is the dedicated, isolated, @stable coverage with different
 * assertions (.ag-row count). Row deletion (Test 2) is not covered anywhere else.
 */

test.describe.configure({ mode: "serial" });

test.describe("Playground – Message Logs", () => {
  let createdFlowId: string | null = null;

  test.afterEach(async ({ page }) => {
    if (createdFlowId) {
      await page.goto("/");
      await page.request.delete(`/api/v1/flows/${createdFlowId}`);
      createdFlowId = null;
    }
  });

  test(
    "message-logs-option must open the Session Logs modal for the active session",
    { tag: ["@stable", "@regression", "@playground"] },
    async ({ page }) => {
      await test.step("set up ChatInput → ChatOutput flow and open playground", async () => {
        createdFlowId = await setupPlayground(page);
        await page.getByTestId("playground-btn-flow-io").click();
        await expect(page.getByTestId("input-chat-playground").last()).toBeVisible({
          timeout: 15000,
        });
      });

      await test.step("send a message to populate the session with log entries", async () => {
        await page.getByTestId("input-chat-playground").last().fill("test log message");
        await page.getByTestId("button-send").last().click();
        await expect(page.getByText("test log message").last()).toBeVisible({
          timeout: 15000,
        });
        await expect(page.getByTestId("button-stop").last()).toBeHidden({
          timeout: 30000,
        });
      });

      await test.step("open the sidebar session more-menu and click message-logs-option", async () => {
        await page
          .locator('[data-testid^="session-"][data-testid$="-more-menu"]')
          .first()
          .click();
        await expect(page.getByTestId("message-logs-option")).toBeVisible({
          timeout: 5000,
        });
        await page.getByTestId("message-logs-option").click();
      });

      await test.step("verify the Session Logs modal opens with message rows in the table", async () => {
        await expect(page.getByText("Session logs")).toBeVisible({ timeout: 10000 });
        await expect(page.locator(".ag-row").first()).toBeVisible({ timeout: 10000 });
        const rowCount = await page.locator(".ag-row").count();
        expect(rowCount, "Session Logs table must contain at least one message row").toBeGreaterThan(0);
      });
    },
  );

  test(
    "selecting messages in the log table and deleting them must reduce the row count",
    { tag: ["@stable", "@regression", "@playground"] },
    async ({ page }) => {
      await test.step("set up ChatInput → ChatOutput flow and open playground", async () => {
        createdFlowId = await setupPlayground(page);
        await page.getByTestId("playground-btn-flow-io").click();
        await expect(page.getByTestId("input-chat-playground").last()).toBeVisible({
          timeout: 15000,
        });
      });

      await test.step("send a message to have a row to delete", async () => {
        await page.getByTestId("input-chat-playground").last().fill("message to delete");
        await page.getByTestId("button-send").last().click();
        await expect(page.getByText("message to delete").last()).toBeVisible({
          timeout: 15000,
        });
        await expect(page.getByTestId("button-stop").last()).toBeHidden({
          timeout: 30000,
        });
      });

      let rowsBefore = 0;
      await test.step("open the Session Logs modal and record initial row count", async () => {
        await page
          .locator('[data-testid^="session-"][data-testid$="-more-menu"]')
          .first()
          .click();
        await expect(page.getByTestId("message-logs-option")).toBeVisible({
          timeout: 5000,
        });
        await page.getByTestId("message-logs-option").click();
        await expect(page.getByText("Session logs")).toBeVisible({ timeout: 10000 });
        await expect(page.locator(".ag-row").first()).toBeVisible({ timeout: 10000 });
        rowsBefore = await page.locator(".ag-row").count();
      });

      await test.step("select the first row via its checkbox", async () => {
        await page.locator(".ag-checkbox-input").first().click();
        await expect(page.getByTestId("delete-row-button")).toBeEnabled({ timeout: 5000 });
      });

      await test.step("click delete-row-button and verify the row count decreases", async () => {
        await page.getByTestId("delete-row-button").click();
        await expect(page.locator(".ag-row")).toHaveCount(rowsBefore - 1, {
          timeout: 10000,
        });
      });
    },
  );
});
