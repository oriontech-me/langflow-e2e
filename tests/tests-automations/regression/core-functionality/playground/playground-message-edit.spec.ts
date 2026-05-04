import type { Route } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { setupPlayground } from "../../../../helpers/flows/setup-playground";

async function openPlaygroundWithMessage(
  page: any,
  messageText: string,
): Promise<void> {
  await page.route("**/api/v1/run/**", async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        outputs: [
          { outputs: [{ results: { message: { text: "Bot reply" } } }] },
        ],
        session_id: "msg-edit-session",
      }),
    });
  });

  await page.getByTestId("playground-btn-flow-io").click();
  await page.waitForSelector('[data-testid="input-chat-playground"]', {
    timeout: 15000,
  });

  const input = page.getByTestId("input-chat-playground").last();
  await input.fill(messageText);
  await page.getByTestId("button-send").click();
  await page.waitForSelector('[data-testid="div-chat-message"]', {
    timeout: 15000,
  });
}

async function hoverMessageAndClickEdit(
  page: any,
  messageText: string,
): Promise<void> {
  // Scope hover and icon lookup to the message group container so the
  // CSS group-hover state is never lost when moving the mouse to the button.
  const msgContainer = page
    .locator(".group")
    .filter({ hasText: messageText })
    .first();
  await msgContainer.hover();
  const editButton = msgContainer.locator('[data-testid="icon-Pen"]');
  await editButton.waitFor({ state: "visible", timeout: 3000 });
  await editButton.click();
  // EditMessageField mounts with autoFocus; wait for save-button as a readiness signal.
  await page.getByTestId("save-button").waitFor({ state: "visible" });
}

test.describe("Playground Message Edit", () => {
  test(
    "edit user message — hover reveals edit button and saved changes replace original text",
    { tag: ["@release", "@playground", "@stable"] },
    async ({ page }) => {
      await test.step("set up flow", async () => {
        await setupPlayground(page);
      });

      await test.step("open playground and send initial message", async () => {
        await openPlaygroundWithMessage(page, "Original message");
      });

      await test.step("hover user message to reveal edit button and enter edit mode", async () => {
        await hoverMessageAndClickEdit(page, "Original message");
      });

      await test.step("replace text and save", async () => {
        await page.keyboard.press("Control+a");
        await page.keyboard.type("Edited message");
        await page.getByTestId("save-button").click();
      });

      await test.step("verify edited text is shown and original text is gone", async () => {
        await expect(page.getByText("Edited message").first()).toBeVisible({
          timeout: 5000,
        });
        await expect(page.getByText("Original message")).toHaveCount(0, {
          timeout: 3000,
        });
      });
    },
  );

  test(
    "cancel message edit — original text is preserved",
    { tag: ["@regression", "@playground", "@stable"] },
    async ({ page }) => {
      await test.step("set up flow and send message", async () => {
        await setupPlayground(page);
        await openPlaygroundWithMessage(page, "Original message");
      });

      await test.step("open edit mode and type replacement text", async () => {
        await hoverMessageAndClickEdit(page, "Original message");
        await page.keyboard.press("Control+a");
        await page.keyboard.type("Discarded edit");
      });

      await test.step("cancel and verify original text is preserved", async () => {
        await page.getByTestId("cancel-button").click();
        await expect(page.getByText("Original message").first()).toBeVisible({
          timeout: 3000,
        });
        await expect(page.getByText("Discarded edit")).toHaveCount(0, {
          timeout: 3000,
        });
      });
    },
  );

  test(
    "message edited in playground is reflected in Session Logs",
    { tag: ["@regression", "@playground", "@stable"] },
    async ({ page }) => {
      await test.step("set up flow and send message", async () => {
        await setupPlayground(page);
        await openPlaygroundWithMessage(page, "Before edit");
      });

      await test.step("edit the sent message and confirm update in chat", async () => {
        await hoverMessageAndClickEdit(page, "Before edit");
        await page.keyboard.press("Control+a");
        await page.keyboard.type("After edit");
        await page.getByTestId("save-button").click();
        await expect(page.getByText("After edit").first()).toBeVisible({
          timeout: 5000,
        });
      });

      await test.step("open Session Logs and verify edited text is present", async () => {
        await page.getByTestId("chat-header-more-menu").click();
        await page.getByTestId("message-logs-option").click();
        await expect(page.getByText("Session logs").first()).toBeVisible({
          timeout: 5000,
        });
        await expect(page.getByText("After edit").first()).toBeVisible({
          timeout: 5000,
        });
      });
    },
  );
});
