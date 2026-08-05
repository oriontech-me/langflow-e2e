import type { Page } from "@playwright/test";
import { hideInspectorPanel } from "../ui/hide-inspector-panel";
import { providerAlreadyConfigured } from "./provider-config-state";

export async function setupGoogle(
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
    console.log("No Agent node found on canvas — skipping Google Generative AI setup.");
    return;
  }

  // Step 2: Open the model provider management panel
  if (hasModelDropdown) {
    // A selected node opens a right-side Inspector Panel that overlaps the
    // model dropdown on 1.11.x+ — close it so the click is not intercepted.
    await hideInspectorPanel(page);
    await modelDropdown.click();
    await page.getByTestId("manage-model-providers").click();
  } else {
    await setupProviderBtn.click();
  }

  // Step 3: Select the Google Generative AI provider
  await page.getByTestId("provider-item-Google Generative AI").click();

  // Step 4: Configure the API key — but only if the provider is not already set up.
  // A configured provider shows a "Disconnect" button with the key field masked;
  // re-saving it would append to the masked value or hit a "Variable name already
  // exists" conflict, so in that case skip straight to model selection.
  // The config panel animates in (300ms) and requires a backend fetch after the
  // provider is selected — use waitFor (retries) instead of isVisible.
  const apiKeyInput = page.getByPlaceholder("AIza...");
  await apiKeyInput.waitFor({ state: "visible", timeout: 10000 }).catch(() => {});

  // Whether the provider is ALREADY configured decides whether the key field is
  // written, and getting it wrong is expensive: filling over a configured
  // provider stores a key Langflow cannot use, and the next build fails with
  //
  //   Error calling model 'gemini-flash-latest' (INVALID_ARGUMENT): 400 …
  //   'API key not valid. Please pass a valid API key.' … API_KEY_INVALID
  //
  // which surfaces as the build observable never appearing — the recurrent
  // signature of this file on the 2026-07-09/07-14/07-15 dailies and of the
  // first attempt on 2026-08-04 (#1262). Reproduced locally: 1 failure in 7
  // runs, and the 6 clean ones all observed the provider already configured
  // with the key rendered masked.
  //
  // The old check was a 1s `isVisible` on the Disconnect button — decided while
  // the panel's own backend fetch was still in flight, so a slow fetch read as
  // "not configured". Both signals are now polled to a deadline, and a masked
  // (non-empty) key field counts as configured on its own: Langflow renders a
  // stored credential as `AIza••••…`, so a non-empty value means a credential
  // exists whether or not Disconnect has painted yet.
  const disconnectBtn = page.getByRole("button", {
    name: "Disconnect",
    exact: true,
  });
  const configuredSignal = async () =>
    providerAlreadyConfigured({
      disconnectVisible: await disconnectBtn.isVisible().catch(() => false),
      keyFieldValue: await apiKeyInput.inputValue().catch(() => ""),
    });
  // 5s, not longer: the panel's fetch resolves in well under a second, and an
  // unconfigured provider (a fresh CI container before its first setup) pays
  // this whole window on every call.
  const configuredDeadline = Date.now() + 5000;
  let alreadyConfigured = await configuredSignal();
  while (!alreadyConfigured && Date.now() < configuredDeadline) {
    await page.waitForTimeout(500);
    alreadyConfigured = await configuredSignal();
  }

  if (!alreadyConfigured && (await apiKeyInput.count()) > 0) {
    await apiKeyInput.fill(process.env.GOOGLE_API_KEY ?? "");
    await page.getByRole("button", { name: /Save|Replace|Retry/i }).click();
    // Google provider validation can take ~35s — wait for the configured state
    // (Disconnect button) so the model toggles have rendered before Step 5.
    await disconnectBtn
      .waitFor({ state: "visible", timeout: 60000 })
      .catch(() => {});
  }

  // Step 5: Enable all available Google Generative AI models.
  // Toggles only render after the provider is authenticated — waitFor retries until visible.
  // The `:visible` filter excludes toggles inside the collapsed "deprecated
  // models" section, which are mounted in the DOM but not displayed until the
  // section's "Show N deprecated models" button is clicked. Without the
  // filter, `.click()` on a hidden toggle (e.g. gemini-2.0-flash on 1.11.x)
  // retry-loops to a timeout.
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
  await hideInspectorPanel(page);
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
    await page.locator('[data-testid$="-option"]', { hasText: "gemini" }).first().waitFor({ state: "visible", timeout: 10000 });
    await page.locator('[data-testid$="-option"]', { hasText: "gemini" }).first().click();
  }
}
