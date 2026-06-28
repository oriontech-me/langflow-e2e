// Test spec that runs this helper: tests/collect-models.spec.ts
import type { Page } from "@playwright/test";
import path from "path";
import fs from "fs";
import { SettingsPage } from "../../pages/SettingsPage";
import { providerConfigMap, type Provider } from "./provider-config";

const DATA_DIR = path.join(__dirname, "data");
const PROVIDERS_PATH = path.join(DATA_DIR, "providers.json");
const MODELS_PATH = path.join(DATA_DIR, "models.json");

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ProviderRecord {
  provider: string;
  model: string | null;
  status: "active" | "inactive";
  error: string | null;
  checkedAt: string;
}

interface ModelRecord {
  provider: string;
  model: string;
}

// ─── Provider validation (API calls) ──────────────────────────────────────────

async function validateOpenAI(model: string): Promise<ProviderRecord> {
  const apiKey = process.env.OPENAI_API_KEY ?? "";
  const provider = "openai";

  if (!apiKey) {
    return { provider, model, status: "inactive", error: "OPENAI_API_KEY not set", checkedAt: new Date().toISOString() };
  }

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { provider, model, status: "inactive", error: (body as any)?.error?.message ?? `HTTP ${res.status}`, checkedAt: new Date().toISOString() };
    }

    return { provider, model, status: "active", error: null, checkedAt: new Date().toISOString() };
  } catch (e: any) {
    return { provider, model, status: "inactive", error: e?.message ?? "Unknown error", checkedAt: new Date().toISOString() };
  }
}

async function validateAnthropic(model: string): Promise<ProviderRecord> {
  const apiKey = process.env.ANTHROPIC_API_KEY ?? "";
  const provider = "anthropic";

  if (!apiKey) {
    return { provider, model, status: "inactive", error: "ANTHROPIC_API_KEY not set", checkedAt: new Date().toISOString() };
  }

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { provider, model, status: "inactive", error: (body as any)?.error?.message ?? `HTTP ${res.status}`, checkedAt: new Date().toISOString() };
    }

    return { provider, model, status: "active", error: null, checkedAt: new Date().toISOString() };
  } catch (e: any) {
    return { provider, model, status: "inactive", error: e?.message ?? "Unknown error", checkedAt: new Date().toISOString() };
  }
}

async function validateGoogle(model: string): Promise<ProviderRecord> {
  const apiKey = process.env.GOOGLE_API_KEY ?? "";
  const provider = "google";

  if (!apiKey) {
    return { provider, model, status: "inactive", error: "GOOGLE_API_KEY not set", checkedAt: new Date().toISOString() };
  }

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: "hi" }] }],
          generationConfig: { maxOutputTokens: 1 },
        }),
      },
    );

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { provider, model, status: "inactive", error: (body as any)?.error?.message ?? `HTTP ${res.status}`, checkedAt: new Date().toISOString() };
    }

    return { provider, model, status: "active", error: null, checkedAt: new Date().toISOString() };
  } catch (e: any) {
    return { provider, model, status: "inactive", error: e?.message ?? "Unknown error", checkedAt: new Date().toISOString() };
  }
}

function firstModelFor(models: ModelRecord[], provider: string): string {
  return models.find((m) => m.provider === provider)?.model ?? "";
}

async function collectProviders(models: ModelRecord[]): Promise<ProviderRecord[]> {
  console.log("Validando provedores via API...");

  const results = await Promise.all([
    validateOpenAI(firstModelFor(models, "openai")),
    validateAnthropic(firstModelFor(models, "anthropic")),
    validateGoogle(firstModelFor(models, "google")),
  ]);

  for (const r of results) {
    const icon = r.status === "active" ? "✅" : "❌";
    const detail = r.error ? ` — ${r.error}` : "";
    console.log(`${icon} ${r.provider} (${r.model ?? "no model"})${detail}`);
  }

  return results;
}

// ─── Model collection (UI navigation) ─────────────────────────────────────────

async function collectModelsForProvider(
  page: Page,
  providerTestId: string,
  providerName: string,
  apiKeyPlaceholder: string,
  apiKeyEnvVar: string,
): Promise<ModelRecord[]> {
  await page.getByTestId(providerTestId).click();

  const apiKeyInput = page.getByPlaceholder(apiKeyPlaceholder);
  // Wait for the form panel to animate in before checking visibility
  await apiKeyInput.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});

  const apiKey = process.env[apiKeyEnvVar] ?? "";
  // Skip configuration when the provider is already set up: a configured provider
  // shows a "Disconnect" button, and re-saving it would append to the masked key
  // field or hit a "Variable name already exists" conflict.
  const alreadyConfigured = await page
    .getByRole("button", { name: "Disconnect", exact: true })
    .isVisible({ timeout: 1000 })
    .catch(() => false);

  if (!alreadyConfigured && (await apiKeyInput.count()) > 0 && apiKey) {
    await apiKeyInput.click();
    await apiKeyInput.pressSequentially(apiKey, { delay: 0 });

    const saveBtn = page.getByRole("button", { name: "Save", exact: true });
    if ((await saveBtn.count()) > 0) {
      await saveBtn.click();
    }

    // Provider validation can take ~35s (Google) — wait for the configured state
    // (Disconnect button) rather than a fixed shorter timeout that would expire mid-validation.
    await page
      .getByRole("button", { name: "Disconnect", exact: true })
      .waitFor({ state: "visible", timeout: 60000 })
      .catch(() => {});
  }

  // Wait for model toggles to load after provider is configured
  await page.locator('[data-testid^="llm-toggle"]:visible').first()
    .waitFor({ state: "visible", timeout: 15000 })
    .catch(() => {});

  // Scope to visible toggles only — the providers panel renders deprecated models
  // in DOM but collapses them under a "Show N deprecated models" button. Iterating
  // the hidden toggles makes `.click()` retry-loop until timeout (see PR #330).
  const toggles = page.locator('[data-testid^="llm-toggle"]:visible');
  const toggleCount = await toggles.count();
  const models: ModelRecord[] = [];

  for (let i = 0; i < toggleCount; i++) {
    const toggle = toggles.nth(i);
    const modelName = await toggle.locator("..").locator("span.text-sm").textContent();
    if (modelName?.trim()) {
      models.push({ provider: providerName, model: modelName.trim() });
    }
    const isChecked = (await toggle.getAttribute("aria-checked")) === "true";
    if (!isChecked) {
      await toggle.click();
    }
  }

  console.log(`Modelos encontrados (${providerName}):`, models.map((m) => m.model));

  await page.getByTestId("sidebar-nav-Model Providers").click();

  return models;
}

async function collectModels(page: Page): Promise<ModelRecord[]> {
  const settingsPage = new SettingsPage(page);
  await settingsPage.navigate();
  await page.getByTestId("sidebar-nav-Model Providers").click();

  const allModels: ModelRecord[] = [];

  for (const [provider, config] of Object.entries(providerConfigMap) as [Provider, typeof providerConfigMap[Provider]][]) {
    allModels.push(
      ...(await collectModelsForProvider(
        page,
        config.providerTestId,
        provider,
        config.keyPlaceholder,
        config.envKeys[0],
      )),
    );
  }

  return allModels;
}

// ─── Main export ───────────────────────────────────────────────────────────────

export async function collectAll(page: Page): Promise<void> {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  // Step 1: Collect models from UI via Settings
  const models = await collectModels(page);
  fs.writeFileSync(MODELS_PATH, JSON.stringify(models, null, 2), "utf-8");
  console.log(`models.json salvo com ${models.length} modelos.`);

  // Step 2: Validate providers via API using the first model of each provider
  const providers = await collectProviders(models);
  fs.writeFileSync(PROVIDERS_PATH, JSON.stringify(providers, null, 2), "utf-8");
  console.log(`providers.json salvo com ${providers.length} provedores.`);
}
