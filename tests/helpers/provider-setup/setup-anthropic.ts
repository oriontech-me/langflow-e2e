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

  // Step 4: Save the API key if the config panel is visible.
  // The config panel animates in (300ms) and requires a backend fetch after the provider
  // is selected — use waitFor (retries) instead of isVisible (immediate snapshot).
  // The save button was renamed from "Save Configuration" to "Save" / "Replace" / "Retry".
  const apiKeyInput = page.getByPlaceholder("sk-ant-...");
  const apiKeyInputVisible = await apiKeyInput
    .waitFor({ state: "visible", timeout: 10000 })
    .then(() => true)
    .catch(() => false);

  if (apiKeyInputVisible) {
    await apiKeyInput.fill(process.env.ANTHROPIC_API_KEY ?? "");
    await page.getByRole("button", { name: /Save|Replace|Retry/i }).click();
  }

  // Step 5: Enable all available Anthropic models.
  // Toggles only render after the provider is authenticated — waitFor retries until visible.
  // Re-query unchecked toggles each iteration: clicking a toggle can re-render the
  // list (Langflow re-fetches model availability), invalidating index-based access.
  await page
    .locator('[data-testid^="llm-toggle"]')
    .first()
    .waitFor({ state: "visible", timeout: 15000 })
    .catch(() => {});

  const unchecked = page.locator(
    '[data-testid^="llm-toggle"][aria-checked="false"]',
  );
  const maxIterations = 50;
  for (let i = 0; i < maxIterations; i++) {
    if ((await unchecked.count()) === 0) break;
    const next = unchecked.first();
    await next.scrollIntoViewIfNeeded();
    await next.click({ force: true });
    // Brief settle for the React re-render: querying `unchecked` again
    // immediately after click can race with state update. If a click silently
    // fails to flip, the next iteration retries the same toggle naturally
    // (re-query + first()), bounded by maxIterations.
    await page.waitForTimeout(200);
  }

  // Step 6: Close the provider management panel
  await page.getByRole("button", { name: "Close" }).click();

  // Step 7: Select model — uses modelTestId if provided, otherwise selects the first available
  await page.getByTestId("model_model").click();
  if (modelTestId) {
    const escapedId = modelTestId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const modelOption = page.locator('[data-testid$="-option"]', { hasText: new RegExp(`^${escapedId}$`) });
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
