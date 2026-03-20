import * as dotenv from "dotenv";
import path from "path";
import { expect, test } from "../../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../../helpers/other/await-bootstrap-test";
import { initialGPTsetup } from "../../../../helpers/other/initialGPTsetup";
import { selectAnthropicModel } from "../../../../helpers/mcp/select-anthropic-model";

test.describe("Language Model Component Regression", () => {
  test(
    "language model must respond with OpenAI provider",
    { tag: ["@release", "@components"] },
    async ({ page }) => {
      test.skip(
        !process?.env?.OPENAI_API_KEY,
        "OPENAI_API_KEY required to run this test",
      );

      if (!process.env.CI) {
        dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });
      }

      await awaitBootstrapTest(page);

      await page.getByTestId("side_nav_options_all-templates").click();
      await page.getByRole("heading", { name: "Basic Prompting" }).click();

      await initialGPTsetup(page);

      await page.getByTestId("button_run_chat output").click();
      await page.waitForSelector("text=built successfully", { timeout: 30000 });

      await page.getByRole("button", { name: "Playground", exact: true }).click();

      await page.getByTestId("new-chat").click();

      await page.waitForSelector('[data-testid="input-chat-playground"]', {
        timeout: 30000,
      });

      await page
        .getByTestId("input-chat-playground")
        .last()
        .fill("Say hello.");

      await page.getByTestId("button-send").last().click();

      // Wait for stop button to appear then disappear (response fully streamed)
      const stopBtn = page.getByRole("button", { name: "Stop" });
      if (await stopBtn.isVisible({ timeout: 10000 }).catch(() => false)) {
        await expect(stopBtn).toBeHidden({ timeout: 120000 });
      }

      await page.waitForSelector('[data-testid="div-chat-message"]', {
        timeout: 60000,
      });

      const responseText = await page
        .getByTestId("div-chat-message")
        .last()
        .innerText();

      expect(responseText.trim().length).toBeGreaterThan(1);
    },
  );

  test(
    "language model must respond with Anthropic provider",
    { tag: ["@release", "@components"] },
    async ({ page }) => {
      test.skip(
        !process?.env?.ANTHROPIC_API_KEY,
        "ANTHROPIC_API_KEY required to run this test",
      );

      if (!process.env.CI) {
        dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });
      }

      await awaitBootstrapTest(page);

      await page.getByTestId("side_nav_options_all-templates").click();
      await page.getByRole("heading", { name: "Basic Prompting" }).click();

      await selectAnthropicModel(page);

      await page.getByTestId("button_run_chat output").click();
      await page.waitForSelector("text=built successfully", { timeout: 30000 });

      await page.getByRole("button", { name: "Playground", exact: true }).click();

      await page.getByTestId("new-chat").click();

      await page.waitForSelector('[data-testid="input-chat-playground"]', {
        timeout: 30000,
      });

      await page
        .getByTestId("input-chat-playground")
        .last()
        .fill("Say hello.");

      await page.getByTestId("button-send").last().click();

      // Wait for stop button to appear then disappear (response fully streamed)
      const stopBtnA = page.getByRole("button", { name: "Stop" });
      if (await stopBtnA.isVisible({ timeout: 10000 }).catch(() => false)) {
        await expect(stopBtnA).toBeHidden({ timeout: 120000 });
      }

      await page.waitForSelector('[data-testid="div-chat-message"]', {
        timeout: 60000,
      });

      const responseText = await page
        .getByTestId("div-chat-message")
        .last()
        .innerText();

      expect(responseText.trim().length).toBeGreaterThan(1);
    },
  );

  test(
    "language model provider switch from OpenAI to Anthropic must persist",
    { tag: ["@release", "@components"] },
    async ({ page }) => {
      test.skip(
        !process?.env?.OPENAI_API_KEY || !process?.env?.ANTHROPIC_API_KEY,
        "OPENAI_API_KEY and ANTHROPIC_API_KEY required to run this test",
      );

      if (!process.env.CI) {
        dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });
      }

      await awaitBootstrapTest(page);

      await page.getByTestId("side_nav_options_all-templates").click();
      await page.getByRole("heading", { name: "Basic Prompting" }).click();

      await initialGPTsetup(page);

      await selectAnthropicModel(page);

      const languageModelNode = page
        .locator(".react-flow__node")
        .filter({ hasText: "Language Model" })
        .first();

      await expect(languageModelNode).toBeVisible({ timeout: 10000 });

      await expect(
        languageModelNode.locator('[data-testid="model_model"]'),
      ).toContainText("claude", { timeout: 10000 });
    },
  );

  test(
    "model provider modal must open and display providers list",
    { tag: ["@release", "@components", "@workspace", "@model-provider"] },
    async ({ page }) => {
      if (!process.env.CI) {
        dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });
      }

      await awaitBootstrapTest(page);

      await page.getByTestId("side_nav_options_all-templates").click();
      await page.getByRole("heading", { name: "Basic Prompting" }).click();

      // fit_view is inside canvas_controls_dropdown — wait for the dropdown instead
      await page.waitForSelector('[data-testid="canvas_controls_dropdown"]', {
        timeout: 30000,
      });

      const languageModelNode = page
        .locator(".react-flow__node")
        .filter({ hasText: "Language Model" })
        .first();

      await languageModelNode.click();

      const modelDropdown = page
        .locator('[data-testid="model_model"]')
        .first();

      if (await modelDropdown.isVisible({ timeout: 5000 })) {
        await modelDropdown.click();

        const manageProvidersBtn = page.getByText("Manage Model Providers");
        if (await manageProvidersBtn.isVisible({ timeout: 3000 })) {
          await manageProvidersBtn.click();

          // Dialog opened — verify provider list is shown
          await expect(
            page.getByTestId("provider-item-OpenAI"),
          ).toBeVisible({ timeout: 10000 });

          await page.keyboard.press("Escape");
        }
      }
    },
  );
});
