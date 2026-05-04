import type { Page } from "@playwright/test";

export async function setupOpenAI(
  page: Page,
  modelTestId?: string,
): Promise<void> {
  // Step 1: Find the entry point into the provider management panel.
  // "model_model" exists only when a provider is already configured.
  // When no provider is configured yet, the field renders a plain "Setup Provider"
  // button (no data-testid) that opens the management modal directly.
  const modelDropdown = page.getByTestId("model_model");
  const setupProviderBtn = page.getByRole("button", { name: "Setup Provider" });

  const hasModelDropdown = (await modelDropdown.count()) > 0;
  const hasSetupButton = (await setupProviderBtn.count()) > 0;

  if (!hasModelDropdown && !hasSetupButton) {
    console.log("No Agent node found on canvas — skipping OpenAI setup.");
    return;
  }

  // Step 2: Open the model provider management panel
  if (hasModelDropdown) {
    await modelDropdown.click();
    await page.getByTestId("manage-model-providers").click();
  } else {
    await setupProviderBtn.click();
  }

  // Step 3: Select the OpenAI provider
  await page.getByTestId("provider-item-OpenAI").click();

  // Step 4: Save the API key if the config panel is visible.
  // The config panel animates in (300ms) and requires a backend fetch after the provider
  // is selected — use waitFor (retries) instead of isVisible (immediate snapshot).
  // The save button was renamed from "Save Configuration" to "Save" / "Replace" / "Retry".
  const apiKeyInput = page.getByPlaceholder("sk-...");
  const apiKeyInputVisible = await apiKeyInput
    .waitFor({ state: "visible", timeout: 10000 })
    .then(() => true)
    .catch(() => false);

  if (apiKeyInputVisible) {
    await apiKeyInput.fill(process.env.OPENAI_API_KEY ?? "");
    await page.getByRole("button", { name: /^(Save|Replace|Retry)$/i }).click();
  }

  // Step 5: Enable all available OpenAI models.
  // Toggles only render after the provider is authenticated — waitFor retries until visible.
  const toggles = page.locator('[data-testid^="llm-toggle"]');
  await toggles.first().waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
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
    const modelOption = page.locator('[data-testid$="-option"]', { hasText: new RegExp(`^${modelTestId}$`) });
    const isAvailable = await modelOption.isVisible({ timeout: 10000 }).catch(() => false);
    if (!isAvailable) {
      await page.keyboard.press("Escape");
      throw new Error(`MODEL_NOT_AVAILABLE: "${modelTestId}" not found in dropdown — model may not be supported.`);
    }
    await modelOption.click();
  } else {
    await page.locator('[data-testid$="-option"]', { hasText: "gpt-4o-mini" }).first().waitFor({ state: "visible", timeout: 10000 });
    await page.locator('[data-testid$="-option"]', { hasText: "gpt-4o-mini" }).first().click();
  }
}
