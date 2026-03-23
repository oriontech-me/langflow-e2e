import type { Page } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { adjustScreenView } from "../../../../helpers/ui/adjust-screen-view";
import { awaitBootstrapTest } from "../../../../helpers/other/await-bootstrap-test";
import { cleanAllFlows } from "../../../../helpers/flows/clean-all-flows";
import { zoomOut } from "../../../../helpers/ui/zoom-out";

/**
 * Session behavior confirmed from source (chat-header.tsx):
 *   isDefaultSession = currentSessionId === flowId
 *
 * Default session:
 *   - Menu trigger: data-testid="chat-header-more-menu"
 *   - Shows "Clear chat" (clear-chat-option) — clears messages, session persists
 *   - Never shows rename or delete options
 *   - NOTE: button is inside AnimatedConditional (framer-motion); use { force: true } to click
 *
 * User-created session:
 *   - Menu trigger: data-testid="session-{id}-more-menu" (in sessions sidebar)
 *   - Shows "Delete" (delete-session-option) — removes session from list, returns to Default
 *   - Shows "Rename" (rename-session-option) only when session has at least 1 message
 *   - Never shows clear-chat-option
 *
 * Serial mode is required: both tests share the Langflow backend.
 * cleanAllFlows in afterEach deletes ALL flows — parallel execution causes race conditions.
 */

async function setupChatFlow(page: Page): Promise<void> {
  await awaitBootstrapTest(page);
  await expect(page.getByTestId("blank-flow")).toBeVisible({ timeout: 30000 });
  await page.getByTestId("blank-flow").click();

  // Add Chat Output via button
  await page.getByTestId("sidebar-search-input").fill("chat output");
  await expect(page.getByTestId("input_outputChat Output")).toBeVisible({
    timeout: 30000,
  });
  await page
    .getByTestId("input_outputChat Output")
    .hover()
    .then(async () => {
      await page.getByTestId("add-component-button-chat-output").click();
    });

  await zoomOut(page, 2);

  // Add Chat Input via drag to avoid node overlap
  await page.getByTestId("sidebar-search-input").fill("chat input");
  await expect(page.getByTestId("input_outputChat Input")).toBeVisible({
    timeout: 30000,
  });
  await page
    .getByTestId("input_outputChat Input")
    .dragTo(page.locator('//*[@id="react-flow-id"]'), {
      targetPosition: { x: 100, y: 100 },
    });

  await adjustScreenView(page);

  await expect(page.locator(".react-flow__node")).toHaveCount(2, {
    timeout: 10000,
  });

  // Connect Chat Input → Chat Output
  await page
    .getByTestId("handle-chatinput-noshownode-chat message-source")
    .click();
  await page
    .getByTestId("handle-chatoutput-noshownode-inputs-target")
    .click();

  await expect(page.locator(".react-flow__edge")).toHaveCount(1, {
    timeout: 8000,
  });
}

async function sendMessage(page: Page, text: string): Promise<void> {
  await page.getByTestId("input-chat-playground").last().fill(text);
  await page.getByTestId("button-send").last().click();
  await expect(page.getByText(text).last()).toBeVisible({ timeout: 10000 });
  await expect(page.getByTestId("button-stop")).toBeHidden({ timeout: 30000 });
}

test.describe.configure({ mode: "serial" });

test.describe("Playground – Clear History & Session Delete", () => {
  test.afterEach(async ({ page }) => {
    await page.goto("/");
    await cleanAllFlows(page);
  });

  test(
    "clear chat on Default session must remove messages but keep the session",
    { tag: ["@release", "@regression", "@playground"] },
    async ({ page }) => {
      await test.step("Set up ChatInput → ChatOutput flow and open playground", async () => {
        await setupChatFlow(page);
        await page.getByTestId("playground-btn-flow-io").click();
        await expect(page.getByTestId("button-send")).toBeVisible({
          timeout: 15000,
        });
      });

      await test.step("Send a message to populate the chat", async () => {
        await sendMessage(page, "Hello from test");
        await expect(page.getByTestId("div-chat-message").first()).toBeVisible({
          timeout: 10000,
        });
      });

      await test.step("Open Default session menu and clear chat", async () => {
        // The SelectTrigger is inside AnimatedConditional (framer-motion) which can have
        // a sibling div overlapping during animation. Use DOM .click() via evaluate to
        // trigger Radix Select's internal event handler without coordinate dependency.
        await page
          .getByTestId("chat-header-more-menu")
          .evaluate((el) => (el as HTMLElement).click());
        await expect(page.getByTestId("clear-chat-option")).toBeVisible({
          timeout: 5000,
        });
        await page.getByTestId("clear-chat-option").click();
      });

      await test.step("Verify messages are cleared and session persists", async () => {
        await expect(page.getByTestId("div-chat-message")).toHaveCount(0, {
          timeout: 10000,
        });
        // Default session menu trigger must still be present (session was not deleted)
        await expect(
          page.getByTestId("chat-header-more-menu"),
        ).toBeVisible({ timeout: 5000 });
      });
    },
  );

  test(
    "deleting a user-created session must remove it and return to Default session",
    { tag: ["@release", "@regression", "@playground"] },
    async ({ page }) => {
      await test.step("Set up ChatInput → ChatOutput flow and open playground", async () => {
        await setupChatFlow(page);
        await page.getByTestId("playground-btn-flow-io").click();
        await expect(page.getByTestId("button-send")).toBeVisible({
          timeout: 15000,
        });
      });

      await test.step("Create a new session and send a message", async () => {
        await page.getByTestId("new-chat").click();
        await expect(
          page.getByTestId("input-chat-playground").last(),
        ).toBeVisible({ timeout: 10000 });
        await sendMessage(page, "Message in new session");
        await expect(page.getByTestId("div-chat-message").first()).toBeVisible({
          timeout: 10000,
        });
      });

      await test.step("Delete the user-created session via the header menu", async () => {
        // When a user-created session is active, chat-header-more-menu shows delete-session-option
        // (showDelete={!isDefaultSession} in chat-header.tsx)
        await page
          .getByTestId("chat-header-more-menu")
          .evaluate((el) => (el as HTMLElement).click());
        await expect(page.getByTestId("delete-session-option")).toBeVisible({
          timeout: 5000,
        });
        await page.getByTestId("delete-session-option").click();
      });

      await test.step("Verify session is removed and Default session is active", async () => {
        // After deletion the app returns to Default session
        // Default session menu trigger must be present
        await expect(
          page.getByTestId("chat-header-more-menu"),
        ).toBeVisible({ timeout: 10000 });
        // Clear chat option is exclusive to Default session
        await page
          .getByTestId("chat-header-more-menu")
          .evaluate((el) => (el as HTMLElement).click());
        await expect(page.getByTestId("clear-chat-option")).toBeVisible({
          timeout: 5000,
        });
        // Delete option must not be present (we are on Default)
        await expect(
          page.getByTestId("delete-session-option"),
        ).toHaveCount(0);
      });
    },
  );
});
