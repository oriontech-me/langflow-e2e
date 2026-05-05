import type { Page } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { setupPlayground } from "../../../../helpers/flows/setup-playground";

/**
 * Session behavior confirmed from source:
 *   - `new-chat` button creates a new isolated session in the sidebar
 *   - `session-selector` testid is present on each session row (Default + user-created)
 *   - `session-selector-trigger` opens the header dropdown (ChatSessionsDropdown) — this
 *     button lives in the `{!isFullscreen}` branch of ChatHeader. The playground always
 *     opens in fullscreen mode (FlowPage sets isFullscreen=true on first open), so
 *     session-selector-trigger is not rendered during normal test flow. Session switching
 *     is therefore tested exclusively via the sidebar session-selector items.
 *   - Switching sessions via sidebar: click the `session-selector` item directly
 *
 * Serial mode is required: both tests share the Langflow backend.
 * Flow cleanup in afterEach deletes flows to avoid state leakage.
 */

async function sendMessage(page: Page, text: string): Promise<void> {
  await page.getByTestId("input-chat-playground").last().fill(text);
  await page.getByTestId("button-send").last().click();
  await expect(page.getByText(text).last()).toBeVisible({ timeout: 10000 });
  await expect(page.getByTestId("button-stop")).toBeHidden({ timeout: 30000 });
}

test.describe.configure({ mode: "serial" });

test.describe("Playground – Session Create & Switch", () => {
  let createdFlowId: string | null = null;

  test.afterEach(async ({ page }) => {
    if (createdFlowId) {
      await page.goto("/");
      await page.request.delete(`/api/v1/flows/${createdFlowId}`);
      createdFlowId = null;
    }
  });

  test(
    "new-chat button creates a new session with isolated message history",
    { tag: ["@stable", "@regression", "@playground"] },
    async ({ page }) => {
      await test.step("Set up ChatInput → ChatOutput flow and open playground", async () => {
        createdFlowId = await setupPlayground(page);
        await page.getByTestId("playground-btn-flow-io").click();
        await expect(page.getByTestId("button-send")).toBeVisible({
          timeout: 15000,
        });
      });

      await test.step("Send a message in the Default session", async () => {
        await sendMessage(page, "default-session-message");
      });

      const sessionsBefore = page.getByTestId("session-selector");
      let countBefore: number;

      await test.step("Record session count before creating new session", async () => {
        countBefore = await sessionsBefore.count();
      });

      await test.step("Click new-chat and verify sidebar count increases by 1", async () => {
        await page.getByTestId("new-chat").click();
        await expect(sessionsBefore).toHaveCount(countBefore + 1, {
          timeout: 10000,
        });
      });

      await test.step("Verify new session starts with 0 messages", async () => {
        await expect(page.getByTestId("input-chat-playground").last()).toBeVisible({
          timeout: 10000,
        });
        await expect(page.getByTestId("div-chat-message")).toHaveCount(0, {
          timeout: 5000,
        });
      });

      await test.step("Send a message in the new session", async () => {
        await sendMessage(page, "new-session-message");
      });

      await test.step("Switch back to Default session via sidebar", async () => {
        // The first session-selector item is the Default session
        await page.getByTestId("session-selector").first().click();
        await expect(page.getByTestId("input-chat-playground").last()).toBeVisible({
          timeout: 10000,
        });
      });

      await test.step("Verify Default session shows its message and not the new session's message", async () => {
        await expect(page.getByText("default-session-message").last()).toBeVisible({
          timeout: 10000,
        });
        await expect(
          page.getByText("new-session-message"),
        ).toHaveCount(0, { timeout: 5000 });
      });
    },
  );

  test(
    "switching sessions via sidebar preserves message isolation in both directions",
    { tag: ["@stable", "@regression", "@playground"] },
    async ({ page }) => {
      /**
       * NOTE: session-selector-trigger (header dropdown) lives inside the
       * `{!isFullscreen}` branch of ChatHeader. The flow-page playground always
       * opens in fullscreen mode (FlowPage.onOpenChange sets isFullscreen=true),
       * so that element is never rendered. Session switching is validated here
       * via the sidebar session-selector, exercising the same underlying store
       * logic that the header dropdown also invokes.
       */
      await test.step("Set up ChatInput → ChatOutput flow and open playground", async () => {
        createdFlowId = await setupPlayground(page);
        await page.getByTestId("playground-btn-flow-io").click();
        await expect(page.getByTestId("button-send")).toBeVisible({
          timeout: 15000,
        });
      });

      await test.step("Send a message in the Default session", async () => {
        await sendMessage(page, "switch-test-default");
      });

      await test.step("Create a new session and send a message", async () => {
        await page.getByTestId("new-chat").click();
        await expect(page.getByTestId("input-chat-playground").last()).toBeVisible({
          timeout: 10000,
        });
        await expect(page.getByTestId("div-chat-message")).toHaveCount(0, {
          timeout: 5000,
        });
        await sendMessage(page, "switch-test-new-session");
      });

      await test.step("Switch back to Default session via sidebar and verify isolation", async () => {
        // First session-selector is Default; clicking it switches the active session
        await page.getByTestId("session-selector").first().click();
        await expect(page.getByTestId("input-chat-playground").last()).toBeVisible({
          timeout: 10000,
        });
        await expect(page.getByText("switch-test-default").last()).toBeVisible({
          timeout: 10000,
        });
        // New-session message must not appear in Default session
        await expect(page.getByText("switch-test-new-session")).toHaveCount(0, {
          timeout: 5000,
        });
      });

      await test.step("Switch back to new session and verify its message is preserved", async () => {
        // Second session-selector is the user-created session
        await page.getByTestId("session-selector").last().click();
        await expect(page.getByTestId("input-chat-playground").last()).toBeVisible({
          timeout: 10000,
        });
        await expect(page.getByText("switch-test-new-session").last()).toBeVisible({
          timeout: 10000,
        });
        // Default session message must not bleed into new session
        await expect(page.getByText("switch-test-default")).toHaveCount(0, {
          timeout: 5000,
        });
      });
    },
  );
});
