// Test spec that runs this helper: tests/collect-models.spec.ts
import type { Page } from "@playwright/test";
import path from "path";
import fs from "fs";
import { SettingsPage } from "../../pages/SettingsPage";
import { providerConfigMap, type Provider } from "./provider-config";
import { probeBuildAxis, type ProviderVerdict } from "./probe-component-buildable";

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
// SCOPE — this probe answers "does the KEY work", nothing more. Whether Langflow
// can actually BUILD the provider's component is the separate build axis in
// `probe-component-buildable.ts`, merged in by `collectProviders` below (#900).
const CANDIDATE_PREFS: Record<string, RegExp[]> = {
  openai: [/^gpt-4o-mini$/, /^gpt-4o$/, /^gpt-4\.1(-mini|-nano)?$/, /^gpt-4/],
  google: [
    /^gemini-2\.5-flash$/,
    /^gemini-3\.5-flash$/,
    /^gemini-flash-latest$/,
  ],
  // Haiku-first (#1171). The Anthropic entry is the one place in this map where
  // the leading model is chosen for PRICE rather than only for agent
  // compatibility, so the reasoning is worth stating: `claude-haiku-4-5` is
  // $1/$5 per MTok against `claude-sonnet-5` at $2/$10 (introductory, through
  // 2026-08-31) and $3/$15 after — 2x today, 3x from September. After #1185's
  // weekday rotation, Anthropic runs twice a week but carries ~87% of the
  // daily's remaining agentic spend, because it is ~13x the openai target's
  // price. That makes this the dominant cost lever left on the lane.
  //
  // Sonnet stays at the tail, and that matters: without it a catalog with no
  // haiku falls through to raw catalog order, which currently leads with
  // `claude-opus-5` — the most expensive model Anthropic exposes here. The
  // generic /haiku/ after the exact id is future-proofing for a later
  // `claude-haiku-5`.
  //
  // NOT extended to the other two providers, deliberately. openai's cheaper
  // catalog entries (`gpt-5-nano`, `gpt-5.4-mini`, …) are reasoning models,
  // which hang the playground for 120 s (#569) — the gpt-4-family list below is
  // that constraint, not an oversight. google's entries are already the flash
  // tier.
  anthropic: [/^claude-haiku-4-5$/, /haiku/, /^claude-sonnet-5$/, /sonnet/],
};

/** Exported for `collect-models.test.ts`: the ordering is the whole of what a
 *  unit test can prove here (agent compatibility needs a real run — #570), so
 *  it is pinned rather than left to inspection. */
export function rankCandidates(provider: string, candidates: string[]): string[] {
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
// Stop probing once the SAME error repeats this many times in a row (#1011).
//
// A model-scoped failure names the model it is about — "models/gemini-3-pro is
// not found for API version v1beta" — so consecutive candidates produce
// DIFFERENT messages. An account-scoped failure (spend cap, drained credit,
// exhausted quota, dead key) is byte-identical for every candidate, because the
// request never reached a model at all. Byte-equality of the error is therefore
// the discriminator, with no per-provider pattern list to keep in sync and no
// risk of misreading a model-level 404 as an account problem — with one
// exception, the transport failures listed in TRANSIENT_TRANSPORT below.
//
// Why it matters: on 2026-07-28 Google's key had exceeded its monthly spend cap
// and Anthropic's balance was drained, so the loop probed all 36 + 13 candidates
// to learn what candidate #1 already said — three times over, because the step
// retried. That sustained load wedged the daily's single Langflow and cost the
// entire run (#1007). It also FIXED the wrong error: the aggregate kept only the
// LAST candidate's message, which happened to be a model-level 404, so Google
// was classified a hard key/config failure instead of the transient billing
// outage it was (#955's downgrade never fired). Stopping on the repeat records
// the real reason.
//
// Three, not two: #570's case — a single gated/preview LEAD model — must still
// fall through to the models that do work.
const IDENTICAL_ERROR_LIMIT = 3;

// ONE class of identical error is exempt from the early exit: a transport
// failure. The validators' catch branch reports `e.message`, so a runner-side
// network hiccup yields "fetch failed" — byte-identical for every candidate
// (it never reaches the provider, let alone a model) while being neither
// model-scoped NOR account-scoped, just transient. Counting it would turn a
// blip that the full sweep used to ride out on candidate #4 into an `inactive`
// provider with a non-billing error, i.e. a HARD failure of collect-models
// plus the silent skips #570 exists to prevent. Cheap to exclude: a transport
// error costs a connection attempt, not a wedge, so probing on is safe.
const TRANSIENT_TRANSPORT = /fetch failed|network|terminated|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up/i;

// Representative error for a provider that exhausted every candidate. NOT the
// last one (#1011): on 2026-07-28 Google's trailing candidate was a model-level
// 404, so the aggregate reported key rot and #955's billing downgrade never
// fired. Frequency is the right pick because it carries the same signal the
// early exit does — a model-scoped message names its model and therefore occurs
// ONCE, while an account-scoped one repeats for every candidate. Insertion
// order breaks ties (strict `>`), so the earliest-seen error wins.
function mostCommonError(counts: Map<string, number>): { error: string; count: number } {
  let error = "unknown error";
  let count = 0;
  for (const [message, n] of counts) {
    if (n > count) {
      error = message;
      count = n;
    }
  }
  return { error, count };
}

export async function validateProviderWithFallback(
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
  const errorCounts = new Map<string, number>();
  let last: ProviderRecord | null = null;
  let repeats = 0;
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
    const message = result.error ?? "no error message recorded";
    errorCounts.set(message, (errorCounts.get(message) ?? 0) + 1);
    // A transport failure repeats identically without meaning the account is
    // done — see TRANSIENT_TRANSPORT. Resetting the streak (rather than holding
    // it) is the conservative side: it probes more, never less.
    repeats =
      last && result.error === last.error && !TRANSIENT_TRANSPORT.test(message) ? repeats + 1 : 1;
    tried.push(model);
    last = result;

    // The same message this many times in a row means it does not depend on the
    // model, so no remaining candidate can pass — see IDENTICAL_ERROR_LIMIT.
    if (repeats >= IDENTICAL_ERROR_LIMIT) {
      console.log(
        `   ${provider}: stopping after ${tried.length}/${candidates.length} candidate(s) — the same ` +
          `model-independent error repeated ${repeats}x, so the remaining ${candidates.length - tried.length} cannot pass.`,
      );
      return {
        ...last,
        error:
          `${tried.length} of ${candidates.length} candidate model(s) failed validation with the SAME ` +
          `model-independent error — stopped early (tried: ${tried.join(", ")}); last error: ${last.error}`,
      };
    }
  }

  const common = mostCommonError(errorCounts);
  return {
    ...(last as ProviderRecord),
    error:
      `all ${tried.length} candidate model(s) failed validation (tried: ${tried.join(", ")}); ` +
      `most common error (${common.count}/${tried.length}): ${common.error}`,
  };
}

// A provider is usable only when BOTH axes pass, and they fail independently:
// the key axis asks whether the provider's cloud API accepts the key, the build
// axis whether THIS Langflow image can instantiate the component. A build-axis
// failure overrides an `active` key verdict — a working key on an image that
// cannot build the model is precisely the false `active` that made #898 and #907
// cost a triage cycle each. The two run concurrently: the build probe is ~9s of
// mostly-idle HTTP, and the key probe is network-bound too.
async function collectProviders(
  models: ModelRecord[],
  buildAxis: Record<string, ProviderVerdict>,
): Promise<ProviderRecord[]> {
  console.log("Validating providers via API (key axis)...");

  const results = await Promise.all([
    validateProviderWithFallback("openai", rankCandidates("openai", modelsFor(models, "openai")), validateOpenAI),
    validateProviderWithFallback("anthropic", rankCandidates("anthropic", modelsFor(models, "anthropic")), validateAnthropic),
    validateProviderWithFallback("google", rankCandidates("google", modelsFor(models, "google")), validateGoogle),
  ]);

  const merged = results.map((r) => {
    const axis = buildAxis[r.provider];
    // Only a PROVEN build failure overrides the key verdict. `unknown` (the probe
    // could not reach a verdict) must not: it says nothing about the provider, and
    // writing it as `inactive` would turn a runner-side hiccup into a hard gate
    // failure plus the silent downstream skips this mechanism exists to prevent.
    if (axis && axis.state === "failed") {
      // Recorded even when the key is fine: the specs parametrized on this
      // provider cannot run either way, and the reason must name the layer that
      // is missing rather than blaming the key.
      return { ...r, status: "inactive" as const, error: axis.reason ?? "build axis failed" };
    }
    return r;
  });

  for (const r of merged) {
    const icon = r.status === "active" ? "✅" : "❌";
    const detail = r.error ? ` — ${r.error}` : "";
    console.log(`${icon} ${r.provider} (${r.model ?? "no model"})${detail}`);
  }

  return merged;
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

  // Step 1: BUILD axis first, on a still-idle backend.
  //
  // Order is load-bearing, not cosmetic (#900). Step 2 saves three provider keys
  // through the Settings UI, and each save makes Langflow validate the provider and
  // fetch its model list — enough load on the single-worker CI backend that
  // `pr-validation.yml` carries a dedicated "Wait for the backend to recover from
  // the collect-models load" step after this spec (#922/#927/#1044). Running the
  // build probe after that load put it at the worst possible moment: on PR #1051's
  // CI run every component timed out, several on the POST that merely STARTS the
  // build, so the axis reported `unknown` for all three providers and produced no
  // signal at all. The probe needs only the component registry — not models.json,
  // not the keys — so it can and must run before that load.
  const knownProviders = Object.keys(providerConfigMap) as Provider[];
  const buildAxis = await probeBuildAxis(page.request, knownProviders);

  // Step 2: Collect models from UI via Settings
  const models = await collectModels(page);

  // Step 3: Validate the key axis and merge both verdicts
  const providers = await collectProviders(models, buildAxis);
  fs.writeFileSync(PROVIDERS_PATH, JSON.stringify(providers, null, 2), "utf-8");
  console.log(`providers.json saved with ${providers.length} providers.`);

  // Step 3: Persist models with each provider's settled model first, so
  // "one model per provider" spec parametrization targets the model that
  // actually validated.
  const ordered = promoteSettledModels(models, providers);
  fs.writeFileSync(MODELS_PATH, JSON.stringify(ordered, null, 2), "utf-8");
  console.log(`models.json saved with ${ordered.length} models.`);
}
