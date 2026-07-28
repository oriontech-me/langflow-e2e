import type { Page } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import { setupPlayground } from "../../../../helpers/flows/setup-playground";

// Id of the flow the running test created; teardown deletes only this one via
// the API (scoped) — never a global cleanAllFlows, which wipes flows other
// parallel workers are actively building mid-run (#515/#589).
let createdFlowId: string | undefined;

/**
 * Clear chat is available via chat-header-more-menu (not the session more-menu).
 * The option fires clearDefaultSession directly — no confirmation dialog.
 */

async function setupChatEchoFlow(page: Page): Promise<void> {
  // Was a line-by-line copy of `setupPlayground`, and therefore carried the same
  // concurrency defect (#988): it created the flow through the home page →
  // templates modal → "Blank Flow" path, whose `POST /api/v1/flows/` races
  // another worker's on the server-derived name and 500s. Delegating to the
  // shared helper fixes it in one place and keeps the two from drifting apart.
  createdFlowId = await setupPlayground(page);
}

async function openPlayground(page: Page): Promise<void> {
  await page.getByTestId("playground-btn-flow-io").click();
  await expect(page.getByTestId("input-chat-playground")).toBeVisible({
    timeout: 15000,
  });
}

async function sendMessage(page: Page, text: string): Promise<void> {
  await page.getByTestId("input-chat-playground").fill(text);
  await page.getByTestId("button-send").click();
  await expect(page.getByTestId("input-chat-playground")).toHaveValue("", {
    timeout: 15000,
  });
  await expect(page.getByTestId("button-stop")).toBeHidden({ timeout: 15000 });
}

test.describe("Playground – Clear Session History", () => {
  test.afterEach(async ({ page }) => {
    const flowId = createdFlowId;
    createdFlowId = undefined;
    if (!flowId) return;

    // Delete ONLY the flow this test created (scoped teardown, #515/#589).
    // Navigate off the editor first so the unmounted flow page stops polling
    // the flow we are about to delete, then pass an explicit auth header —
    // page.request is unauthenticated under AUTO_LOGIN and would 401 otherwise.
    // Not swallowed: a failed cleanup surfaces instead of silently leaking.
    await page.goto("/");
    const authHeader = await getAuthToken(page.request);
    const opts = authHeader
      ? { headers: { Authorization: authHeader } }
      : undefined;
    await deleteFlow(page.request, flowId, opts);
  });

  test(
    "clear-chat removes all messages from Default Session",
    { tag: ["@stable", "@regression", "@playground"] },
    async ({ page }) => {
      await test.step(
        "Set up ChatInput → ChatOutput echo flow and open playground",
        async () => {
          await setupChatEchoFlow(page);
          await openPlayground(page);
        },
      );

      await test.step("Send a message and wait for bot response", async () => {
        await sendMessage(page, "hello clear test");
        await expect(page.getByTestId("div-chat-message")).toBeVisible({
          timeout: 15000,
        });
      });

      await test.step("Assert at least one message exists (pre-condition)", async () => {
        const count = await page.getByTestId("div-chat-message").count();
        expect(count).toBeGreaterThanOrEqual(1);
      });

      await test.step("Open chat header more-menu", async () => {
        // Native element click via evaluate bypasses the framer-motion overlay
        await page
          .getByTestId("chat-header-more-menu")
          .evaluate((el) => (el as HTMLElement).click());
        await expect(page.getByTestId("clear-chat-option")).toBeVisible({
          timeout: 5000,
        });
      });

      await test.step(
        "Click clear-chat-option and assert all messages are removed",
        async () => {
          await page.getByTestId("clear-chat-option").click();
          await expect(page.getByTestId("div-chat-message")).toHaveCount(0, {
            timeout: 8000,
          });
        },
      );
    },
  );
});
