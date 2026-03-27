import * as dotenv from "dotenv";
import path from "path";
import { expect, test } from "../../../../fixtures/fixtures";
import { SettingsPage } from "../../../../pages/SettingsPage";
import {
  hasProviderEnvKeys,
  providerEnvKeyMap,
  type Provider,
} from "../../../../helpers/provider-setup";

if (!process.env.CI) {
  dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });
}

// ─── Auth config per provider ─────────────────────────────────────────────────
// When adding a new provider to helpers/provider-setup/index.ts, add its entry
// here so the invalid-auth test covers it automatically.

type ProviderAuthConfig = {
  providerTestId: string;
  keyPlaceholder: string;
  invalidKey: string;
};

const providerAuthConfigMap: Record<Provider, ProviderAuthConfig> = {
  openai: {
    providerTestId: "provider-item-OpenAI",
    keyPlaceholder: "sk-...",
    invalidKey: "sk-invalid-openai-key-for-testing-12345",
  },
  anthropic: {
    providerTestId: "provider-item-Anthropic",
    keyPlaceholder: "sk-ant-...",
    invalidKey: "sk-ant-invalid-for-testing-12345",
  },
  google: {
    providerTestId: "provider-item-Google Generative AI",
    keyPlaceholder: "AIza...",
    invalidKey: "AIza-invalid-google-key-for-testing-12345",
  },
};

// ─── Target builder ───────────────────────────────────────────────────────────

type ProviderTarget = ProviderAuthConfig & {
  provider: Provider;
  primaryEnvVar: string;
};

function getProviderTargets(): ProviderTarget[] {
  return (Object.keys(providerAuthConfigMap) as Provider[])
    .filter(hasProviderEnvKeys)
    .map((provider) => ({
      provider,
      primaryEnvVar: providerEnvKeyMap[provider][0],
      ...providerAuthConfigMap[provider],
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
    await apiKeyInput.click({ clickCount: 3 });
    await apiKeyInput.pressSequentially(apiKey, { delay: 0 });

    const saveConfigBtn = page.getByRole("button", { name: "Save Configuration" });
    const replaceConfigBtn = page.getByRole("button", { name: "Replace Configuration" });

    if ((await saveConfigBtn.count()) > 0) {
      await saveConfigBtn.click();
    } else if ((await replaceConfigBtn.count()) > 0) {
      await replaceConfigBtn.click();
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
      `deve exibir mensagem de erro ao usar autenticação inválida do provider ${provider}`,
      { tag: ["@regression", "@model-provider", "@agents"] },
      async ({ page }) => {
        (page as any).allowFlowErrors();

        await page.goto("/");
        await page.waitForSelector('[data-testid="mainpage_title"]', { timeout: 30000 });

        await test.step(`Configurar autenticação inválida para ${provider}`, async () => {
          await navigateAndFillProviderApiKey(
            page,
            providerTestId,
            keyPlaceholder,
            invalidKey,
          );
        });

        try {
          await test.step("Validar que o erro de autenticação inválida é exibido", async () => {
            const errorBox = page.locator(".error-build-message");
            await expect(
              errorBox.getByText(/Invalid API key/i),
            ).toBeVisible({ timeout: 30000 });
          });
        } finally {
          await test.step(`Restaurar autenticação válida do provider ${provider}`, async () => {
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
