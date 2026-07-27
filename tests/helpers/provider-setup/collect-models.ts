// Test spec that runs this helper: tests/collect-models.spec.ts
import type { Page } from "@playwright/test";
import path from "path";
import fs from "fs";
import { SettingsPage } from "../../pages/SettingsPage";
import { providerConfigMap, type Provider } from "./provider-config";
import { probeProviderKey } from "./probe-provider-key";

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

// One probe implementation, shared with scripts/resolve-provider-keys.ts (#976).
// Before that extraction these were three near-identical fetch blocks, each
// reading its own env var — which is why a key-level fallback had nowhere to
// live. The factory keeps the (model) => ProviderRecord shape that
// validateProviderWithFallback drives, and preserves the "<ENV> not set"
// suffix its early-exit keys off.
function makeValidator(provider: Provider): (model: string) => Promise<ProviderRecord> {
  const envKey = providerConfigMap[provider].envKeys[0];

  return async (model: string): Promise<ProviderRecord> => {
    const checkedAt = new Date().toISOString();
    const apiKey = process.env[envKey] ?? "";

    if (!apiKey) {
      return { provider, model, status: "inactive", error: `${envKey} not set`, checkedAt };
    }

    const probe = await probeProviderKey(provider, apiKey, model);

    return probe.ok
      ? { provider, model, status: "active", error: null, checkedAt }
      : { provider, model, status: "inactive", error: probe.error ?? "Unknown error", checkedAt };
  };
}

function modelsFor(models: ModelRecord[], provider: string): string[] {
  return models.filter((m) => m.provider === provider).map((m) => m.model);
}

// Probe order: known agent-compatible models first, then the raw catalog.
// The raw API probe (~1-token completion) validates ACCESS, not that
// Langflow's Agent can drive the model — gpt-5.6 passes the probe but the
// Agent returns an empty reply with it on 1.11 (every downstream agent spec
// failed when it settled first, #570). The pref regexes mirror
// resolveGptModel / resolveGeminiModel, the models the agent suite already
// runs green on; the catalog order stays as the tail so a provider with
// none of the preferred models still validates on whatever it exposes.
//
// KNOWN GAP — "active" means the key works, NOT that Langflow can BUILD the
// model. The probe calls the provider's own API directly, upstream of
// Langflow, so it cannot see a missing server-side integration package. On a
// nightly that shipped without `langchain-google-genai`, google probed
// `active` here while every Google chat/embedding build inside Langflow raised
// `ImportError: Could not import '...google_generative_ai_model' ... Install
// the missing package`, surfacing downstream only as a misleading node-build
// timeout across ~17 @stable specs (agents + Google-embedding KB). Root cause
// + impact map: #898; upstream ticket: LE-1974. A faithful check would have to
// BUILD a Language Model flow per provider and inspect the error — there is no
// standalone endpoint that triggers the class import (`/api/v1/models/*`
// return static metadata only). That build-probe hardening was deferred to
// #900; this note is the trap marker for the next triager.
const CANDIDATE_PREFS: Record<string, RegExp[]> = {
  openai: [/^gpt-4o-mini$/, /^gpt-4o$/, /^gpt-4\.1(-mini|-nano)?$/, /^gpt-4/],
  google: [
    /^gemini-2\.5-flash$/,
    /^gemini-3\.5-flash$/,
    /^gemini-flash-latest$/,
  ],
  anthropic: [/^claude-sonnet-5$/, /sonnet/, /haiku/],
};

function rankCandidates(provider: string, candidates: string[]): string[] {
  const prefs = CANDIDATE_PREFS[provider] ?? [];
  const preferred: string[] = [];
  for (const pref of prefs) {
    for (const model of candidates) {
      if (pref.test(model) && !preferred.includes(model)) preferred.push(model);
    }
  }
  return [...preferred, ...candidates.filter((m) => !preferred.includes(m))];
}

// A single gated/preview lead model must not disable the whole provider
// (#570: nightly listed gpt-5.5-pro first, the CI project had no access to
// it, and 16 OpenAI-variant agent tests silently skipped). Try EVERY
// collected model in catalog order and settle on the first that validates —
// failed probes are rejected before inference (zero token cost), and only
// the single successful probe consumes ~1 token, so exhausting the catalog
// costs time (~1s per candidate, once per run), not money. "inactive" then
// genuinely means nothing the provider exposes works with this key.
async function validateProviderWithFallback(
  provider: string,
  candidates: string[],
  validate: (model: string) => Promise<ProviderRecord>,
): Promise<ProviderRecord> {
  if (candidates.length === 0) {
    return {
      provider,
      model: null,
      status: "inactive",
      error: "no models collected from the providers panel",
      checkedAt: new Date().toISOString(),
    };
  }

  const tried: string[] = [];
  let last: ProviderRecord | null = null;
  for (const model of candidates) {
    const result = await validate(model);
    if (result.status === "active") {
      if (tried.length > 0) {
        console.log(
          `   ${provider}: settled on "${model}" after skipping ${tried.length} gated/unavailable candidate(s): ${tried.join(", ")}`,
        );
      }
      return result;
    }
    // A missing key fails identically for every candidate — stop immediately.
    if (result.error?.endsWith("not set")) return result;
    console.log(`   ${provider}: candidate "${model}" failed — ${result.error}`);
    tried.push(model);
    last = result;
  }

  return {
    ...(last as ProviderRecord),
    error: `all ${tried.length} candidate model(s) failed validation (tried: ${tried.join(", ")}); last error: ${last?.error}`,
  };
}

async function collectProviders(models: ModelRecord[]): Promise<ProviderRecord[]> {
  console.log("Validating providers via API...");

  const results = await Promise.all([
    validateProviderWithFallback("openai", rankCandidates("openai", modelsFor(models, "openai")), makeValidator("openai")),
    validateProviderWithFallback("anthropic", rankCandidates("anthropic", modelsFor(models, "anthropic")), makeValidator("anthropic")),
    validateProviderWithFallback("google", rankCandidates("google", modelsFor(models, "google")), makeValidator("google")),
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

  console.log(`Models found (${providerName}):`, models.map((m) => m.model));

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

// Move each provider's settled (probe-validated) model to the front of its
// group in models.json. Spec parametrization ("one model per provider")
// takes the FIRST model per provider, so without this a provider validated
// via a fallback model would still be TESTED against its gated/unrunnable
// lead model — converting #570's silent skips into hard failures (e.g.
// google settling on gemini-3.5-flash while specs still ran
// gemini-omni-flash-preview, which only supports the Interactions API).
function promoteSettledModels(
  models: ModelRecord[],
  providers: ProviderRecord[],
): ModelRecord[] {
  const settled = new Map(
    providers
      .filter((p) => p.status === "active" && p.model)
      .map((p) => [p.provider, p.model as string]),
  );
  return [...models].sort((a, b) => {
    if (a.provider !== b.provider) return 0; // keep provider group order
    const aSettled = settled.get(a.provider) === a.model ? 0 : 1;
    const bSettled = settled.get(b.provider) === b.model ? 0 : 1;
    return aSettled - bSettled;
  });
}

export async function collectAll(page: Page): Promise<void> {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  // Step 1: Collect models from UI via Settings
  const models = await collectModels(page);

  // Step 2: Validate providers via API, falling back across candidate models
  const providers = await collectProviders(models);
  fs.writeFileSync(PROVIDERS_PATH, JSON.stringify(providers, null, 2), "utf-8");
  console.log(`providers.json saved with ${providers.length} providers.`);

  // Step 3: Persist models with each provider's settled model first, so
  // "one model per provider" spec parametrization targets the model that
  // actually validated.
  const ordered = promoteSettledModels(models, providers);
  fs.writeFileSync(MODELS_PATH, JSON.stringify(ordered, null, 2), "utf-8");
  console.log(`models.json saved with ${ordered.length} models.`);
}
