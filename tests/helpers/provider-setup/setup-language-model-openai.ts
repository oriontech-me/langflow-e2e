import type { Page } from "@playwright/test";

// Requires the Language Model node to be clicked before calling so its fields are in the viewport.
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
      if (!(await toggles.nth(i).isChecked())) {
        await toggles.nth(i).click();
      }
    }

    // Escape closes the Dialog and triggers refreshAllModelInputs on the node
    await page.keyboard.press("Escape");
    await modelDropdown.waitFor({ state: "visible", timeout: 30000 });
  }

  await modelDropdown.click();
  const gpt4oMiniOption = page
    .locator('[data-testid$="-option"]', { hasText: "gpt-4o-mini" })
    .first();
  await gpt4oMiniOption.waitFor({ state: "visible", timeout: 10000 });
  await gpt4oMiniOption.click();
}
