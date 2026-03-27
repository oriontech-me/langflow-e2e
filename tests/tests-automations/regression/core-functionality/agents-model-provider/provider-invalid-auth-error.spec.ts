import * as dotenv from "dotenv";
import path from "path";
import { expect, test } from "../../../../fixtures/fixtures";
import { SimpleAgentTemplatePage } from "../../../../pages";
import {
  hasProviderEnvKeys,
  providerEnvKeyMap,
  type Provider,
} from "../../../../helpers/provider-setup";
import { navigateSettingsPages } from "../../../../helpers/ui/go-to-settings";
import { awaitBootstrapTest } from "../../../../helpers/other/await-bootstrap-test";

if (!process.env.CI) {
  dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });
}

// ─── Auth config per provider ─────────────────────────────────────────────────
// When adding a new provider to helpers/provider-setup/index.ts, add its entry
// here as well so the invalid-auth test covers it automatically.

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
// Handles two UI states: key not yet configured ("Save Configuration" button)
// and key already configured (overwrites via the existing input).

async function configureProviderApiKey(
  page: any,
  providerTestId: string,
  keyPlaceholder: string,
  apiKey: string,
): Promise<void> {
  await navigateSettingsPages(page, "Settings", "Model Providers");
  await expect(
    page.getByTestId("settings_menu_header").last(),
  ).toContainText("Model Providers", { timeout: 5000 });

  await page.getByTestId(providerTestId).click();
  await page.waitForTimeout(500);

  const saveConfigBtn = page.getByRole("button", { name: "Save Configuration" });

  if (await saveConfigBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    // Key not configured yet — use the "Save Configuration" flow
    await page.getByPlaceholder(keyPlaceholder).fill(apiKey);
    await saveConfigBtn.click();
  } else {
    // Key already configured — overwrite via the existing input
    const keyInput = page.getByPlaceholder(keyPlaceholder);
    if (await keyInput.isVisible({ timeout: 2000 }).catch(() => false)) {
      await keyInput.fill(apiKey);
      const updateBtn = page
        .getByRole("button", { name: /Save Configuration|Update|Save/i })
        .first();
      if (await updateBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await updateBtn.click();
      }
    }
  }

  await page.waitForTimeout(500);
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

        await test.step("Autenticar e carregar página principal", async () => {
          await awaitBootstrapTest(page, { skipModal: true });
        });

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
