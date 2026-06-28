import type { Page } from "@playwright/test";

export async function setupAnthropic(
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
    console.log("No Agent node found on canvas — skipping Anthropic setup.");
    return;
  }

  // Step 2: Open the model provider management panel
  if (hasModelDropdown) {
    await modelDropdown.click();
    await page.getByTestId("manage-model-providers").click();
  } else {
    await setupProviderBtn.click();
  }

  // Step 3: Select the Anthropic provider
  await page.getByTestId("provider-item-Anthropic").click();

  // Step 4: Configure the API key — but only if the provider is not already set up.
  // A configured provider shows a "Disconnect" button with the key field masked;
  // re-saving it would append to the masked value or hit a "Variable name already
  // exists" conflict, so in that case skip straight to model selection.
  // The config panel animates in (300ms) and requires a backend fetch after the
  // provider is selected — use waitFor (retries) instead of isVisible.
  const apiKeyInput = page.getByPlaceholder("sk-ant-...");
  await apiKeyInput.waitFor({ state: "visible", timeout: 10000 }).catch(() => {});

  const alreadyConfigured = await page
    .getByRole("button", { name: "Disconnect", exact: true })
    .isVisible({ timeout: 1000 })
    .catch(() => false);

  if (!alreadyConfigured && (await apiKeyInput.count()) > 0) {
    await apiKeyInput.fill(process.env.ANTHROPIC_API_KEY ?? "");
    await page.getByRole("button", { name: /Save|Replace|Retry/i }).click();
    // Provider validation can take tens of seconds — wait for the configured
    // state (Disconnect button) so the model toggles have rendered before Step 5.
    await page
      .getByRole("button", { name: "Disconnect", exact: true })
      .waitFor({ state: "visible", timeout: 60000 })
      .catch(() => {});
  }

  // Step 5: Enable all available Anthropic models.
  // Toggles only render after the provider is authenticated — waitFor retries until visible.
  // The `:visible` filter excludes toggles inside the collapsed "deprecated
  // models" section, which are mounted in the DOM but not displayed until the
  // section's "Show N deprecated models" button is clicked. Without the
  // filter, `.click()` on a hidden toggle retry-loops to a timeout.
  const toggles = page.locator('[data-testid^="llm-toggle"]:visible');
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
    await page.locator('[data-testid$="-option"]', { hasText: "claude" }).first().waitFor({ state: "visible", timeout: 10000 });
    await page.locator('[data-testid$="-option"]', { hasText: "claude" }).first().click();
  }
}
