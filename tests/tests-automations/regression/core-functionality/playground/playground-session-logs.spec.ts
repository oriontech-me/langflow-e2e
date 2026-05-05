import type { Page } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { setupPlayground } from "../../../../helpers/flows/setup-playground";

async function sendMessage(page: Page, text: string): Promise<void> {
  await page.getByTestId("input-chat-playground").last().fill(text);
  await page.getByTestId("button-send").last().click();
  await expect(page.getByText(text).last()).toBeVisible({ timeout: 10000 });
  await expect(page.getByTestId("button-stop")).toBeHidden({ timeout: 30000 });
}

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
    "message-logs-option opens Session Logs modal for the session",
    { tag: ["@stable", "@regression", "@playground"] },
    async ({ page }) => {
      await test.step("Set up flow, open Playground, and send a message", async () => {
        createdFlowId = await setupPlayground(page);
        await page.getByTestId("playground-btn-flow-io").click();
        await expect(page.getByTestId("input-chat-playground")).toBeVisible({
          timeout: 15000,
        });
        await sendMessage(page, "log-test-message");
      });

      await test.step("Open session more menu and click message-logs-option", async () => {
        // The session more-menu button is inside ChatSidebar's SessionSelector.
        // Its testid is dynamic: session-{sessionId}-more-menu.
        // We target it with a partial-match pattern.
        await page
          .locator('[data-testid^="session-"][data-testid$="-more-menu"]')
          .first()
          .click();
        await expect(page.getByTestId("message-logs-option")).toBeVisible({
          timeout: 5000,
        });
        await page.getByTestId("message-logs-option").click();
      });

      await test.step("Verify Session Logs modal is open", async () => {
        // The modal header renders "Session logs" (lowercase L).
        await expect(
          page.getByText("Session logs").first(),
        ).toBeVisible({ timeout: 10000 });
        // Scope to the dialog to avoid matching the chat history in the background.
        // The table shows both the user message and bot echo, so .first() disambiguates.
        await expect(
          page.locator('[role="dialog"]').getByText("log-test-message").first(),
        ).toBeVisible({ timeout: 10000 });
      });
    },
  );

  // NOTE: row selection and delete are disabled when playgroundPage === true.
  // SessionView sets rowSelection={undefined} and onDelete={undefined} when
  // playgroundPage is true (see session-view.tsx). The delete-row-button is
  // only rendered by TableOptions when the deleteRow prop is defined, so it
  // is never present in the playground context. This test is intentionally
  // skipped and documents the finding for future re-evaluation.
  test(
    "delete-row-button removes selected messages from the Session Logs table",
    { tag: ["@regression", "@playground"] },
    async ({ page }) => {
      // @stable is intentionally absent: this test is permanently skipped because the feature
      // under test (row deletion) is disabled in the playground context — it cannot be validated.
      test.skip(
        true,
        "Row selection and delete are disabled in playground context (playgroundPage === true). " +
          "SessionView passes rowSelection={undefined} and onDelete={undefined} when opened from " +
          "the playground, so .ag-selection-checkbox and delete-row-button are never rendered.",
      );

      await test.step("Set up flow, open Playground, and send a message", async () => {
        createdFlowId = await setupPlayground(page);
        await page.getByTestId("playground-btn-flow-io").click();
        await expect(page.getByTestId("input-chat-playground")).toBeVisible({
          timeout: 15000,
        });
        await sendMessage(page, "message-to-delete");
      });

      await test.step("Open Session Logs modal", async () => {
        await page
          .locator('[data-testid^="session-"][data-testid$="-more-menu"]')
          .first()
          .click();
        await expect(page.getByTestId("message-logs-option")).toBeVisible({
          timeout: 5000,
        });
        await page.getByTestId("message-logs-option").click();
        await expect(page.getByText("Session logs").first()).toBeVisible({
          timeout: 10000,
        });
      });

      await test.step("Select the message row in the table", async () => {
        await expect(page.locator(".ag-row").first()).toBeVisible({
          timeout: 10000,
        });
        await page.locator(".ag-selection-checkbox").first().click();
        await expect(page.getByTestId("delete-row-button")).toBeVisible({
          timeout: 5000,
        });
      });

      await test.step("Delete the selected row and verify it is removed", async () => {
        await page.getByTestId("delete-row-button").click();
        await expect(page.locator(".ag-row")).toHaveCount(0, {
          timeout: 10000,
        });
      });
    },
  );
});
