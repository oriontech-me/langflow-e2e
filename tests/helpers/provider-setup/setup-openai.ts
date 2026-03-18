import type { Page } from "@playwright/test";

export async function setupOpenAI(page: Page): Promise<void> {
  // Step 1: Check if an Agent node exists on the canvas
  const modelDropdown = page.getByTestId("model_model");

  if ((await modelDropdown.count()) === 0) {
    console.log("No Agent node found on canvas — skipping OpenAI setup.");
    return;
  }

  // Step 2: Open the model provider management panel
  await page.getByTestId("model_model").click();
  await page.getByTestId("manage-model-providers").click();

  // Step 3: Select the OpenAI provider
  await page.getByTestId("provider-item-OpenAI").click();

  // Step 4: Save the API key if not already configured
  const saveConfigBtn = page.getByRole("button", { name: "Save Configuration" });

  if ((await saveConfigBtn.count()) > 0) {
    await page.getByPlaceholder("sk-...").fill(process.env.OPENAI_API_KEY ?? "");
    await saveConfigBtn.click();
  }

  // Step 5: Enable all available OpenAI models
  const toggles = page.locator('[data-testid^="llm-toggle"]');
  const toggleCount = await toggles.count();

  for (let i = 0; i < toggleCount; i++) {
    const toggle = toggles.nth(i);
    const isChecked = (await toggle.getAttribute("aria-checked")) === "true";
    if (!isChecked) {
      await toggle.click();
    }
  }

  // Step 6: Close the provider management panel
  await page.getByRole("button", { name: "Close" }).click();

  // Step 7: Select the first GPT model
  await page.getByTestId("model_model").click();
  await page.locator('[data-testid*="gpt"]').first().click();
}
