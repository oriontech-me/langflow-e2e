import * as dotenv from "dotenv";
import path from "path";
import { expect, test } from "../../../../fixtures/fixtures";
import { SimpleAgentTemplatePage } from "../../../../pages";
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
  errorPattern: RegExp;
};

const providerAuthConfigMap: Record<Provider, ProviderAuthConfig> = {
  openai: {
    providerTestId: "provider-item-OpenAI",
    keyPlaceholder: "sk-...",
    invalidKey: "sk-invalid-openai-key-for-testing-12345",
    errorPattern: /Invalid API key/i,
  },
  anthropic: {
    providerTestId: "provider-item-Anthropic",
    keyPlaceholder: "sk-ant-...",
    invalidKey: "sk-ant-invalid-for-testing-12345",
    errorPattern: /Invalid API key|authentication_error|invalid.*key/i,
  },
  google: {
    providerTestId: "provider-item-Google Generative AI",
    keyPlaceholder: "AIza...",
    invalidKey: "AIza-invalid-google-key-for-testing-12345",
    errorPattern: /Invalid API key|API key not valid|invalid.*key/i,
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

// ─── Helper: configure API key via Settings > Model Providers ─────────────────
// Follows the same setup pattern as collect-models.ts:
//   - SettingsPage.navigate() + sidebar-nav-Model Providers
//   - click input + pressSequentially (simulates real keypresses)
//   - handles "Save Configuration" (new key) and "Replace Configuration" (existing key)
//   - waits for "Replace Configuration" to confirm the key was persisted

async function configureProviderApiKey(
  page: any,
  providerTestId: string,
  keyPlaceholder: string,
  apiKey: string,
): Promise<void> {
  const settingsPage = new SettingsPage(page);
  await settingsPage.navigate();
  await page.getByTestId("sidebar-nav-Model Providers").click();

  await page.getByTestId(providerTestId).click();

  const apiKeyInput = page.getByPlaceholder(keyPlaceholder);
  if ((await apiKeyInput.count()) > 0) {
    await apiKeyInput.click();
    await apiKeyInput.pressSequentially(apiKey, { delay: 0 });

    const saveConfigBtn = page.getByRole("button", { name: "Save Configuration" });
    const replaceConfigBtn = page.getByRole("button", { name: "Replace Configuration" });

    if ((await saveConfigBtn.count()) > 0) {
      await saveConfigBtn.click();
    } else if ((await replaceConfigBtn.count()) > 0) {
      await replaceConfigBtn.click();
    }

    await replaceConfigBtn.waitFor({ state: "visible" });
  }

  await page.getByTestId("sidebar-nav-Model Providers").click();

  await page.goto("/");
  await page.waitForSelector('[data-testid="mainpage_title"]', {
    timeout: 15000,
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

const targets = getProviderTargets();

for (const {
  provider,
  primaryEnvVar,
  providerTestId,
  keyPlaceholder,
  invalidKey,
  errorPattern,
} of targets) {
  test.describe.serial(`Invalid Auth Error — ${provider}`, () => {
    test(
      `deve exibir mensagem de erro ao usar autenticação inválida do provider ${provider}`,
      { tag: ["@regression", "@model-provider", "@agents"] },
      async ({ page }) => {
        (page as any).allowFlowErrors();

        await test.step(`Configurar autenticação inválida para ${provider}`, async () => {
          await configureProviderApiKey(
            page,
            providerTestId,
            keyPlaceholder,
            invalidKey,
          );
        });

        try {
          await test.step("Carregar Simple Agent template com o provider configurado", async () => {
            try {
              await new SimpleAgentTemplatePage(page).load({ provider });
            } catch (e: any) {
              if (e?.message?.startsWith("MODEL_NOT_AVAILABLE")) {
                test.skip(true, e.message);
              }
              throw e;
            }
          });

          await test.step("Abrir playground e enviar mensagem para acionar o erro", async () => {
            await page.getByTestId("playground-btn-flow-io").click();
            await page.waitForSelector('[data-testid="input-chat-playground"]', {
              timeout: 15000,
            });
            await page.getByTestId("input-chat-playground").last().fill("Olá");
            await page.getByTestId("button-send").last().click();
          });

          await test.step("Validar que o erro de autenticação inválida é exibido", async () => {
            const errorBox = page.locator(".error-build-message");
            await expect(
              errorBox.getByText(errorPattern),
            ).toBeVisible({ timeout: 30000 });
          });
        } finally {
          await test.step(`Restaurar autenticação válida do provider ${provider}`, async () => {
            await configureProviderApiKey(
              page,
              providerTestId,
              keyPlaceholder,
              process.env[primaryEnvVar] ?? "",
            );
          });
        }
      },
    );
  });
}
