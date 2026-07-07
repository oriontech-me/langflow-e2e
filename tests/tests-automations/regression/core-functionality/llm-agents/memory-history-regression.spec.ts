import * as dotenv from "dotenv";
import path from "path";
import type { Page } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { adjustScreenView } from "../../../../helpers/ui/adjust-screen-view";
import { updateOldComponents } from "../../../../helpers/flows/update-old-components";
import { loadTemplateByName } from "../../../../helpers/flows/load-template-by-name";
import { PlaygroundPage } from "../../../../pages";
import { setupLanguageModelOpenAI } from "../../../../helpers/provider-setup/setup-language-model-openai";

if (!process.env.CI) {
  dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });
}

async function loadMemoryChatbot(page: Page): Promise<void> {
  await loadTemplateByName(page, "Memory Chatbot");

  await adjustScreenView(page);
  await updateOldComponents(page);
  await adjustScreenView(page);
}

// Waits until `expectedResponses` bot responses have *fully completed*.
//
// A response's `chat-message-token-usage` badge is rendered only once that response
// finishes, so its count is a stable completion signal. The `div-chat-message` element
// is NOT usable for this: its count flickers while a response streams in (the bubble
// mounts, unmounts on a re-render, then settles), so waiting on it can return on a
// transient peak before the new response actually arrives — the root cause of the flaky
// history/isolation assertions in issue #354. The 120s budget covers live LLM latency.
async function waitForChatResponse(page: Page, expectedResponses: number): Promise<void> {
  await expect(page.getByTestId("chat-message-token-usage")).toHaveCount(expectedResponses, {
    timeout: 120000,
  });
}

test.describe("Memory Chatbot Regression", () => {
  test(
    "memory chatbot template loads with correct node structure",
    { tag: ["@release", "@agents", "@playground"] },
    async ({ page }) => {
      await loadMemoryChatbot(page);

      await test.step("canvas has all 6 required nodes", async () => {
        await expect.soft(page.getByTestId("title-Chat Input")).toBeVisible({ timeout: 10000 });
        await expect.soft(page.getByTestId("title-Chat Output")).toBeVisible({ timeout: 10000 });
        await expect.soft(page.getByTestId("title-Message History")).toBeVisible({ timeout: 10000 });
        await expect.soft(page.getByTestId("title-Language Model")).toBeVisible({ timeout: 10000 });
        await expect.soft(page.getByTestId("title-Prompt Template")).toBeVisible({ timeout: 10000 });
        await expect.soft(page.getByTestId("note_node")).toBeVisible({ timeout: 10000 });
      });

      await test.step("canvas has exactly 6 nodes", async () => {
        const nodeCount = await page.locator(".react-flow__node").count();
        expect.soft(nodeCount).toBe(6);
      });
    },
  );

  test(
    "message history context retention suite",
    { tag: ["@release", "@agents", "@playground"] },
    async ({ page }) => {
      test.skip(
        !process.env.OPENAI_API_KEY,
        "OPENAI_API_KEY required to run this test",
      );

      await loadMemoryChatbot(page);
      await setupLanguageModelOpenAI(page);

      const playground = new PlaygroundPage(page);

      await page.getByTestId("playground-btn-flow-io").click();
      await page.waitForSelector('[data-testid="input-chat-playground"]', { timeout: 30000 });

      await test.step("message history retains context within same session", async () => {
        await playground.sendMessage("My name is Alice. Please confirm you received my name.");
        await waitForChatResponse(page, 1);
        await expect.soft(page.getByTestId("div-chat-message").last()).toBeVisible({ timeout: 30000 });

        await playground.sendMessage("What is my name?");
        await waitForChatResponse(page, 2);

        const response = await page.getByTestId("div-chat-message").last().innerText();
        expect.soft(response).toMatch(/Alice/i);
      });

      await test.step("multiple consecutive messages accumulate in history", async () => {
        await expect
          .poll(() => page.getByTestId("div-chat-message").count(), { timeout: 10000 })
          .toBeGreaterThanOrEqual(2);
      });

      await test.step("messages persist after closing and reopening playground", async () => {
        const messagesBefore = await page.getByTestId("div-chat-message").count();

        await page.getByTestId("playground-close-button").click();
        await expect(page.getByTestId("input-chat-playground")).toBeHidden({ timeout: 10000 });

        await page.getByTestId("playground-btn-flow-io").click();
        await expect(page.getByTestId("input-chat-playground")).toBeVisible({ timeout: 30000 });

        // History reloads asynchronously on reopen; web-first wait for it to restore.
        await expect.soft(page.getByTestId("div-chat-message")).toHaveCount(messagesBefore, {
          timeout: 30000,
        });
      });
    },
  );

  test(
    "session isolation: new session has no context from previous session",
    { tag: ["@release", "@agents", "@playground"] },
    async ({ page }) => {
      test.skip(
        !process.env.OPENAI_API_KEY,
        "OPENAI_API_KEY required to run this test",
      );

      await loadMemoryChatbot(page);
      await setupLanguageModelOpenAI(page);

      const playground = new PlaygroundPage(page);

      await page.getByTestId("playground-btn-flow-io").click();
      await page.waitForSelector('[data-testid="input-chat-playground"]', { timeout: 30000 });

      await playground.sendMessage("My name is Bob. Please confirm you received my name.");
      await waitForChatResponse(page, 1);
      await expect(page.getByTestId("div-chat-message").last()).toBeVisible({ timeout: 30000 });

      // "new-chat" button is in the sessions sidebar (data-testid="new-chat")
      await page.getByTestId("new-chat").click();

      // Web-first: a fresh session must contain zero bot messages. toHaveCount(0)
      // auto-retries until the session reset settles, so a reset slower than a
      // fixed wait no longer false-fails (replaces waitForTimeout(500) + a hard
      // count assertion — issue #354 secondary latent risk).
      await expect(page.getByTestId("div-chat-message")).toHaveCount(0, {
        timeout: 10000,
      });
    },
  );
});
