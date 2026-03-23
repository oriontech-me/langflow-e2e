import type { Page } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { adjustScreenView } from "../../../../helpers/ui/adjust-screen-view";
import { awaitBootstrapTest } from "../../../../helpers/other/await-bootstrap-test";
import { cleanAllFlows } from "../../../../helpers/flows/clean-all-flows";
import { zoomOut } from "../../../../helpers/ui/zoom-out";

/**
 * Rename availability is controlled server-side by:
 *   canRenameSession = !isDefaultSession && hasMessages
 *
 * When false, the rename-session-option element is not rendered in the DOM at
 * all — no need to open the more-menu to assert its absence.
 *
 * The more-menu button uses a dynamic testid: session-{id}-more-menu.
 * We target it with the partial-match pattern ^session- + $-more-menu.
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
  await expect(
    page.getByTestId("input-chat-playground"),
  ).toHaveValue("", { timeout: 15000 });
}

test.describe("Playground – Session Rename (B2)", () => {
  test.describe.configure({ mode: "serial" });

  test.afterEach(async ({ page }) => {
    await page.goto("/");
    await cleanAllFlows(page);
  });

  test(
    "rename option must not be available for the Default Session",
    { tag: ["@regression", "@playground"] },
    async ({ page }) => {
      await test.step(
        "Set up ChatInput → ChatOutput echo flow and open playground",
        async () => {
          await setupChatEchoFlow(page);
          await openPlayground(page);
        },
      );

      await test.step(
        "Verify rename-session-option is absent for the Default Session",
        async () => {
          // canRenameSession = !isDefaultSession && hasMessages
          // isDefaultSession = true → option is never rendered in DOM
          await expect(
            page.getByTestId("rename-session-option"),
          ).toBeHidden();
        },
      );
    },
  );

  test(
    "rename option must not be available for a session with no messages",
    { tag: ["@regression", "@playground"] },
    async ({ page }) => {
      await test.step(
        "Set up ChatInput → ChatOutput echo flow and open playground",
        async () => {
          await setupChatEchoFlow(page);
          await openPlayground(page);
        },
      );

      await test.step("Create a new session without sending any message", async () => {
        await page.getByTestId("new-chat").click();
        await expect(page.getByTestId("input-chat-playground")).toBeVisible({
          timeout: 10000,
        });
      });

      await test.step(
        "Verify rename-session-option is absent for a session with no messages",
        async () => {
          // canRenameSession = !isDefaultSession && hasMessages
          // hasMessages = false → option is never rendered in DOM
          await expect(
            page.getByTestId("rename-session-option"),
          ).toBeHidden();
        },
      );
    },
  );

  test(
    "rename option must be available and functional for a session with messages",
    { tag: ["@regression", "@playground"] },
    async ({ page }) => {
      await test.step(
        "Set up ChatInput → ChatOutput echo flow and open playground",
        async () => {
          await setupChatEchoFlow(page);
          await openPlayground(page);
        },
      );

      await test.step(
        "Create a new session and send a message to enable rename",
        async () => {
          await page.getByTestId("new-chat").click();
          await expect(page.getByTestId("input-chat-playground")).toBeVisible({
            timeout: 10000,
          });
          await sendMessage(page, "hello rename test");
        },
      );

      await test.step(
        "Open the session more-menu and verify rename option is available",
        async () => {
          await page
            .locator('[data-testid^="session-"][data-testid$="-more-menu"]')
            .last()
            .click();
          await expect(
            page.getByTestId("rename-session-option"),
          ).toBeVisible({ timeout: 5000 });
        },
      );

      await test.step(
        "Rename the session and confirm with Enter",
        async () => {
          await page.getByTestId("rename-session-option").click();
          await page.getByTestId("session-rename-input").fill("my renamed session");
          await page.keyboard.press("Enter");
          await expect(
            page.getByTestId("session-selector").getByText("my renamed session"),
          ).toBeVisible({ timeout: 5000 });
        },
      );

      await test.step(
        "Open rename again and cancel with Escape — name must be preserved",
        async () => {
          await page
            .locator('[data-testid^="session-"][data-testid$="-more-menu"]')
            .last()
            .click();
          await page.getByTestId("rename-session-option").click();
          await page.getByTestId("session-rename-input").fill("discarded name");
          await page.keyboard.press("Escape");
          await expect(
            page.getByTestId("session-selector").getByText("my renamed session"),
          ).toBeVisible({ timeout: 5000 });
        },
      );
    },
  );
});
