import type { Page } from "@playwright/test";

// Cheap, fast chat models in priority order. `gpt-4o-mini` is kept first so older
// Langflow builds still match; the `gpt-5.x` entries cover newer builds (1.11.0+)
// where `gpt-4o-mini` was dropped from the OpenAI bundle. Reasoning-/image-/audio-heavy
// models are deliberately excluded so the memory test stays fast and deterministic
// (a slow model would reintroduce the 120s-response timeout flake from issue #354).
const PREFERRED_CHAT_MODELS = [
  "gpt-4o-mini",
  "gpt-5.4-nano",
  "gpt-5-nano",
  "gpt-5.4-mini",
  "gpt-5-mini",
  "gpt-4.1-mini",
  "gpt-4o",
  "gpt-5.4",
  "gpt-5.5",
];

// Substrings marking a non-chat model (image, embeddings, audio, …) — never select these.
const NON_CHAT_MODEL = /image|embedding|audio|tts|realtime|whisper|dall-?e|moderation|transcribe/i;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Selects a usable OpenAI chat model from the already-open `model_model` dropdown.
// Resolution order: MODEL_TEST_ID env override → first available preferred model →
// first option that is not a non-chat model. Throws with the observed options if none fit.
async function selectPreferredChatModel(page: Page): Promise<void> {
  const options = page.locator('[data-testid$="-option"]');
  await options.first().waitFor({ state: "visible", timeout: 15000 });

  const labels = (await options.allInnerTexts())
    .map((label) => label.trim())
    .filter(Boolean);

  const envModel = process.env.MODEL_TEST_ID?.trim();
  const chosen =
    (envModel && labels.find((label) => label === envModel)) ||
    PREFERRED_CHAT_MODELS.find((model) => labels.includes(model)) ||
    labels.find((label) => !NON_CHAT_MODEL.test(label));

  if (!chosen) {
    await page.keyboard.press("Escape");
    throw new Error(
      `No usable OpenAI chat model found in the model dropdown. Options: ${labels.join(", ")}`,
    );
  }

  await options
    .filter({ hasText: new RegExp(`^${escapeRegExp(chosen)}$`) })
    .first()
    .click();
}

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
  await selectPreferredChatModel(page);
}
