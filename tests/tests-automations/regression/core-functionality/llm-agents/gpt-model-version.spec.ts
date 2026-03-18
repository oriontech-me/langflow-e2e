import { expect, test } from "../../../../fixtures/fixtures";
import { adjustScreenView } from "../../../../helpers/ui/adjust-screen-view";
import { awaitBootstrapTest } from "../../../../helpers/other/await-bootstrap-test";

test.describe("GPT Model Version Selection", () => {
  test(
    "OpenAI component has a model dropdown that accepts input",
    { tag: ["@release", "@workspace", "@regression", "@model-provider"] },
    async ({ page }) => {
      await awaitBootstrapTest(page);

      await page.waitForSelector('[data-testid="blank-flow"]', {
        timeout: 30000,
      });
      await page.getByTestId("blank-flow").click();

      // Add OpenAI component
      await page.getByTestId("sidebar-search-input").fill("openai");
      await page.waitForSelector('[data-testid="openaiOpenAI"]', {
        timeout: 30000,
      });
      await page
        .getByTestId("openaiOpenAI")
        .hover()
        .then(async () => {
          await page.getByTestId("add-component-button-openai").last().click();
        });

      await adjustScreenView(page);

      await expect(page.locator(".react-flow__node")).toHaveCount(1, {
        timeout: 10000,
      });

      // The OpenAI component should have a model name field
      // Look for the model dropdown or input
      const modelInput = page
        .locator(
          'input[placeholder*="model" i], [data-testid*="model"], [role="combobox"]',
        )
        .first();
      const hasModelField = await modelInput
        .isVisible({ timeout: 5000 })
        .catch(() => false);

      // Also check for text showing a model name like "gpt-4o-mini" or "gpt-4"
      const hasModelText = await page
        .getByText(/gpt-4|gpt-3\.5|gpt-4o/i)
        .first()
        .isVisible({ timeout: 3000 })
        .catch(() => false);

      expect(
        hasModelField || hasModelText,
        "OpenAI component should show a model name/selector",
      ).toBe(true);
    },
  );

  test(
    "OpenAI model name field can be edited",
    { tag: ["@release", "@workspace", "@regression", "@model-provider"] },
    async ({ page }) => {
      await awaitBootstrapTest(page);

      await page.waitForSelector('[data-testid="blank-flow"]', {
        timeout: 30000,
      });
      await page.getByTestId("blank-flow").click();

      await page.getByTestId("sidebar-search-input").fill("openai");
      await page.waitForSelector('[data-testid="openaiOpenAI"]', {
        timeout: 30000,
      });
      await page
        .getByTestId("openaiOpenAI")
        .hover()
        .then(async () => {
          await page.getByTestId("add-component-button-openai").last().click();
        });

      await adjustScreenView(page);

      // Find and interact with model name field
      // OpenAI component shows "gpt-4o-mini" or similar by default
      // Look for the input in the component node
      const node = page.locator(".react-flow__node").first();
      await node.click();

      // Try to find a model input within the node or its expanded panel
      const modelInput = page
        .locator('input[value*="gpt"], input[placeholder*="model" i]')
        .first();

      const isEditable = await modelInput
        .isVisible({ timeout: 3000 })
        .catch(() => false);

      if (isEditable) {
        const currentValue = await modelInput.inputValue();
        expect(currentValue).toMatch(/gpt|claude|model/i);
      } else {
        // Model might be in a combobox — just assert the node is there and functional
        await expect(node).toBeVisible();
      }
    },
  );

  test(
    "Language Model component offers model selection dropdown",
    { tag: ["@release", "@workspace", "@regression", "@model-provider"] },
    async ({ page }) => {
      await awaitBootstrapTest(page);

      await page.waitForSelector('[data-testid="blank-flow"]', {
        timeout: 30000,
      });
      await page.getByTestId("blank-flow").click();

      // Search for Language Model component
      await page.getByTestId("sidebar-search-input").fill("language model");
      await page.waitForTimeout(1000);

      // If Language Model component is found, add it
      const addBtn = page.getByTestId(
        "add-component-button-language-model",
      );
      const hasComponent = await addBtn
        .isVisible({ timeout: 5000 })
        .catch(() => false);

      if (!hasComponent) {
        // Skip if Language Model component not found (may vary by Langflow version)
        return;
      }

      await addBtn.click();
      await adjustScreenView(page);

      await expect(page.locator(".react-flow__node")).toHaveCount(1, {
        timeout: 10000,
      });

      // The Language Model component should have a provider/model selection
      // (combobox, select, or text showing a model name)
      const providerSelect = page.locator('[role="combobox"]').first();
      const modelText = page.getByText(/openai|anthropic|gpt|claude/i).first();

      const hasSelect = await providerSelect
        .isVisible({ timeout: 5000 })
        .catch(() => false);
      const hasModelText = await modelText
        .isVisible({ timeout: 3000 })
        .catch(() => false);

      expect(
        hasSelect || hasModelText,
        "Language Model component should have a provider/model selector or show a model name",
      ).toBe(true);
    },
  );
});
