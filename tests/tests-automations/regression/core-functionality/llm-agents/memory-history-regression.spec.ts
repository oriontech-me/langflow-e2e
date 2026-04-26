import * as dotenv from "dotenv";
import path from "path";
import type { Page } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { adjustScreenView } from "../../../../helpers/ui/adjust-screen-view";
import { updateOldComponents } from "../../../../helpers/flows/update-old-components";
import { FlowEditorPage, PlaygroundPage } from "../../../../pages";

if (!process.env.CI) {
  dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });
}

async function loadMemoryChatbot(page: Page): Promise<void> {
  await page.goto("/");
  await page.waitForSelector('[data-testid="mainpage_title"]', { timeout: 30000 });

  const emptyPageDescription = page.getByTestId("empty_page_description");
  while ((await emptyPageDescription.count()) === 0) {
    const dropdown = page.getByTestId("home-dropdown-menu").first();
    if (!(await dropdown.isVisible({ timeout: 2000 }).catch(() => false))) break;
    await dropdown.click();
    await page.getByTestId("btn_delete_dropdown_menu").first().waitFor({ state: "visible", timeout: 5000 });
    await page.getByTestId("btn_delete_dropdown_menu").first().click();
    await page.getByTestId("btn_delete_delete_confirmation_modal").first().click();
    await page.waitForTimeout(500);
  }

  const newProjectBtn = page.getByTestId("new-project-btn");
  const emptyBtn = page.getByTestId("new_project_btn_empty_page");
  if (await newProjectBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await newProjectBtn.click();
  } else {
    await emptyBtn.click();
  }

  await page.waitForSelector('[data-testid="modal-title"]', { timeout: 10000 });
  await page.getByTestId("side_nav_options_all-templates").click();
  await page.getByRole("heading", { name: "Memory Chatbot" }).first().click();
  await page.waitForSelector('[data-testid="canvas_controls_dropdown"]', { timeout: 30000 });

  await adjustScreenView(page);
  await updateOldComponents(page);
  await adjustScreenView(page);
}

async function configureOpenAIApiKey(page: Page): Promise<void> {
  const apiKeyInput = page.getByTestId("popover-anchor-input-api_key");
  if (await apiKeyInput.isVisible({ timeout: 5000 }).catch(() => false)) {
    await apiKeyInput.fill(process.env.OPENAI_API_KEY ?? "");
  }
}

async function waitForChatResponse(page: Page): Promise<void> {
  await page.waitForSelector('[data-testid="div-chat-message"]', { timeout: 120000 });
  const stopButton = page.getByRole("button", { name: "Stop" });
  if (await stopButton.isVisible({ timeout: 3000 }).catch(() => false)) {
    await expect(stopButton).toBeHidden({ timeout: 120000 });
  }
}

test.describe("Memory Chatbot Regression", () => {
  test(
    "memory chatbot template loads with correct node structure",
    { tag: ["@stable", "@release", "@agents", "@playground"] },
    async ({ page }) => {
      await loadMemoryChatbot(page);

      await test.step("canvas has all 6 required nodes", async () => {
        await expect.soft(page.getByTestId("title-Chat Input")).toBeVisible({ timeout: 10000 });
        await expect.soft(page.getByTestId("title-Chat Output")).toBeVisible({ timeout: 10000 });
        await expect.soft(page.getByTestId("title-Message History")).toBeVisible({ timeout: 10000 });
        await expect.soft(page.getByTestId("title-OpenAI")).toBeVisible({ timeout: 10000 });
        await expect.soft(page.getByTestId("title-Prompt Template")).toBeVisible({ timeout: 10000 });
        await expect.soft(page.getByTestId("title-Type Convert")).toBeVisible({ timeout: 10000 });
      });

      await test.step("canvas has exactly 6 nodes", async () => {
        const nodeCount = await page.locator(".react-flow__node").count();
        expect.soft(nodeCount).toBe(6);
      });
    },
  );

  test(
    "message history context retention suite",
    { tag: ["@stable", "@release", "@agents", "@playground"] },
    async ({ page }) => {
      test.skip(
        !process.env.OPENAI_API_KEY,
        "OPENAI_API_KEY required to run this test",
      );

      await loadMemoryChatbot(page);
      await configureOpenAIApiKey(page);

      const flowEditor = new FlowEditorPage(page);
      const playground = new PlaygroundPage(page);

      await flowEditor.waitForCanvas();
      await page.getByTestId("playground-btn-flow-io").click();
      await page.waitForSelector('[data-testid="input-chat-playground"]', { timeout: 30000 });

      await test.step("message history retains context within same session", async () => {
        await playground.sendMessage("My name is Alice. Please confirm you received my name.");
        await waitForChatResponse(page);
        await expect.soft(page.getByTestId("div-chat-message").last()).toBeVisible({ timeout: 30000 });

        await playground.sendMessage("What is my name?");
        await waitForChatResponse(page);

        const response = await page.getByTestId("div-chat-message").last().innerText();
        expect.soft(response).toMatch(/Alice/i);
      });

      await test.step("multiple consecutive messages accumulate in history", async () => {
        const count = await page.getByTestId("div-chat-message").count();
        expect.soft(count).toBeGreaterThanOrEqual(4);
      });

      await test.step("messages persist after closing and reopening playground", async () => {
        const messagesBefore = await page.getByTestId("div-chat-message").count();

        await page.getByTestId("playground-close-button").click();
        await page.waitForTimeout(500);

        await page.getByTestId("playground-btn-flow-io").click();
        await page.waitForSelector('[data-testid="input-chat-playground"]', { timeout: 30000 });

        const messagesAfter = await page.getByTestId("div-chat-message").count();
        expect.soft(messagesAfter).toBeGreaterThanOrEqual(messagesBefore);
      });
    },
  );

  test(
    "session isolation: new session has no context from previous session",
    { tag: ["@stable", "@release", "@agents", "@playground"] },
    async ({ page }) => {
      test.skip(
        !process.env.OPENAI_API_KEY,
        "OPENAI_API_KEY required to run this test",
      );

      await loadMemoryChatbot(page);
      await configureOpenAIApiKey(page);

      const playground = new PlaygroundPage(page);

      await page.getByTestId("playground-btn-flow-io").click();
      await page.waitForSelector('[data-testid="input-chat-playground"]', { timeout: 30000 });

      await playground.sendMessage("My name is Bob. Please confirm you received my name.");
      await waitForChatResponse(page);
      await expect(page.getByTestId("div-chat-message").last()).toBeVisible({ timeout: 30000 });

      await page.getByTestId("session-selector-trigger").click();
      await page.getByText("New Session").click();
      await page.waitForSelector('[data-testid="input-chat-playground"]', { timeout: 10000 });

      const messagesInNewSession = await page.getByTestId("div-chat-message").count();
      expect(messagesInNewSession).toBe(0);
    },
  );
});
