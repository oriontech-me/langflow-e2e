import type { Page } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { setupPlayground } from "../../../../helpers/flows/setup-playground";

async function sendMessage(page: Page, text: string): Promise<void> {
  await page.getByTestId("input-chat-playground").last().fill(text);
  await page.getByTestId("button-send").last().click();
  await expect(page.getByText(text).last()).toBeVisible({ timeout: 10000 });
  await expect(page.getByTestId("button-stop")).toBeHidden({ timeout: 30000 });
}

async function createSession(page: Page, message: string): Promise<void> {
  await page.getByTestId("new-chat").click();
  await expect(page.getByTestId("input-chat-playground").last()).toBeVisible({
    timeout: 10000,
  });
  await sendMessage(page, message);
}

test.describe.configure({ mode: "serial" });

test.describe("Playground – Bulk Session Deletion", () => {
  let createdFlowId: string | null = null;

  test.afterEach(async ({ page }) => {
    if (createdFlowId) {
      await page.goto("/");
      await page.request.delete(`/api/v1/flows/${createdFlowId}`);
      createdFlowId = null;
    }
  });

  test(
    "selecting individual session checkbox reveals bulk-delete-button",
    { tag: ["@stable", "@regression", "@playground"] },
    async ({ page }) => {
      await test.step("Set up flow, open Playground, create a session", async () => {
        createdFlowId = await setupPlayground(page);
        await page.getByTestId("playground-btn-flow-io").click();
        await expect(page.getByTestId("input-chat-playground")).toBeVisible({
          timeout: 15000,
        });
        await createSession(page, "bulk-test-session-1");
      });

      await test.step("Click the session checkbox to select it", async () => {
        const checkbox = page
          .locator('[data-testid^="session-"][data-testid$="-checkbox"]')
          .first();
        await expect(checkbox).toBeVisible({ timeout: 5000 });
        await checkbox.click();
      });

      await test.step("Verify bulk-delete-button appears after selection", async () => {
        await expect(page.getByTestId("bulk-delete-button")).toBeVisible({
          timeout: 5000,
        });
      });
    },
  );

  test(
    "select-all-checkbox selects all non-default sessions",
    { tag: ["@stable", "@regression", "@playground"] },
    async ({ page }) => {
      await test.step("Set up flow, open Playground, create two sessions", async () => {
        createdFlowId = await setupPlayground(page);
        await page.getByTestId("playground-btn-flow-io").click();
        await expect(page.getByTestId("input-chat-playground")).toBeVisible({
          timeout: 15000,
        });
        await createSession(page, "select-all-session-1");
        await createSession(page, "select-all-session-2");
      });

      await test.step("Click select-all-checkbox", async () => {
        await expect(page.getByTestId("select-all-checkbox")).toBeVisible({
          timeout: 5000,
        });
        await page.getByTestId("select-all-checkbox").click();
      });

      await test.step("Verify all individual session checkboxes show selected state and bulk-delete-button appears", async () => {
        const individualCheckboxes = page.locator(
          '[data-testid^="session-"][data-testid$="-checkbox"]',
        );
        const count = await individualCheckboxes.count();
        expect(count, "Expected at least 2 individual session checkboxes").toBeGreaterThanOrEqual(2);
        await expect(page.getByTestId("bulk-delete-button")).toBeVisible({
          timeout: 5000,
        });
      });

      await test.step("Click select-all again to deselect all", async () => {
        await page.getByTestId("select-all-checkbox").click();
        await expect(page.getByTestId("bulk-delete-button")).toHaveCount(0, {
          timeout: 5000,
        });
      });
    },
  );

  test(
    "bulk-delete-button removes all selected sessions from the sidebar",
    { tag: ["@stable", "@regression", "@playground"] },
    async ({ page }) => {
      await test.step("Set up flow, open Playground, create two sessions", async () => {
        createdFlowId = await setupPlayground(page);
        await page.getByTestId("playground-btn-flow-io").click();
        await expect(page.getByTestId("input-chat-playground")).toBeVisible({
          timeout: 15000,
        });
        await createSession(page, "bulk-delete-session-1");
        await createSession(page, "bulk-delete-session-2");
      });

      await test.step("Select all sessions and click bulk-delete-button", async () => {
        await page.getByTestId("select-all-checkbox").click();
        await expect(page.getByTestId("bulk-delete-button")).toBeVisible({
          timeout: 5000,
        });
        await page.getByTestId("bulk-delete-button").click();
        // Only the Default session remains after bulk delete
        await expect(
          page.locator('[data-testid="session-selector"]'),
        ).toHaveCount(1, { timeout: 10000 });
      });

      await test.step("Verify no session checkboxes remain (all user sessions deleted)", async () => {
        await expect(
          page.locator('[data-testid^="session-"][data-testid$="-checkbox"]'),
        ).toHaveCount(0, { timeout: 5000 });
      });
    },
  );
});
