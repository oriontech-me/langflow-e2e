import type { Page } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { adjustScreenView } from "../../../../helpers/ui/adjust-screen-view";
import { awaitBootstrapTest } from "../../../../helpers/other/await-bootstrap-test";
import { cleanAllFlows } from "../../../../helpers/flows/clean-all-flows";
import { zoomOut } from "../../../../helpers/ui/zoom-out";

/**
 * Clear chat is available via chat-header-more-menu (not the session more-menu).
 * The option fires clearDefaultSession directly — no confirmation dialog.
 */

async function setupChatEchoFlow(page: Page): Promise<void> {
  await awaitBootstrapTest(page);
  await expect(page.getByTestId("blank-flow")).toBeVisible({ timeout: 30000 });
  await page.getByTestId("blank-flow").click();

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
    await page.goto("/");
    await cleanAllFlows(page);
  });

  test(
    "clear-chat removes all messages from Default Session",
    { tag: ["@regression", "@playground"] },
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
