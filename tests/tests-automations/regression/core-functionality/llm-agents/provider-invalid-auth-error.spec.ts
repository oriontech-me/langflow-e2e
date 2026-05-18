import * as dotenv from "dotenv";
import path from "path";
import { expect, test } from "../../../../fixtures/fixtures";
import { SettingsPage } from "../../../../pages/SettingsPage";
import {
  hasProviderEnvKeys,
  providerConfigMap,
  type Provider,
} from "../../../../helpers/provider-setup";

if (!process.env.CI) {
  dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });
}

// ─── Target builder ───────────────────────────────────────────────────────────
// Configuração por provider centralizada em helpers/provider-setup/provider-config.ts

type ProviderTarget = {
  provider: Provider;
  primaryEnvVar: string;
  providerTestId: string;
  keyPlaceholder: string;
  invalidKey: string;
};

function getProviderTargets(): ProviderTarget[] {
  return (Object.keys(providerConfigMap) as Provider[])
    .filter(hasProviderEnvKeys)
    .map((provider) => ({
      provider,
      primaryEnvVar: providerConfigMap[provider].envKeys[0],
      providerTestId: providerConfigMap[provider].providerTestId,
      keyPlaceholder: providerConfigMap[provider].keyPlaceholder,
      invalidKey: providerConfigMap[provider].invalidKey,
    }));
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Fills the API key input on the current provider page and clicks Save/Replace.
// Use when already on the provider configuration screen.
async function fillProviderApiKey(
  page: any,
  apiKeyPlaceholder: string,
  apiKey: string,
): Promise<void> {
  const apiKeyInput = page.getByPlaceholder(apiKeyPlaceholder);
  if ((await apiKeyInput.count()) > 0) {
    await apiKeyInput.fill(apiKey);

    const saveBtn = page.getByRole("button", { name: /^(Save|Replace|Retry Save)$|Save Configuration|Replace Configuration/i });
    if ((await saveBtn.count()) > 0) {
      await saveBtn.first().click();
    }

    // Confirm the disconnect warning dialog if it appears (shown when replacing an existing key).
    // Uses evaluate because the Save button overlaps the Confirm button in the DOM layout.
    try {
      const confirmBtn = page.getByRole("button", { name: "Confirm" });
      await confirmBtn.waitFor({ state: "visible", timeout: 5000 });
      await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll("button")).find(
          (b) => b.textContent?.trim() === "Confirm",
        );
        btn?.click();
      });
    } catch {
      // No confirmation dialog — key was saved directly
    }
  }
}

// Navigates to Settings > Model Providers > provider and fills the API key.
// Use when not yet on the provider configuration screen.
async function navigateAndFillProviderApiKey(
  page: any,
  providerTestId: string,
  apiKeyPlaceholder: string,
  apiKey: string,
): Promise<void> {
  const settingsPage = new SettingsPage(page);
  await settingsPage.navigate();

  await page.getByTestId("icon-Brain").click();
  await page.getByTestId(providerTestId).click();

  // Wait for the provider form to finish loading before filling
  await page.getByPlaceholder(apiKeyPlaceholder).waitFor({ state: "visible", timeout: 15000 });

  await fillProviderApiKey(page, apiKeyPlaceholder, apiKey);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

const targets = getProviderTargets();

for (const {
  provider,
  primaryEnvVar,
  providerTestId,
  keyPlaceholder,
  invalidKey,
} of targets) {
  test.describe.serial(`Invalid Auth Error — ${provider}`, () => {
    test(
      `should display error message when using invalid authentication for provider ${provider}`,
      { tag: ["@regression", "@model-provider", "@agents"] },
      async ({ page }) => {

        await page.goto("/");
        await page.waitForSelector('[data-testid="mainpage_title"]', { timeout: 30000 });

        await test.step(`Set invalid authentication for ${provider}`, async () => {
          await navigateAndFillProviderApiKey(
            page,
            providerTestId,
            keyPlaceholder,
            invalidKey,
          );
        });

        try {
          await test.step("Validate that the invalid authentication error is displayed", async () => {
            const errorBox = page.locator(".error-build-message");
            await expect(
              errorBox.getByText(/Invalid API key/i),
            ).toBeVisible({ timeout: 30000 });
          });
        } finally {
          await test.step(`Restore valid authentication for provider ${provider}`, async () => {
            await fillProviderApiKey(
              page,
              keyPlaceholder,
              process.env[primaryEnvVar] ?? "",
            );
          });
        }
      },
    );
  });
}
