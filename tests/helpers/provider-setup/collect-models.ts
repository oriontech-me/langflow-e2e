// Test spec that runs this helper: tests/collect-models.spec.ts
import type { Page } from "@playwright/test";
import path from "path";
import fs from "fs";
import { SettingsPage } from "../../pages/SettingsPage";

const DATA_DIR = path.join(__dirname, "data");
const PROVIDERS_PATH = path.join(DATA_DIR, "providers.json");
const MODELS_PATH = path.join(DATA_DIR, "models.json");

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ProviderRecord {
  provider: string;
  status: "active" | "inactive";
  error: string | null;
  checkedAt: string;
}

interface ModelRecord {
  provider: string;
  model: string;
}

// ─── Provider validation (API calls) ──────────────────────────────────────────

async function validateOpenAI(): Promise<ProviderRecord> {
  const apiKey = process.env.OPENAI_API_KEY ?? "";
  const provider = "openai";

  if (!apiKey) {
    return { provider, status: "inactive", error: "OPENAI_API_KEY not set", checkedAt: new Date().toISOString() };
  }

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { provider, status: "inactive", error: (body as any)?.error?.message ?? `HTTP ${res.status}`, checkedAt: new Date().toISOString() };
    }

    return { provider, status: "active", error: null, checkedAt: new Date().toISOString() };
  } catch (e: any) {
    return { provider, status: "inactive", error: e?.message ?? "Unknown error", checkedAt: new Date().toISOString() };
  }
}

async function validateAnthropic(): Promise<ProviderRecord> {
  const apiKey = process.env.ANTHROPIC_API_KEY ?? "";
  const provider = "anthropic";

  if (!apiKey) {
    return { provider, status: "inactive", error: "ANTHROPIC_API_KEY not set", checkedAt: new Date().toISOString() };
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
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { provider, status: "inactive", error: (body as any)?.error?.message ?? `HTTP ${res.status}`, checkedAt: new Date().toISOString() };
    }

    return { provider, status: "active", error: null, checkedAt: new Date().toISOString() };
  } catch (e: any) {
    return { provider, status: "inactive", error: e?.message ?? "Unknown error", checkedAt: new Date().toISOString() };
  }
}

async function validateGoogle(): Promise<ProviderRecord> {
  const apiKey = process.env.GOOGLE_API_KEY ?? "";
  const provider = "google";

  if (!apiKey) {
    return { provider, status: "inactive", error: "GOOGLE_API_KEY not set", checkedAt: new Date().toISOString() };
  }

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
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
      return { provider, status: "inactive", error: (body as any)?.error?.message ?? `HTTP ${res.status}`, checkedAt: new Date().toISOString() };
    }

    return { provider, status: "active", error: null, checkedAt: new Date().toISOString() };
  } catch (e: any) {
    return { provider, status: "inactive", error: e?.message ?? "Unknown error", checkedAt: new Date().toISOString() };
  }
}

async function collectProviders(): Promise<ProviderRecord[]> {
  console.log("Validando provedores via API...");

  const results = await Promise.all([
    validateOpenAI(),
    validateAnthropic(),
    validateGoogle(),
  ]);

  for (const r of results) {
    const icon = r.status === "active" ? "✅" : "❌";
    const detail = r.error ? ` — ${r.error}` : "";
    console.log(`${icon} ${r.provider}${detail}`);
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

  const saveConfigBtn = page.getByRole("button", { name: "Save Configuration" });
  if ((await saveConfigBtn.count()) > 0) {
    await page.getByPlaceholder(apiKeyPlaceholder).fill(process.env[apiKeyEnvVar] ?? "");
    await saveConfigBtn.click();
  }

  const toggles = page.locator('[data-testid^="llm-toggle"]');
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

  allModels.push(...await collectModelsForProvider(page, "provider-item-Anthropic", "anthropic", "sk-ant-...", "ANTHROPIC_API_KEY"));
  allModels.push(...await collectModelsForProvider(page, "provider-item-Google Generative AI", "google", "AIza...", "GOOGLE_API_KEY"));
  allModels.push(...await collectModelsForProvider(page, "provider-item-OpenAI", "openai", "sk-...", "OPENAI_API_KEY"));

  return allModels;
}

// ─── Main export ───────────────────────────────────────────────────────────────

export async function collectAll(page: Page): Promise<void> {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  // Step 1: Validate providers via API (no browser needed)
  const providers = await collectProviders();
  fs.writeFileSync(PROVIDERS_PATH, JSON.stringify(providers, null, 2), "utf-8");
  console.log(`providers.json salvo com ${providers.length} provedores.`);

  // Step 2: Collect models from UI via Settings
  const models = await collectModels(page);
  fs.writeFileSync(MODELS_PATH, JSON.stringify(models, null, 2), "utf-8");
  console.log(`models.json salvo com ${models.length} modelos.`);
}
