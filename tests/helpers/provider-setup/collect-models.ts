// Test spec that runs this helper: tests/collect-models.spec.ts
import type { Page } from "@playwright/test";
import path from "path";
import fs from "fs";
import { SettingsPage } from "../../pages/SettingsPage";

const DATA_DIR = path.join(__dirname, "data");
const JSON_PATH = path.join(DATA_DIR, "models.json");

interface ModelRecord {
  provider: string;
  model: string;
}

async function collectModelsForProvider(
  page: Page,
  providerTestId: string,
  providerName: string,
  apiKeyPlaceholder: string,
  apiKeyEnvVar: string,
): Promise<ModelRecord[]> {
  // Step 1: Select the provider from the Model Providers list
  await page.getByTestId(providerTestId).click();

  // Step 2: Fill API key if Save Configuration button is visible
  const saveConfigBtn = page.getByRole("button", { name: "Save Configuration" });
  if ((await saveConfigBtn.count()) > 0) {
    await page.getByPlaceholder(apiKeyPlaceholder).fill(process.env[apiKeyEnvVar] ?? "");
    await saveConfigBtn.click();
  }

  // Step 3: Collect data-testid from each toggle and enable all models
  const toggles = page.locator('[data-testid^="llm-toggle"]');
  const toggleCount = await toggles.count();
  const models: ModelRecord[] = [];

  for (let i = 0; i < toggleCount; i++) {
    const toggle = toggles.nth(i);

    const testId = await toggle.getAttribute("data-testid");
    if (testId) {
      models.push({ provider: providerName, model: testId });
    }

    const isChecked = (await toggle.getAttribute("aria-checked")) === "true";
    if (!isChecked) {
      await toggle.click();
    }
  }

  console.log(
    `Modelos encontrados (${providerName}):`,
    models.map((m) => m.model),
  );

  // Step 4: Navigate back to the Model Providers list for the next provider
  await page.getByTestId("sidebar-nav-Model Providers").click();

  return models;
}

export async function collectAndSaveModels(page: Page): Promise<void> {
  // Step 1: Navigate to Settings via user menu
  const settingsPage = new SettingsPage(page);
  await settingsPage.navigate();

  // Step 2: Open the Model Providers section in the settings sidebar
  await page.getByTestId("sidebar-nav-Model Providers").click();

  const allModels: ModelRecord[] = [];

  // Step 3: Collect models from each provider
  const anthropicModels = await collectModelsForProvider(
    page,
    "provider-item-Anthropic",
    "anthropic",
    "sk-ant-...",
    "ANTHROPIC_API_KEY",
  );
  allModels.push(...anthropicModels);

  const googleModels = await collectModelsForProvider(
    page,
    "provider-item-Google Generative AI",
    "google",
    "AIza...",
    "GOOGLE_API_KEY",
  );
  allModels.push(...googleModels);

  const openaiModels = await collectModelsForProvider(
    page,
    "provider-item-OpenAI",
    "openai",
    "sk-...",
    "OPENAI_API_KEY",
  );
  allModels.push(...openaiModels);

  // Step 4: Persist to JSON — overwrites file with fresh data
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  fs.writeFileSync(JSON_PATH, JSON.stringify(allModels, null, 2), "utf-8");

  console.log(`Total de modelos salvos no JSON: ${allModels.length}`);
}
