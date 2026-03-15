import * as dotenv from "dotenv";
import path from "path";
import { expect, test } from "../../../../fixtures/fixtures";
import { loadSimpleAgentWithOpenAI } from "../../../../helpers/flows/load-simple-agent-with-openai";

test.describe.serial("Playground UX Regression (IDs 44 + 126 + 2)", () => {
  test(
    "user message must appear instantly in playground before AI responds",
    { tag: ["@release", "@components"] },
    async ({ page }) => {
      test.skip(
        !process?.env?.OPENAI_API_KEY,
        "OPENAI_API_KEY required to run this test",
      );

      if (!process.env.CI) {
        dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });
      }

      await loadSimpleAgentWithOpenAI(page);

      await page.getByTestId("playground-btn-flow-io").click();
      await page.getByTestId("new-chat").click();

      await page.waitForSelector('[data-testid="input-chat-playground"]', {
        timeout: 30000,
      });

      const userMessage = "Hello from regression test";
      await page.getByTestId("input-chat-playground").last().fill(userMessage);
      await page.getByTestId("button-send").last().click();

      // User message must appear immediately — before AI responds
      await expect(page.getByText(userMessage).last()).toBeVisible({
        timeout: 5000,
      });

      // Wait for completion
      const stopButton = page.getByRole("button", { name: "Stop" });
      if (await stopButton.isVisible({ timeout: 3000 }).catch(() => false)) {
        await expect(stopButton).toBeHidden({ timeout: 120000 });
      }
    },
  );

  test(
    "playground must scroll to latest message after sending",
    { tag: ["@release", "@components"] },
    async ({ page }) => {
      test.skip(
        !process?.env?.OPENAI_API_KEY,
        "OPENAI_API_KEY required to run this test",
      );

      if (!process.env.CI) {
        dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });
      }

      await loadSimpleAgentWithOpenAI(page);

      await page.getByTestId("playground-btn-flow-io").click();
      await page.getByTestId("new-chat").click();

      await page.waitForSelector('[data-testid="input-chat-playground"]', {
        timeout: 30000,
      });

      // Send multiple messages to force scroll
      const messages = ["First message.", "Second message.", "Third message."];
      for (const msg of messages) {
        await page.getByTestId("input-chat-playground").last().fill(msg);
        await page.getByTestId("button-send").last().click();

        const stopButton = page.getByRole("button", { name: "Stop" });
        await stopButton.waitFor({ state: "visible", timeout: 30000 });
        await expect(stopButton).toBeHidden({ timeout: 120000 });
      }

      // Last user message must be visible in viewport
      const lastMessage = page.getByText("Third message.").last();
      await expect(lastMessage).toBeVisible({ timeout: 10000 });
      await expect(lastMessage).toBeInViewport({ timeout: 5000 });
    },
  );

  test(
    "playground must render JSON structured output",
    { tag: ["@release", "@components"] },
    async ({ page }) => {
      test.skip(
        !process?.env?.OPENAI_API_KEY,
        "OPENAI_API_KEY required to run this test",
      );

      if (!process.env.CI) {
        dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });
      }

      await loadSimpleAgentWithOpenAI(page);

      await page.getByTestId("playground-btn-flow-io").click();
      await page.getByTestId("new-chat").click();

      await page.waitForSelector('[data-testid="input-chat-playground"]', {
        timeout: 30000,
      });

      await page
        .getByTestId("input-chat-playground")
        .last()
        .fill(
          'Reply ONLY with this exact JSON, no extra text: {"status": "ok", "value": 42}',
        );

      await page.getByTestId("button-send").last().click();

      const stopButton = page.getByRole("button", { name: "Stop" });
      await stopButton.waitFor({ state: "visible", timeout: 30000 });
      await expect(stopButton).toBeHidden({ timeout: 120000 });

      const lastMessage = page.getByTestId("div-chat-message").last();
      await expect(lastMessage).toBeVisible({ timeout: 10000 });

      const responseText = await lastMessage.innerText();
      expect(responseText.trim().length).toBeGreaterThan(0);

      // JSON rendered as code block (structured) or inline with keys
      const codeBlock = lastMessage.locator("code, pre");
      if ((await codeBlock.count()) > 0) {
        await expect(codeBlock.first()).toBeVisible();
      } else {
        expect(responseText).toContain("status");
      }
    },
  );

  test(
    "playground input field must be ready after AI responds",
    { tag: ["@release", "@components"] },
    async ({ page }) => {
      test.skip(
        !process?.env?.OPENAI_API_KEY,
        "OPENAI_API_KEY required to run this test",
      );

      if (!process.env.CI) {
        dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });
      }

      await loadSimpleAgentWithOpenAI(page);

      await page.getByTestId("playground-btn-flow-io").click();
      await page.getByTestId("new-chat").click();

      await page.waitForSelector('[data-testid="input-chat-playground"]', {
        timeout: 30000,
      });

      await page.getByTestId("input-chat-playground").last().fill("Hi.");
      await page.getByTestId("button-send").last().click();

      const stopButton = page.getByRole("button", { name: "Stop" });
      await stopButton.waitFor({ state: "visible", timeout: 30000 });
      await expect(stopButton).toBeHidden({ timeout: 120000 });

      // Input must be enabled and ready for next message
      const input = page.getByTestId("input-chat-playground").last();
      await expect(input).toBeVisible({ timeout: 5000 });
      await expect(input).toBeEnabled({ timeout: 5000 });

      await input.fill("Follow-up message.");
      expect(await input.inputValue()).toBe("Follow-up message.");
    },
  );
});
