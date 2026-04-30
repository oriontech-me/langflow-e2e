import type { Page } from "@playwright/test";

/**
 * Configures the Language Model node via "Setup Provider" and selects gpt-4o-mini.
 *
 * The Language Model component ships unconfigured in Langflow templates; without
 * this step the flow fails with "A model selection is required".
 *
 * Requires OPENAI_API_KEY in the environment — guard the test with
 * test.skip(!process.env.OPENAI_API_KEY) before calling this helper.
 *
 * Call site must first click the Language Model node so its inline fields
 * are in the viewport before invoking this helper.
 */
export async function setupLanguageModelOpenAI(page: Page): Promise<void> {
  const modelDropdown = page.getByTestId("model_model");
  const hasModelDropdown = await modelDropdown.isVisible({ timeout: 5000 }).catch(() => false);

  if (!hasModelDropdown) {
    // "Setup Provider" opens the provider modal (no data-testid on this button)
    await page.getByRole("button", { name: "Setup Provider" }).click();
    await page.waitForSelector('[data-testid="provider-item-OpenAI"]', { timeout: 10000 });
    await page.getByTestId("provider-item-OpenAI").click();

    const apiKeyInput = page.getByPlaceholder("sk-...");
    // Wait for the form panel to animate in before checking visibility
    await apiKeyInput.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});

    const apiKey = process.env.OPENAI_API_KEY ?? "";
    if ((await apiKeyInput.count()) > 0 && apiKey) {
      await apiKeyInput.click();
      await apiKeyInput.pressSequentially(apiKey, { delay: 0 });

      const saveBtn = page.getByRole("button", { name: "Save", exact: true });
      const replaceBtn = page.getByRole("button", { name: "Replace", exact: true });

      if ((await saveBtn.count()) > 0) {
        await saveBtn.click();
      } else if ((await replaceBtn.count()) > 0) {
        await replaceBtn.click();
      }

      // After save the button becomes "Replace" — wait for that to confirm save completed
      await replaceBtn.waitFor({ state: "visible", timeout: 30000 });
      // Wait for model toggles to load
      await page.locator('[data-testid^="llm-toggle"]').first()
        .waitFor({ state: "visible", timeout: 15000 })
        .catch(() => {});
    }

    // Enable any model toggles that are off
    const toggles = page.locator('[data-testid^="llm-toggle"]');
    const toggleCount = await toggles.count();
    for (let i = 0; i < toggleCount; i++) {
      if ((await toggles.nth(i).getAttribute("aria-checked")) !== "true") {
        await toggles.nth(i).click();
      }
    }

    // Escape closes the Dialog and triggers refreshAllModelInputs on the node
    await page.keyboard.press("Escape");
    await modelDropdown.waitFor({ state: "visible", timeout: 30000 });
  }

  await modelDropdown.click();
  await page
    .locator('[data-testid$="-option"]', { hasText: "gpt-4o-mini" })
    .first()
    .waitFor({ state: "visible", timeout: 10000 });
  await page
    .locator('[data-testid$="-option"]', { hasText: "gpt-4o-mini" })
    .first()
    .click();
}
