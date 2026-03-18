import type { Page } from "@playwright/test";

export async function setupAnthropic(
  page: Page,
  modelTestId?: string,
): Promise<void> {
  // Step 1: Check if an Agent node exists on the canvas
  const modelDropdown = page.getByTestId("model_model");

  if ((await modelDropdown.count()) === 0) {
    console.log("No Agent node found on canvas — skipping Anthropic setup.");
    return;
  }

  // Step 2: Open the model provider management panel
  await page.getByTestId("model_model").click();
  await page.getByTestId("manage-model-providers").click();

  // Step 3: Select the Anthropic provider
  await page.getByTestId("provider-item-Anthropic").click();

  // Step 4: Save the API key if not already configured
  const saveConfigBtn = page.getByRole("button", { name: "Save Configuration" });

  if ((await saveConfigBtn.count()) > 0) {
    await page.getByPlaceholder("sk-ant-...").fill(process.env.ANTHROPIC_API_KEY ?? "");
    await saveConfigBtn.click();
  }

  // Step 5: Enable all available Anthropic models
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

  // Step 7: Select model — uses modelTestId if provided, otherwise selects the first available
  await page.getByTestId("model_model").click();
  if (modelTestId) {
    const modelOption = page.locator(`[data-testid="${modelTestId}"]`);
    const isAvailable = await modelOption.isVisible({ timeout: 10000 }).catch(() => false);
    if (!isAvailable) {
      await page.keyboard.press("Escape");
      throw new Error(`MODEL_NOT_AVAILABLE: "${modelTestId}" not found in dropdown — model may not be supported.`);
    }
    await modelOption.click();
  } else {
    await page.locator('[data-testid*="claude"]').first().waitFor({ state: "visible", timeout: 10000 });
    await page.locator('[data-testid*="claude"]').first().click();
  }
}
