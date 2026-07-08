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

// Cheap/small models to try first (fast + inexpensive validation calls).
const CHEAP_HINT = /nano|mini|flash|haiku|lite|small/i;
// Gated or non-chat models to try last: reasoning "pro" tiers, the o-series,
// codex, preview/image/embedding/audio variants. These lead the nightly provider
// panel (e.g. `gpt-5.5-pro`, `gpt-image-2`) but are commonly access-gated, so they
// must not be the sole basis for marking a provider inactive (issue #570).
const GATED_OR_NON_CHAT =
  /(^|[-\s])pro([-\s]|$)|(^|[-\s])o[1-9]([-\s]|$)|reasoning|codex|preview|image|embedding|audio|tts|realtime|vision|deep-research|moderation|transcribe/i;
// Cap the number of real validation calls per provider.
const MAX_CANDIDATES = 6;

// Ordered list of models to try when validating a provider: cheap/small first,
// then normal chat models, then gated/non-chat last — so a gated lead model does not
// disable the whole provider when an accessible model exists (issue #570).
function candidateModelsFor(models: ModelRecord[], provider: string): string[] {
  const all = models.filter((m) => m.provider === provider).map((m) => m.model);
  const cheap = all.filter((m) => CHEAP_HINT.test(m) && !GATED_OR_NON_CHAT.test(m));
  const normal = all.filter((m) => !CHEAP_HINT.test(m) && !GATED_OR_NON_CHAT.test(m));
  const gated = all.filter((m) => GATED_OR_NON_CHAT.test(m));
  return [...new Set([...cheap, ...normal, ...gated])].slice(0, MAX_CANDIDATES);
}

// Validates a provider against its candidate models in order, stopping at the first
// that succeeds. Returns that active record, or the last inactive one (with its real
// error) if none validate. Logs each attempt so CI shows what was tried and settled on.
async function validateWithCandidates(
  provider: string,
  candidates: string[],
  validateOne: (model: string) => Promise<ProviderRecord>,
): Promise<ProviderRecord> {
  let last: ProviderRecord | null = null;
  for (const model of candidates) {
    const rec = await validateOne(model);
    if (rec.status === "active") {
      console.log(`   ${provider}: settled on ${model}`);
      return rec;
    }
    console.log(`   ${provider}: ${model} unavailable — ${rec.error ?? "unknown"}`);
    last = rec;
  }
  return (
    last ?? {
      provider,
      model: null,
      status: "inactive",
      error: "no candidate models found",
      checkedAt: new Date().toISOString(),
    }
  );
}

// Reorders models.json so each active provider's *validated* model leads its group.
// getTestTargets picks the first model per provider, so without this the agent specs
// would still parametrize on the gated lead (e.g. `gpt-5.5-pro`) even though the
// provider validated on an accessible model — running (not skipping) but then failing
// on a no-access/reasoning model (issue #570). Provider grouping and intra-group order
// are otherwise preserved.
function reorderModelsByValidated(
  models: ModelRecord[],
  providers: ProviderRecord[],
): ModelRecord[] {
  const validated = new Map<string, string>();
  for (const p of providers) {
    if (p.status === "active" && p.model) validated.set(p.provider, p.model);
  }

  const byProvider = new Map<string, ModelRecord[]>();
  for (const m of models) {
    const list = byProvider.get(m.provider) ?? [];
    list.push(m);
    byProvider.set(m.provider, list);
  }

  const result: ModelRecord[] = [];
  for (const [provider, list] of byProvider) {
    const lead = validated.get(provider);
    const leadEntries = lead ? list.filter((m) => m.model === lead) : [];
    const rest = list.filter((m) => !(lead && m.model === lead));
    result.push(...leadEntries, ...rest);
  }
  return result;
}

async function collectProviders(models: ModelRecord[]): Promise<ProviderRecord[]> {
  console.log("Validando provedores via API...");

  const results = await Promise.all([
    validateWithCandidates("openai", candidateModelsFor(models, "openai"), validateOpenAI),
    validateWithCandidates("anthropic", candidateModelsFor(models, "anthropic"), validateAnthropic),
    validateWithCandidates("google", candidateModelsFor(models, "google"), validateGoogle),
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

  // Step 2: Validate providers via API, trying candidate models until one works
  // (a gated lead model must not disable the whole provider — issue #570).
  const providers = await collectProviders(models);

  // Step 3: Lead each provider's group with its validated model so getTestTargets
  // parametrizes agent specs on an accessible model, not the gated lead (issue #570).
  const orderedModels = reorderModelsByValidated(models, providers);

  fs.writeFileSync(MODELS_PATH, JSON.stringify(orderedModels, null, 2), "utf-8");
  console.log(`models.json salvo com ${orderedModels.length} modelos.`);
  fs.writeFileSync(PROVIDERS_PATH, JSON.stringify(providers, null, 2), "utf-8");
  console.log(`providers.json salvo com ${providers.length} provedores.`);
}
