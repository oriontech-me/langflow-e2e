import type { Page } from "@playwright/test";
import { expect } from "../../fixtures/fixtures";
import { unselectNodes } from "../ui/unselect-nodes";

export const selectAnthropicModel = async (page: Page) => {
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

    await page.getByTestId("provider-item-Anthropic").click();
    await page.waitForTimeout(500);

    // Click the key input to enter edit mode (clears masked value if key exists)
    const keyInput = page.getByPlaceholder("sk-ant-...");
    await keyInput.click();
    await page.keyboard.type(process.env.ANTHROPIC_API_KEY!);

    // Button label varies: "Save Configuration" (new) or "Replace Configuration" (existing key)
    const saveBtn = page.getByRole("button", { name: /Save Configuration|Replace Configuration/ });
    await expect(saveBtn).toBeEnabled({ timeout: 5000 });
    await saveBtn.click();
    await page.waitForSelector("text=Anthropic Configuration Saved", {
      timeout: 30000,
    });

    // Wait for key verification to complete — toggle only appears after the API validates the key
    await page
      .getByTestId("llm-toggle-claude-sonnet-4-5-20250929")
      .waitFor({ state: "visible", timeout: 60000 });

    const isChecked = await page
      .getByTestId("llm-toggle-claude-sonnet-4-5-20250929")
      .isChecked();
    if (!isChecked) {
      await page.getByTestId("llm-toggle-claude-sonnet-4-5-20250929").click();
    }

    await page.getByText("Close").last().click();

    // Re-open dropdown and click Claude option — retries if dropdown closes during re-render
    let modelSelected = false;
    for (let attempt = 0; attempt < 5 && !modelSelected; attempt++) {
      await page.getByTestId("model_model").nth(i).click();
      try {
        const option = page.getByTestId("claude-sonnet-4-5-20250929-option");
        await option.waitFor({ state: "visible", timeout: 10000 });
        await option.click({ timeout: 5000 });
        modelSelected = true;
      } catch {
        // Dropdown may have closed or re-rendered, retry opening
        await page.waitForTimeout(300);
      }
    }
    if (!modelSelected) {
      throw new Error("Failed to select claude-sonnet-4-5-20250929 after 5 attempts");
    }

    if (i < nodeCount - 1) {
      await unselectNodes(page);
    }
  }
};
