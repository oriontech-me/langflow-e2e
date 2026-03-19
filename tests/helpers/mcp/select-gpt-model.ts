import type { Page } from "@playwright/test";
import { expect } from "../../fixtures/fixtures";
import { unselectNodes } from "../ui/unselect-nodes";

export const selectGptModel = async (page: Page) => {
  const nodes = page.locator(".react-flow__node", {
    has: page.getByTestId("title-language model"),
  });

  const nodeCount = await nodes.count();

  for (let i = 0; i < nodeCount; i++) {
    const node = nodes.nth(i);
    try {
      await expect(node.getByTestId("model_model").last()).toBeVisible({
        timeout: 10000,
      });
    } catch (error) {
      console.log("Node model not visible, proceeding...", error);
      await node.click();
    }

    const model = (await node.getByTestId("model_model").last().isVisible())
      ? node.getByTestId("model_model").last()
      : page.getByTestId("model_model").last();

    await expect(model).toBeVisible({ timeout: 10000 });
    await model.click();
    await page.waitForSelector('[role="listbox"]', { timeout: 10000 });

    // Always open Manage Model Providers to ensure the API key is configured
    await page.getByTestId("manage-model-providers").click();
    await page.waitForSelector("text=Model providers", { timeout: 30000 });

    await page.getByTestId("provider-item-OpenAI").click();
    await page.waitForTimeout(500);

    // Click the key input to enter edit mode (clears masked value if key exists)
    const keyInput = page.getByPlaceholder("sk-...");
    await keyInput.click();
    await page.keyboard.type(process.env.OPENAI_API_KEY!);

    // Button label varies: "Save Configuration" (new) or "Replace Configuration" (existing key)
    const saveBtn = page.getByRole("button", { name: /Save Configuration|Replace Configuration/ });
    await expect(saveBtn).toBeEnabled({ timeout: 5000 });
    await saveBtn.click();
    await page.waitForSelector("text=OpenAI Configuration Saved", {
      timeout: 30000,
    });

    // Wait for key verification to complete — toggle only appears after the API validates the key
    await page
      .getByTestId("llm-toggle-gpt-4o-mini")
      .waitFor({ state: "visible", timeout: 60000 });

    const isChecked = await page
      .getByTestId("llm-toggle-gpt-4o-mini")
      .isChecked();
    if (!isChecked) {
      await page.getByTestId("llm-toggle-gpt-4o-mini").click();
    }

    await page.getByText("Close").last().click();

    // Re-open dropdown to select the model
    await page.getByTestId("model_model").nth(i).click();
    await page.waitForSelector('[role="listbox"]', { timeout: 10000 });

    await page.waitForTimeout(500);
    await page.getByTestId("gpt-4o-mini-option").click();

    if (i < nodeCount - 1) {
      await unselectNodes(page);
    }
  }
};
