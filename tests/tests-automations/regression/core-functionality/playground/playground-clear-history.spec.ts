import type { Page } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import { setupPlayground } from "../../../../helpers/flows/setup-playground";

/**
 * Session behavior confirmed from source (chat-header.tsx):
 *   isDefaultSession = currentSessionId === flowId
 *
 * Default session:
 *   - Menu trigger: data-testid="chat-header-more-menu"
 *   - Shows "Clear chat" (clear-chat-option) — clears messages, session persists
 *   - Never shows rename or delete options
 *   - NOTE: button is inside AnimatedConditional (framer-motion); this test clicks it via evaluate((el) => el.click())
 *
 * User-created session:
 *   - Menu trigger: data-testid="session-{id}-more-menu" (in sessions sidebar)
 *   - Shows "Delete" (delete-session-option) — removes session from list, returns to Default
 *   - Shows "Rename" (rename-session-option) only when session has at least 1 message
 *   - Never shows clear-chat-option
 *
 * Serial mode is required: both tests share the Langflow backend, and the second
 * test asserts a session COUNT in the playground sidebar, which a concurrent
 * sibling on the same flow would perturb. Cleanup is id-scoped (never
 * `cleanAllFlows`), so it does not delete a parallel worker's flow (#465/#515).
 *
 * The graph (ChatInput → ChatOutput) is built by the shared `setupPlayground`
 * helper, which creates the flow over the API and navigates straight to
 * `/flow/{id}`. The local `setupChatFlow` it replaces entered via the home page →
 * "New Flow" → templates modal → `blank-flow` path, which is what made this file
 * flake (#1063): while the welcome overlay is open, FlowPage mounts the whole
 * FlowSidebarComponent inside a `display: none` wrapper, so
 * `sidebar-search-input` is in the DOM with an empty box — what Playwright
 * reports as `hidden`. Going through the API never opens that overlay.
 */

async function sendMessage(page: Page, text: string): Promise<void> {
  await page.getByTestId("input-chat-playground").last().fill(text);
  await page.getByTestId("button-send").last().click();
  await expect(page.getByText(text).last()).toBeVisible({ timeout: 10000 });
  await expect(page.getByTestId("button-stop")).toBeHidden({ timeout: 30000 });
}

test.describe.configure({ mode: "serial" });

test.describe("Playground – Clear History & Session Delete", () => {
  let createdFlowId: string | null = null;

  test.afterEach(async ({ page, request }) => {
    if (!createdFlowId) return;
    const id = createdFlowId;
    createdFlowId = null;
    // Leave the editor first: its background polling for the current flow would
    // otherwise complete after the DELETE and log spurious 404s.
    await page.goto("/");
    // Explicit bearer: under AUTO_LOGIN a bare request context is
    // unauthenticated, so an unheadered DELETE 401s and silently leaks the flow.
    const bearer = await getAuthToken(request);
    await deleteFlow(request, id, {
      headers: { Authorization: bearer },
    }).catch(() => {});
  });

  test(
    "clear chat on Default session must remove messages but keep the session",
    { tag: ["@stable", "@release", "@regression", "@playground"] },
    async ({ page }) => {
      await test.step("Set up ChatInput → ChatOutput flow and open playground", async () => {
        createdFlowId = await setupPlayground(page);
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
    { tag: ["@stable", "@release", "@regression", "@playground"] },
    async ({ page }) => {
      await test.step("Set up ChatInput → ChatOutput flow and open playground", async () => {
        createdFlowId = await setupPlayground(page);
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
        // Capture how many session sidebar entries exist before deletion
        const sessionMenus = page.locator(
          '[data-testid$="-more-menu"]:not([data-testid="chat-header-more-menu"])',
        );
        const countBefore = await sessionMenus.count();
        expect(countBefore, "Expected at least one session entry in sidebar before delete").toBeGreaterThanOrEqual(1);

        // When a user-created session is active, chat-header-more-menu shows delete-session-option
        // (showDelete={!isDefaultSession} in chat-header.tsx)
        await page
          .getByTestId("chat-header-more-menu")
          .evaluate((el) => (el as HTMLElement).click());
        await expect(page.getByTestId("delete-session-option")).toBeVisible({
          timeout: 5000,
        });
        await page.getByTestId("delete-session-option").click();

        // Session entry must be removed from the sidebar
        await expect(sessionMenus).toHaveCount(countBefore - 1, { timeout: 5000 });
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
