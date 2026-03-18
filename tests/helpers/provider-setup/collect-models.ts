import type { Page } from "@playwright/test";
import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

const DB_DIR = path.join(__dirname, "data");
const DB_PATH = path.join(DB_DIR, "models.db");

interface ModelRecord {
  provider: string;
  model: string;
}

function getDb(): Database.Database {
  if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true });
  }

  const db = new Database(DB_PATH);
  db.exec(`
    DROP TABLE IF EXISTS models;
    CREATE TABLE models (
      id    INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      model    TEXT NOT NULL
    )
  `);
  return db;
}

async function collectModelsForProvider(
  page: Page,
  providerTestId: string,
  providerName: string,
  apiKeyPlaceholder: string,
  apiKeyEnvVar: string,
): Promise<ModelRecord[]> {
  // Open the model dropdown and provider management panel
  await page.getByTestId("model_model").click();
  await page.getByTestId("manage-model-providers").click();

  // Select the provider
  await page.getByTestId(providerTestId).click();

  // Fill API key if Save Configuration button is visible
  const saveConfigBtn = page.getByRole("button", { name: "Save Configuration" });
  if ((await saveConfigBtn.count()) > 0) {
    await page.getByPlaceholder(apiKeyPlaceholder).fill(process.env[apiKeyEnvVar] ?? "");
    await saveConfigBtn.click();
  }

  // Collect data-testid from each toggle and enable all models
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

  // Close the provider management panel (no Step 7 — model selection not needed)
  await page.getByRole("button", { name: "Close" }).click();

  return models;
}

export async function collectAndSaveModels(page: Page): Promise<void> {
  const modelDropdown = page.getByTestId("model_model");

  if ((await modelDropdown.count()) === 0) {
    console.log("No Agent node found on canvas — skipping model collection.");
    return;
  }

  const allModels: ModelRecord[] = [];

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

  // Persist to SQLite — drops and recreates the table, then inserts fresh
  const db = getDb();

  const insert = db.prepare("INSERT INTO models (provider, model) VALUES (?, ?)");
  const insertMany = db.transaction((records: ModelRecord[]) => {
    for (const record of records) {
      insert.run(record.provider, record.model);
    }
  });

  insertMany(allModels);
  db.close();

  console.log(`Total de modelos salvos no banco: ${allModels.length}`);
}
