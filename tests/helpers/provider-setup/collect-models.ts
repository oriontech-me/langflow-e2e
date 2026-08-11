// Test spec that runs this helper: tests/collect-models.spec.ts
import type { Page } from "@playwright/test";
import path from "path";
import fs from "fs";
import { SettingsPage } from "../../pages/SettingsPage";
import { keyedProviders, keyedProviderNames, type Provider } from "./provider-config";
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

/**
 * Recorded when the panel handed the probe nothing to probe. Named so
 * `collectProviders` can recognise the state and, when the collector also
 * reported a stall, replace it with a verdict that names the right layer
 * (#1370) — a string comparison against a literal spelled twice is how that
 * link silently breaks.
 */
export const NO_MODELS_COLLECTED = "no models collected from the providers panel";

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
      error: NO_MODELS_COLLECTED,
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
  stalls: Map<string, string>,
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
    // A provider the collector never configured has NO key verdict to report:
    // `validateProviderWithFallback` was handed zero candidates and never probed
    // anything. Saying "real key/account/config problem" about it names the
    // wrong layer, which is what cost the PR lane its E2E run (#1370). Applied
    // only to that exact state — a provider that collected models despite a
    // stalled wait was genuinely probed, and its verdict stands.
    const stall = stalls.get(r.provider);
    if (stall && r.error === NO_MODELS_COLLECTED) {
      return { ...r, error: `${COLLECTOR_STALL_PREFIX}${stall}` };
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

/**
 * How long to wait for the `Save` button to become actionable (#1355).
 *
 * Sized against the validation this file already documents as the slowest
 * (~35s for Google), not against Playwright's actionability ceiling: the click
 * that used to happen here carried the default 20s, which is SHORTER than a
 * provider validation, so a save that was merely slow read as a broken button.
 *
 * Over-waiting is nearly free — the wait only costs time on a run that is
 * already headed for a red, and the alternative is the whole lane aborting.
 */
const SAVE_IDLE_TIMEOUT_MS = 60_000;
const SAVE_IDLE_POLL_MS = 250;

/**
 * Per-toggle and whole-provider ceilings for confirming a model was enabled (#1355).
 *
 * Two bounds, not one, for the reason the token-attribution sidecar gives (#1197
 * §4.4): the per-item timeout bounds ONE write and never sees the sum, so 41
 * slow-but-succeeding confirmations would spend 41 x TIMEOUT and blow the spec's
 * own 5-minute budget. The aggregate bounds that sum. Against a healthy panel a
 * confirmation costs tens of milliseconds, so neither fires.
 */
const TOGGLE_CONFIRM_TIMEOUT_MS = 5_000;
const TOGGLE_CONFIRM_BUDGET_MS = 60_000;
const TOGGLE_CONFIRM_POLL_MS = 100;

/**
 * Ceiling for the credential write a `Save` click issues (#1355, resized #1385).
 *
 * Measured, not guessed: with a funded OpenAI key, `POST /api/v1/variables/`
 * answered 201 for all three providers, but anthropic's did not return until
 * past 60s — which is exactly how long the previous version of this code spent
 * waiting on the button before giving up on a request that was merely in
 * flight. The cost grows with how many providers are already configured, so the
 * ceiling is set well clear of the worst measurement rather than just above it.
 *
 * 180 s was that clearance, and the daily has since measured past it. Every
 * anthropic credential write observed on CI since the wait existed:
 *
 * | date | shard results |
 * |---|---|
 * | 2026-08-07 (run 31163810520) | 111.1 s ✅, 176.2 s ✅, >180 s ✗, >180 s ✗ |
 * | 2026-08-10 (run 31373880200) | 105.8 s ✅, >176 s ✗, >176 s ✗, >175 s ✗ |
 *
 * So the ceiling sat in the MIDDLE of the observed distribution — the largest
 * success (176.2 s) is 2 % under it. 240 s is set past the tail instead.
 *
 * The duration is CONTENTION, not a fixed cost, and that is why raising the
 * ceiling is the right move rather than a mask: the same save measured **5.9 s**
 * locally against an idle backend with two providers already configured
 * (probe on 1.12.0.dev22, `Disconnect` 0.5 s behind the 201). The lanes run
 * `LANGFLOW_WORKERS=1`, and the openai pass that precedes this one enables 41
 * models — the write queues behind that burst.
 *
 * It is a backstop, not the mechanism: the wait ends when the response lands.
 *
 * It is also a CEILING and not a promise: what a provider actually gets is
 * whatever {@link planSaveWait} can still afford out of the sweep-wide budget
 * below.
 */
const CREDENTIAL_SAVE_TIMEOUT_MS = 240_000;

/** Ceiling for the panel reaching the configured state (`Disconnect`) after a save. */
const CONFIGURED_STATE_TIMEOUT_MS = 60_000;

/**
 * Budget shared by every post-Save wait in the sweep (#1370, resized #1385).
 *
 * The per-provider ceilings above were each sized against a measurement and
 * NONE of them against the spec's own 5-minute timeout
 * (`playwright.config.ts`), which is the only clock that can actually end the
 * run. 180 s + 60 s + 15 s is **255 s spent on one provider** out of 300 s, so a
 * single stalling provider consumed the run by arithmetic — measured on
 * run 31188034419 attempt 2, which died at exactly 5 minutes with two waits
 * completing 12 ms apart because the context had closed under them. Attempt 3
 * survived the same anthropic stall with **3 s** to spare.
 *
 * Same pair of bounds the toggle confirmation already uses
 * ({@link TOGGLE_CONFIRM_BUDGET_MS}, mirroring #1197 §4.4): a per-item timeout
 * bounds ONE wait and can never see the sum.
 *
 * #1370 sized this at 210 s = the 300 s test timeout minus a ~90 s reserve. That
 * arithmetic was right and the INPUT was wrong: 300 s is
 * `playwright.config.ts`'s default for a PRODUCT spec, and nothing about it was
 * ever derived from what this sweep costs. Against a 240 s anthropic write it
 * leaves 30 s for google — which google's `Save`-idle wait then spends before a
 * Save is ever clicked, so google is recorded as a stall having never been
 * configured. That is what turned one anthropic problem into 5 of the run's 6
 * skips across three areas on 2026-08-10, on 3 of 4 shards (#1385).
 *
 * So the pre-flight now sets its own timeout (`tests/collect-models.spec.ts`)
 * and this budget is sized from the measurements instead:
 *
 *     openai   ~5 s write      + ~10 s toggles
 *     anthropic 240 s ceiling  + 60 s configured-state
 *     google   ~19 s write     + 60 s idle (contended) + 60 s configured-state
 *     ----------------------------------------------------------------
 *     ~450 s of post-Save waits in the WORST case, ~35 s in the healthy one
 *
 * Over-sizing is nearly free — the budget is only ever spent by waits that
 * actually run, so a healthy sweep still finishes in well under a minute of it
 * and the extra clock is only consumed on a run already headed for a red.
 */
const SWEEP_SAVE_BUDGET_MS = 450_000;

/**
 * Floor kept back for each provider still to be configured.
 *
 * Without it the first stalling provider spends the entire budget and every
 * provider after it gets nothing — which is the failure this budget exists to
 * prevent, just moved one provider along.
 *
 * 30 s (#1370) was sized against ONE wait — google's credential write, measured
 * at 15.7 s. A provider's pass is three waits, and on 2026-08-10 the first of
 * them spent the whole reserve: google's `Save` sat non-actionable for the full
 * 30 s while anthropic's write was still in flight, so the reserve bought a
 * diagnostic and no configuration at all. 60 s is sized against the whole pass
 * (idle + write + configured-state) at the worst per-wait figures the daily has
 * measured for a provider that is NOT the one stalling (#1385).
 */
const SAVE_RESERVE_PER_PROVIDER_MS = 60_000;

/**
 * Cap on what the `Save`-idle wait may take out of one provider's own allowance
 * (#1385).
 *
 * The idle wait is the only one of the three that is about the PREVIOUS
 * provider: it waits for the panel to stop being busy with a write this provider
 * did not issue. Letting it draw the provider's full allowance is how google
 * reached its own Save with nothing left — the reserve protected google from
 * anthropic and then google's first wait spent it anyway.
 *
 * A half share leaves the credential write, which is the wait that actually
 * configures the provider, at least as much as the wait for someone else's.
 */
const SAVE_IDLE_SHARE_OF_REMAINING = 0.5;

/**
 * Below this, the wait is skipped instead of shortened.
 *
 * Load-bearing, not cosmetic: Playwright reads `timeout: 0` as **no timeout at
 * all**, so an exhausted budget arriving at `waitForResponse` as `0` would wait
 * forever — the exact opposite of what the budget is for. {@link planSaveWait}
 * therefore returns a discriminated "don't wait" rather than a small number, so
 * a zero can never reach Playwright by construction.
 */
const MIN_SAVE_WAIT_MS = 5_000;

/**
 * Why a wait ended without an answer — `expired` and `aborted` are NOT the same
 * observation (#1370).
 *
 * The two post-Save waits used to end in `.catch(() => null)` / `.catch(() =>
 * false)`, which made "my deadline passed" and "the page was closed under me"
 * indistinguishable. On run 31188034419 attempt 2 the test hit its own 5-minute
 * timeout and both pending waits rejected at once:
 *
 *     14:49:30.036  ⚠️ no credential write observed for provider "google" within 180s
 *     14:49:30.048  ⚠️ provider "google" never showed the configured state within 60s
 *     14:49:30.088  Error: locator.count: Target page, context or browser has been closed
 *
 * A 180 s wait and a 60 s wait, 12 ms apart, at most 15.2 s after the click.
 * Neither measured anything, and the log read as two measured negatives — which
 * is why the question "is 180 s simply too short?" was unanswerable from those
 * runs. An aborted wait is UNKNOWN, never a negative (#1012).
 */
export type WaitFailureKind = "expired" | "aborted" | "unknown";

export interface WaitFailure {
  kind: WaitFailureKind;
  /** First line of the underlying error, so an `unknown` is never anonymous. */
  detail: string;
}

/**
 * Classify why a Playwright wait rejected.
 *
 * The discriminator is measured, not assumed — both `page.waitForResponse` and
 * `locator.waitFor` behave identically:
 *
 * | ended by | `name` | message |
 * |---|---|---|
 * | context closed | `Error` | `… Target page, context or browser has been closed` |
 * | deadline | `TimeoutError` | `… Timeout 800ms exceeded …` |
 *
 * The closed-context case is tested FIRST and by message: it rejects with a
 * plain `Error`, so keying on `name` alone would file it under `unknown`.
 */
export function classifyWaitFailure(error: unknown): WaitFailure {
  const named = error as { name?: unknown; message?: unknown } | null;
  const name = typeof named?.name === "string" ? named.name : "";
  const message = typeof named?.message === "string" ? named.message : String(error ?? "");
  const detail = message.split("\n")[0]?.trim() ?? "";

  if (/target (?:page, context or browser|closed)|has been closed|test ended/i.test(message)) {
    return { kind: "aborted", detail };
  }
  if (name === "TimeoutError" || /timeout \d+\s*m?s exceeded/i.test(message)) {
    return { kind: "expired", detail };
  }
  // Neither signature matched. Reporting it as an expiry would invent a
  // measurement; reporting it as an abort would invent a cause.
  return { kind: "unknown", detail };
}

export type SaveWaitPlan =
  | { wait: true; timeoutMs: number; ceilingMs: number; shortenedByBudget: boolean }
  | { wait: false; reason: string };

/**
 * Decide what one post-Save wait may spend out of the sweep's shared budget.
 *
 * Pure, so the arithmetic that #1370 got wrong is testable without a browser.
 * The returned `timeoutMs` is never `0` — see {@link MIN_SAVE_WAIT_MS}.
 *
 * `shareOfRemaining` bounds a wait to a FRACTION of what this provider can
 * afford, on top of the reserve that protects the providers after it (#1385).
 * The reserve and the share answer different questions — "will the NEXT provider
 * have anything left" versus "will THIS provider's own remaining waits" — and
 * google needed both: the reserve gave it 30 s, and its first wait spent all of
 * it before a Save was ever clicked.
 *
 * The plan carries the ceiling it was measured against, so a caller reporting a
 * failure can say whether the wait got its full ceiling or a shortened slice of
 * it. Without that, a budget-exhausted wait prints a verdict about the panel.
 */
export function planSaveWait(options: {
  ceilingMs: number;
  remainingMs: number;
  providersLeftAfterThis: number;
  reservePerProviderMs?: number;
  minWaitMs?: number;
  shareOfRemaining?: number;
}): SaveWaitPlan {
  const reservePerProvider = options.reservePerProviderMs ?? SAVE_RESERVE_PER_PROVIDER_MS;
  const minWaitMs = options.minWaitMs ?? MIN_SAVE_WAIT_MS;
  const share = options.shareOfRemaining ?? 1;
  const reserved = Math.max(0, options.providersLeftAfterThis) * reservePerProvider;
  const affordable = options.remainingMs - reserved;
  const allowed = Math.min(options.ceilingMs, affordable, Math.floor(affordable * share));

  if (allowed < minWaitMs) {
    return {
      wait: false,
      reason:
        `the sweep's shared budget is down to ${Math.max(0, Math.round(options.remainingMs / 1000))}s ` +
        `with ${Math.max(0, options.providersLeftAfterThis)} provider(s) still to configure, so waiting ` +
        `here would leave them nothing`,
    };
  }
  return {
    wait: true,
    timeoutMs: allowed,
    ceilingMs: options.ceilingMs,
    shortenedByBudget: allowed < options.ceilingMs,
  };
}

/**
 * The three post-Save waits, each bound to its own ceiling and share (#1385).
 *
 * They exist as named functions rather than three inline `planSaveWait` calls
 * because the call site is where the fix actually lives and a `Page` is not
 * something the unit lane can drive: pinning the arithmetic alone would pin a
 * spelling, not a behaviour (#1226's lesson). With these, "the idle wait is
 * share-capped and the credential write is not" is an assertion instead of a
 * code-reading exercise, and so are the live ceilings.
 */
export function planIdleWait(remainingMs: number, providersLeftAfterThis: number): SaveWaitPlan {
  return planSaveWait({
    ceilingMs: SAVE_IDLE_TIMEOUT_MS,
    remainingMs,
    providersLeftAfterThis,
    // The one wait that is about the PREVIOUS provider — see
    // SAVE_IDLE_SHARE_OF_REMAINING.
    shareOfRemaining: SAVE_IDLE_SHARE_OF_REMAINING,
  });
}

export function planCredentialWait(remainingMs: number, providersLeftAfterThis: number): SaveWaitPlan {
  // No share: this is the wait that actually configures the provider, so it may
  // take everything the reserve leaves it.
  return planSaveWait({
    ceilingMs: CREDENTIAL_SAVE_TIMEOUT_MS,
    remainingMs,
    providersLeftAfterThis,
  });
}

export function planConfiguredWait(remainingMs: number, providersLeftAfterThis: number): SaveWaitPlan {
  return planSaveWait({
    ceilingMs: CONFIGURED_STATE_TIMEOUT_MS,
    remainingMs,
    providersLeftAfterThis,
  });
}

/** The sweep's starting budget, exported so a test asserts the live value. */
export const sweepSaveBudgetMs = SWEEP_SAVE_BUDGET_MS;

/**
 * Marks a provider the COLLECTOR never managed to configure — as opposed to one
 * whose key was probed and rejected (#1370).
 *
 * Same convention as the `build axis: ` prefix, and for the same reason: a
 * verdict has to name the layer it is about. Without it, a stalled save reached
 * `validateProviderWithFallback` with zero candidates, recorded
 * `no models collected from the providers panel`, and the spec failed it under
 * "real key/account/config problem" — for a provider whose key was never probed
 * at all and whose build axis had reported OK. The #1011 mistake in a new place.
 */
export const COLLECTOR_STALL_PREFIX = "collector stall: ";

export function isCollectorStallReason(error: string | null | undefined): boolean {
  return typeof error === "string" && error.startsWith(COLLECTOR_STALL_PREFIX);
}

/**
 * Which providers this LANE cannot run without (#1370).
 *
 * Unset — the daily, `manual.yml` and every local run — means every provider
 * whose env key is set, i.e. today's behaviour unchanged. `pr-validation.yml`
 * sets it to the one provider that lane already pins itself to
 * (`select-pr-model-target.mjs --provider openai`, #1169), because a stalled
 * anthropic there changes no spec that lane will execute and yet exits the
 * shared pre-flight non-zero, taking the PR's whole E2E run with it.
 *
 * A name that is not among the providers this run has a key for is returned as
 * `unrecognised` rather than dropped: silently requiring nothing is how a typo
 * in a workflow disables a gate for good (#1012).
 */
export function resolveRequiredProviders(
  raw: string | undefined,
  keyedAndConfigured: readonly string[],
): { required: string[]; unrecognised: string[] } {
  const listed = (raw ?? "")
    .split(/[\s,]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  if (listed.length === 0) return { required: [...keyedAndConfigured], unrecognised: [] };

  const known = new Set(keyedAndConfigured);
  return {
    required: listed.filter((entry) => known.has(entry)),
    unrecognised: listed.filter((entry) => !known.has(entry)),
  };
}

/** The `Locator` surface {@link waitForButtonIdle} reads — narrow so the unit lane can drive it with a fake. */
export interface ButtonStateLocator {
  getAttribute(name: string): Promise<string | null>;
  isEnabled(): Promise<boolean>;
}

/**
 * Wait for a model toggle to report itself enabled after a click (#1355).
 *
 * This is the serialiser. Enabling a model is a write, and the collector enables
 * every model of every provider; firing those as fast as the clicks land is what
 * queues up behind the next provider's Save. Waiting for `aria-checked="true"`
 * makes each write land before the next is issued.
 *
 * Reports rather than throws, for the same reason {@link waitForButtonIdle}
 * does: an unconfirmed toggle is worth counting, not worth failing the whole
 * pre-flight over — the model may well be enabled anyway, and the run is more
 * useful finishing.
 */
export async function waitForToggleChecked(
  toggle: Pick<ButtonStateLocator, "getAttribute">,
  options: {
    timeoutMs?: number;
    pollMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<{ checked: boolean; waitedMs: number; polls: number }> {
  const timeoutMs = options.timeoutMs ?? TOGGLE_CONFIRM_TIMEOUT_MS;
  const pollMs = options.pollMs ?? TOGGLE_CONFIRM_POLL_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  const startedAt = now();
  let polls = 0;
  do {
    polls += 1;
    if ((await toggle.getAttribute("aria-checked")) === "true") {
      return { checked: true, waitedMs: now() - startedAt, polls };
    }
    if (now() - startedAt >= timeoutMs) break;
    await sleep(pollMs);
  } while (now() - startedAt < timeoutMs);

  return { checked: false, waitedMs: now() - startedAt, polls };
}

export interface ButtonIdleVerdict {
  /** Every condition held: not busy, not aria-disabled, and enabled. */
  idle: boolean;
  ariaBusy: string | null;
  ariaDisabled: string | null;
  enabled: boolean;
  waitedMs: number;
  polls: number;
}

/**
 * Poll a button until it is genuinely actionable, and REPORT what it observed
 * either way (#1355).
 *
 * Why this exists rather than leaning on `click()`'s own actionability check:
 * the providers panel marks `Save` with `aria-busy="true" aria-disabled="true"`
 * while a save/validation is in flight — including the PREVIOUS provider's,
 * since this file walks the providers in a loop. `click()` does wait for
 * "enabled and stable", but with a ceiling shorter than the validation and,
 * when it expires, an error naming the CLICK. That sent the reader to the wrong
 * line: the button was fine, the provider before it had not settled.
 *
 * It returns a verdict instead of throwing so the caller can name the provider
 * — this function does not know which one it is looking at — and so the whole
 * decision is unit-testable without a browser.
 *
 * `enabled` is read LAST and only when the aria attributes look clean: the two
 * are different claims (`aria-disabled` is advisory markup, `isEnabled()` reads
 * the real disabled state) and a button can carry either alone.
 */
export async function waitForButtonIdle(
  button: ButtonStateLocator,
  options: {
    timeoutMs?: number;
    pollMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<ButtonIdleVerdict> {
  const timeoutMs = options.timeoutMs ?? SAVE_IDLE_TIMEOUT_MS;
  const pollMs = options.pollMs ?? SAVE_IDLE_POLL_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  const startedAt = now();
  let polls = 0;
  let ariaBusy: string | null = null;
  let ariaDisabled: string | null = null;
  let enabled = false;

  // A do/while, so a button that is already idle is answered on the first poll
  // and a zero timeout still measures once rather than reporting a state it
  // never looked at (#1012: an unobserved state is unknown, not clean).
  do {
    polls += 1;
    ariaBusy = await button.getAttribute("aria-busy");
    ariaDisabled = await button.getAttribute("aria-disabled");
    enabled = ariaBusy !== "true" && ariaDisabled !== "true" ? await button.isEnabled() : false;
    if (ariaBusy !== "true" && ariaDisabled !== "true" && enabled) {
      return { idle: true, ariaBusy, ariaDisabled, enabled, waitedMs: now() - startedAt, polls };
    }
    if (now() - startedAt >= timeoutMs) break;
    await sleep(pollMs);
  } while (now() - startedAt < timeoutMs);

  return { idle: false, ariaBusy, ariaDisabled, enabled, waitedMs: now() - startedAt, polls };
}

/** One provider's post-Save spend out of the sweep budget, in walk order. */
export interface BudgetSpend {
  provider: string;
  ms: number;
}

/**
 * What the sweep can say about the wait itself, as opposed to the button
 * (#1385). Optional so the unit lane can exercise the button-only message.
 */
export interface SaveBusyContext {
  /** What the wait was actually granted, and what it would have had unshortened. */
  grantedMs: number;
  ceilingMs: number;
  /** Budget left when the wait was planned, and who had already spent it. */
  remainingBudgetMs: number;
  spentBefore: readonly BudgetSpend[];
  /**
   * Characters in the API-key field when the wait ran. `null` when it could not
   * be read — an unread field is unknown, not empty (#1012).
   */
  keyFieldChars: number | null;
}

/**
 * The message for a `Save` that never became actionable (#1355, re-attributed
 * #1385).
 *
 * Names the provider, the attribute state observed and — the part the old
 * generic click timeout could not say — that the likely cause is the PREVIOUS
 * provider's validation, so the reader does not go looking for a broken button.
 *
 * Both of the original verdict lines were WRONG on 2026-08-10, in opposite
 * directions, and on the same sweep:
 *
 *   - The wait had been shortened to 30.0 s of its 60 s ceiling because
 *     anthropic had spent 176 s of the shared budget. Neither branch could say
 *     that, so a budget verdict was printed as a panel verdict.
 *   - Two of the three shards printed `aria-busy (absent) / aria-disabled
 *     (absent) / enabled false` and concluded "a state this helper does not
 *     model", pointing the reader at the panel markup. That state is
 *     reproducible in one step: it is the `Save` button with an EMPTY key field
 *     (measured locally on 1.12.0.dev22 — with the key typed, the same button
 *     is actionable on the first poll). The panel is fine; the key did not reach
 *     the field.
 *
 * So the budget is reported FIRST when it shortened the wait, and the key field
 * is reported whenever it was readable — a claim about markup is the last
 * resort, not the default.
 */
export function formatSaveBusyFailure(
  providerName: string,
  verdict: ButtonIdleVerdict,
  context?: SaveBusyContext,
): string {
  const busy = verdict.ariaBusy === "true";
  const lines = [
    `collect-models: the "Save" button for provider "${providerName}" never became actionable ` +
      `after ${(verdict.waitedMs / 1000).toFixed(1)}s over ${verdict.polls} poll(s).`,
    ``,
    `  aria-busy      ${verdict.ariaBusy ?? "(absent)"}`,
    `  aria-disabled  ${verdict.ariaDisabled ?? "(absent)"}`,
    `  enabled        ${verdict.enabled}`,
  ];

  if (context) {
    lines.push(
      `  key field      ${
        context.keyFieldChars === null
          ? "(unreadable — unknown, not empty)"
          : `${context.keyFieldChars} character(s)`
      }`,
    );
    lines.push(
      `  wait granted   ${(context.grantedMs / 1000).toFixed(1)}s of a ${(context.ceilingMs / 1000).toFixed(1)}s ceiling`,
    );
  }
  lines.push(``);

  // Ordered by what the evidence can actually support. A shortened wait is a
  // fact about this sweep; an empty key field is a fact about this panel; the
  // markup claim is what is left when neither applies.
  if (context && context.grantedMs < context.ceilingMs) {
    lines.push(
      `  verdict        BUDGET, not the panel — this wait was shortened to ` +
        `${(context.grantedMs / 1000).toFixed(1)}s of its\n` +
        `                 ${(context.ceilingMs / 1000).toFixed(1)}s ceiling because the sweep's shared budget was down to ` +
        `${Math.max(0, Math.round(context.remainingBudgetMs / 1000))}s.\n` +
        `                 Spent before this provider: ${formatBudgetSpend(context.spentBefore)}.\n` +
        `                 Do NOT read the attributes above as a verdict about the form (#1385).`,
    );
  } else if (context && context.keyFieldChars === 0) {
    lines.push(
      `  verdict        the API-key field is EMPTY, so "Save" is correctly disabled — this is not\n` +
        `                 a panel-markup problem and not a key problem. The key was typed before\n` +
        `                 this wait, so it did not reach the field (a re-render under load will do\n` +
        `                 it). Retype before assuming anything about the button (#1385).`,
    );
  } else if (busy) {
    lines.push(
      `  verdict        still BUSY — a save/validation is in flight. This panel is walked one\n` +
        `                 provider at a time, so the usual cause is the PREVIOUS provider's\n` +
        `                 validation not having settled, not this provider's key (#1355).`,
    );
  } else {
    // The last resort, and it must not borrow authority it does not have: the
    // "everything else was ruled out" clause is only true when a context was
    // supplied to rule things out WITH. Without one this is the #1355 message
    // unchanged, which is exactly what it is.
    const ruledOut =
      context && context.keyFieldChars !== null
        ? `not busy, not budget-limited, and the key field holds ` +
          `${context.keyFieldChars} character(s) — but not actionable either.\n` +
          `                 The form`
        : `not busy, but not actionable either — the form`;
    lines.push(
      `  verdict        ${ruledOut} is in a state this helper does not model. Check the panel\n` +
        `                 markup before assuming a key problem (#1355).`,
    );
  }

  return lines.join("\n");
}

/**
 * Render who spent the shared budget before this provider (#1385).
 *
 * Exported because it is the sentence that makes a collateral stall readable —
 * "google never got a Save" means nothing without "anthropic spent 176.0s".
 * An empty list is stated rather than rendered as an empty string: nothing spent
 * before this provider is itself a finding, since it means the budget went
 * somewhere this record does not see.
 */
export function formatBudgetSpend(spent: readonly BudgetSpend[]): string {
  if (spent.length === 0) return "nothing (this is the first provider of the sweep)";
  return spent.map((s) => `"${s.provider}" ${(s.ms / 1000).toFixed(1)}s`).join(", ");
}

/**
 * Mutable remainder of {@link SWEEP_SAVE_BUDGET_MS}, threaded through the loop.
 *
 * `spent` is the per-provider ledger (#1385). The budget alone answers "is there
 * time left"; the ledger answers "who took it", which is the whole of what makes
 * a collateral stall readable — the 2026-08-10 daily reported google as an
 * unexplained non-actionable button and never named the 176 s anthropic had
 * spent one line earlier.
 */
interface SweepBudget {
  remainingMs: number;
  spent: BudgetSpend[];
}

/** Deduct from the shared budget and record it against the provider that spent it. */
function chargeBudget(budget: SweepBudget, provider: string, ms: number): void {
  budget.remainingMs -= ms;
  const existing = budget.spent.find((entry) => entry.provider === provider);
  if (existing) existing.ms += ms;
  else budget.spent.push({ provider, ms });
}

/**
 * What one provider's pass produced: its models, and — when the collector never
 * managed to configure it — the reason, so the verdict downstream can name the
 * collector instead of blaming the key (#1370).
 */
interface ProviderCollection {
  models: ModelRecord[];
  stall: string | null;
}

async function collectModelsForProvider(
  page: Page,
  providerTestId: string,
  providerName: string,
  apiKeyPlaceholder: string,
  apiKeyEnvVar: string,
  budget: SweepBudget,
  providersLeftAfterThis: number,
): Promise<ProviderCollection> {
  let stall: string | null = null;
  // Whether a Save was actually issued. Without it the configured-state wait
  // below would run for a provider this pass never saved — burning budget the
  // remaining providers need, to answer a question nobody asked (#1370).
  let saveClicked = false;
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
      // BEFORE the click (#1355): the panel marks `Save` `aria-busy="true"
      // aria-disabled="true"` while a validation is in flight, including the
      // PREVIOUS provider's. `click()`'s own actionability wait is capped at 20s
      // — shorter than the ~35s validation named below — so a busy button
      // produced `locator.click: Timeout 20000ms exceeded` pointing at the
      // click, for a provider that was never the problem.
      //
      // This wait draws on the sweep's budget like the two below it, and it
      // REPORTS instead of throwing (#1370). Both were found the hard way, on
      // this fix's own first CI run: anthropic's write was still in flight when
      // google's turn came, google's Save never went idle inside its own fixed
      // 60s, and the throw ended the sweep — one provider's backend cost taking
      // the whole pre-flight, which is the thing this issue is about. Recording
      // it as a stall loses no signal: a stall still fails the gate on every
      // lane that requires that provider, which on the daily is all of them.
      // The idle wait is bounded by a SHARE of what this provider can afford, not
      // by the whole of it (#1385): it waits out the previous provider's write,
      // and on 2026-08-10 it spent google's entire 30 s allowance doing so, so
      // google reached its own Save with nothing left and was never configured.
      const idlePlan = planIdleWait(budget.remainingMs, providersLeftAfterThis);
      // Snapshot BEFORE the wait: the ledger and the remainder are what the
      // failure message needs to attribute a shortened wait, and both move as
      // soon as this wait is charged.
      const spentBefore = budget.spent.map((entry) => ({ ...entry }));
      const remainingBeforeIdle = budget.remainingMs;
      const idleStartedAt = Date.now();
      const verdict = idlePlan.wait
        ? await waitForButtonIdle(saveBtn, { timeoutMs: idlePlan.timeoutMs })
        : null;
      chargeBudget(budget, providerName, Date.now() - idleStartedAt);

      if (!idlePlan.wait) {
        stall = `the "Save" button was never waited on — ${idlePlan.reason}`;
        console.warn(
          `⚠️  collect-models: skipped configuring provider "${providerName}" — ${idlePlan.reason}. ` +
            `It is left unconfigured rather than clicked blind (#1370). Spent before it: ` +
            `${formatBudgetSpend(spentBefore)}.`,
        );
      } else if (verdict && !verdict.idle) {
        // Read the field the button's disabled state actually depends on. It is
        // one call, only on the failure path, and it is what separates "the
        // markup is unmodelled" from "the key never landed in the input".
        const keyFieldChars = await apiKeyInput
          .inputValue()
          .then((value) => value.length)
          .catch(() => null);
        stall = formatSaveBusyFailure(providerName, verdict, {
          grantedMs: idlePlan.timeoutMs,
          ceilingMs: idlePlan.ceilingMs,
          remainingBudgetMs: remainingBeforeIdle,
          spentBefore,
          keyFieldChars,
        });
        console.warn(`⚠️  collect-models: ${stall}`);
      }
    }

    // The save itself, issued only when the button was observed actionable.
    if (stall === null && (await saveBtn.count()) > 0) {
      // Wait for the credential WRITE itself, not for a clock (#1355).
      //
      // This is the measurement that settled it, taken locally with a funded
      // OpenAI key and every `/api/v1/variables/` response logged: all three
      // saves answer **201** — none is rejected — but anthropic's POST does not
      // come back until AFTER the 60s the previous version of this code spent
      // waiting on the button. So the request was never failing; it was in
      // flight, and the form stays busy for as long as it is. Every fixed
      // timeout here is a guess at a duration that grows with the number of
      // providers already configured.
      //
      // Registered BEFORE the click, or the response can land first and be
      // missed. Never throws: the save may still have succeeded, the
      // `Disconnect` check below is the second opinion, and this helper's job is
      // to report rather than to abort the pre-flight.
      //
      // What it may SPEND is the sweep's, not this provider's (#1370): the
      // ceiling alone let one stalling provider eat a 300 s test budget in
      // 255 s of waits.
      const plan = planCredentialWait(budget.remainingMs, providersLeftAfterThis);

      if (!plan.wait) {
        stall = `the credential write was never waited for — ${plan.reason}`;
        console.warn(
          `⚠️  collect-models: skipped waiting for provider "${providerName}"'s credential write — ` +
            `${plan.reason}. Whatever it collects below is unverified (#1370).`,
        );
        await saveBtn.click();
      } else {
        const savePending = page
          .waitForResponse(
            (r) => {
              const method = r.request().method();
              return (
                /^\/api\/v1\/variables\/?$/.test(new URL(r.url()).pathname) &&
                (method === "POST" || method === "PATCH" || method === "PUT")
              );
            },
            { timeout: plan.timeoutMs },
          )
          .then((response) => ({ response, failure: null as WaitFailure | null }))
          .catch((error: unknown) => ({ response: null, failure: classifyWaitFailure(error) }));
        const startedAt = Date.now();
        await saveBtn.click();
        const { response: saveResponse, failure } = await savePending;
        const elapsedMs = Date.now() - startedAt;
        chargeBudget(budget, providerName, elapsedMs);

        if (failure?.kind === "aborted") {
          // The wait never ran. Printing "no write observed within Ns" here is
          // what made run 31188034419 attempt 2 unreadable — two waits totalling
          // 240 s reported as measured negatives 12 ms apart, because the test
          // had already timed out and closed the context (#1370, #1012).
          stall = `the credential write was never observed — the wait was cut short (${failure.detail})`;
          console.warn(
            `⚠️  collect-models: the credential-write wait for provider "${providerName}" was CUT SHORT ` +
              `after ${(elapsedMs / 1000).toFixed(1)}s — the page or context closed under it ` +
              `(${failure.detail}). This run gives NO signal about that write; it is unknown, not absent (#1370).`,
          );
        } else if (failure?.kind === "unknown") {
          stall = `the credential write was never observed — the wait failed for an unrecognised reason (${failure.detail})`;
          console.warn(
            `⚠️  collect-models: the credential-write wait for provider "${providerName}" failed after ` +
              `${(elapsedMs / 1000).toFixed(1)}s for a reason this code does not recognise ` +
              `(${failure.detail}). Treated as no signal rather than as a measurement (#1370).`,
          );
        } else if (!saveResponse) {
          stall = `no credential write answered within ${(plan.timeoutMs / 1000).toFixed(0)}s of clicking Save`;
          console.warn(
            `⚠️  collect-models: no credential write observed for provider "${providerName}" within ` +
              `${(plan.timeoutMs / 1000).toFixed(0)}s of clicking Save. The panel stays busy while a write is ` +
              `in flight, so the NEXT provider is what pays for this (#1355).`,
          );
        } else if (!saveResponse.ok()) {
          stall = `the credential write answered HTTP ${saveResponse.status()}`;
          console.warn(
            `⚠️  collect-models: the credential write for provider "${providerName}" answered ` +
              `HTTP ${saveResponse.status()} after ${(elapsedMs / 1000).toFixed(1)}s. Its models will not ` +
              `collect (#1355).`,
          );
        } else if (elapsedMs > 10_000) {
          // Not a failure — a trend. The save cost grows with how many providers
          // are already configured, and this line is what makes that visible
          // before it crosses the ceiling again.
          console.log(
            `   collect-models: provider "${providerName}" credential write took ` +
              `${(elapsedMs / 1000).toFixed(1)}s (HTTP ${saveResponse.status()}), leaving ` +
              `${Math.max(0, Math.round(budget.remainingMs / 1000))}s of the sweep's shared budget.`,
          );
        }
      }
      saveClicked = true;
    }

    // Provider validation can take ~35s (Google) — wait for the configured state
    // (Disconnect button) rather than a fixed shorter timeout that would expire mid-validation.
    //
    // The outcome is READ now instead of being swallowed (#1355). A save that
    // never reaches the configured state is why the next steps collect zero
    // models, and `.catch(() => {})` made "never configured" and "configured
    // fine" the same observation — so the empty collection downstream looked
    // like a provider with no models rather than a save that did not land.
    // Bounded by the same shared budget as the write above (#1370). It is the
    // second half of the 255 s a single stalling provider used to spend.
    const configuredPlan: SaveWaitPlan = saveClicked
      ? planConfiguredWait(budget.remainingMs, providersLeftAfterThis)
      : { wait: false, reason: "no Save was issued for this provider" };

    if (!configuredPlan.wait) {
      stall ??= `the configured state was never waited for — ${configuredPlan.reason}`;
      console.warn(
        `⚠️  collect-models: skipped waiting for provider "${providerName}" to reach the configured ` +
          `state ("Disconnect") — ${configuredPlan.reason}. Whatever it collects below is unverified (#1370).`,
      );
    } else {
      const configuredAt = Date.now();
      const configured = await page
        .getByRole("button", { name: "Disconnect", exact: true })
        .waitFor({ state: "visible", timeout: configuredPlan.timeoutMs })
        .then(() => ({ ok: true, failure: null as WaitFailure | null }))
        .catch((error: unknown) => ({ ok: false, failure: classifyWaitFailure(error) }));
      chargeBudget(budget, providerName, Date.now() - configuredAt);

      if (!configured.ok && configured.failure?.kind !== "expired") {
        // `aborted` and `unknown` are both "no signal", but they are not the
        // same claim and the warning must not pick one for the reader: an
        // aborted wait names the page closing, an unknown one names nothing at
        // all. Saying "cut short" about an unrecognised error would invent the
        // cause, which is the mirror of the defect this whole branch exists for.
        const observed =
          configured.failure?.kind === "aborted"
            ? "was CUT SHORT — the page or context closed under it"
            : "failed for a reason this code does not recognise";
        const detail = configured.failure?.detail ?? "no detail";
        stall ??= `the configured state was never observed — the wait ${
          configured.failure?.kind === "aborted" ? "was cut short" : "failed unrecognisably"
        } (${detail})`;
        console.warn(
          `⚠️  collect-models: the configured-state wait for provider "${providerName}" ${observed} ` +
            `(${detail}). This run gives NO signal about whether the save landed; it is unknown, not a ` +
            `failed save (#1370).`,
        );
      } else if (!configured.ok) {
        stall ??= `the panel never reached the configured state ("Disconnect") within ${(configuredPlan.timeoutMs / 1000).toFixed(0)}s of Save`;
        console.warn(
          `⚠️  collect-models: provider "${providerName}" never showed the configured state ` +
            `("Disconnect") within ${(configuredPlan.timeoutMs / 1000).toFixed(0)}s of Save. Whatever this ` +
            `run collects for it is suspect — an empty model list below is that, not a provider without ` +
            `models (#1355).`,
        );
      } else {
        // The save landed after all, so nothing the waits above recorded is a
        // stall any more. Leaving it set would report a configured provider as
        // one the collector never reached.
        stall = null;
      }
    }
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

  // Each enable is a WRITE, and this loop used to fire them as fast as the clicks
  // land. Confirming each one before moving on serialises them.
  //
  // Honest about what this is worth: it was added believing these 41 writes were
  // what wedged the next provider's Save, and the very next CI run REFUTED that —
  // the failure was byte-identical with the serialisation in place. The measured
  // cause is the credential write above, which stays in flight past 60s. This is
  // kept because a burst of 41 unconfirmed writes against a backend the lanes run
  // with `LANGFLOW_WORKERS=1` is worth avoiding on its own and costs nothing
  // measurable (23.9s against 24.9s locally) — not because it fixed anything.
  //
  // The pair of bounds mirrors the token-attribution sidecar (#1197 §4.4): a
  // per-toggle timeout bounds ONE write, and an aggregate budget bounds the sum —
  // a per-item timeout alone would let 41 slow-but-succeeding writes spend
  // 41 x TIMEOUT and blow the spec's own 5-minute budget.
  //
  // Past the budget the clicks CONTINUE unconfirmed: enabling a model is still
  // worth attempting, and the count of unconfirmed ones is reported below rather
  // than silently dropped (#1012).
  let unconfirmed = 0;
  let confirmBudgetLeft = TOGGLE_CONFIRM_BUDGET_MS;
  for (let i = 0; i < toggleCount; i++) {
    const toggle = toggles.nth(i);
    const modelName = await toggle.locator("..").locator("span.text-sm").textContent();
    if (modelName?.trim()) {
      models.push({ provider: providerName, model: modelName.trim() });
    }
    const isChecked = (await toggle.getAttribute("aria-checked")) === "true";
    if (!isChecked) {
      await toggle.click();
      if (confirmBudgetLeft > 0) {
        const confirm = await waitForToggleChecked(toggle, {
          timeoutMs: Math.min(TOGGLE_CONFIRM_TIMEOUT_MS, confirmBudgetLeft),
        });
        confirmBudgetLeft -= confirm.waitedMs;
        if (!confirm.checked) unconfirmed += 1;
      } else {
        unconfirmed += 1;
      }
    }
  }

  if (unconfirmed > 0) {
    console.warn(
      `⚠️  collect-models: ${unconfirmed} of ${toggleCount} model toggle(s) for provider ` +
        `"${providerName}" were clicked but never confirmed enabled within the budget. The panel ` +
        `is slow or wedged, and the NEXT provider's Save is what pays for it (#1355).`,
    );
  }

  console.log(`Models found (${providerName}):`, models.map((m) => m.model));

  // An empty collection for a provider whose key IS set is a failure, and it used
  // to print exactly like a healthy result (#1355). It is also the state that
  // produces the SILENT daily: `Collect models` is `continue-on-error` there
  // (#980), so a `models.json` missing this provider makes `resolveTestTargets()`
  // resolve nothing and every parametrized spec skip — green by absence, the
  // #570/#1012 trap. Warn rather than throw: the run is more useful finishing with
  // the providers it did collect, and the PR lane fails on the Save above anyway.
  if (apiKey && models.length === 0) {
    console.warn(
      `⚠️  collect-models: provider "${providerName}" has a key configured but collected ZERO models. ` +
        `Its parametrized specs will SKIP wherever this models.json is used — a green run after this ` +
        `line tested nothing for it (#1355).`,
    );
  }

  await page.getByTestId("sidebar-nav-Model Providers").click();

  return { models, stall };
}

async function collectModels(page: Page): Promise<{
  models: ModelRecord[];
  stalls: Map<string, string>;
}> {
  const settingsPage = new SettingsPage(page);
  await settingsPage.navigate();
  await page.getByTestId("sidebar-nav-Model Providers").click();

  const allModels: ModelRecord[] = [];
  const stalls = new Map<string, string>();

  // One budget for the whole sweep, spent down as each provider's post-Save
  // waits actually run (#1370), with a per-provider ledger so a collateral stall
  // can name who spent it (#1385).
  const budget: SweepBudget = { remainingMs: SWEEP_SAVE_BUDGET_MS, spent: [] };
  const providers = [...keyedProviders];

  // Keyed providers only. This sweep SAVES an API key per provider through the
  // Settings UI, so a keyless one (Ollama, #1187) has nothing for it to do here —
  // and its model list is the live instance's, not a catalog to collect.
  for (const [index, [provider, config]] of providers.entries()) {
    const collection = await collectModelsForProvider(
      page,
      config.providerTestId,
      provider,
      config.keyPlaceholder,
      config.envKeys[0],
      budget,
      providers.length - 1 - index,
    );
    allModels.push(...collection.models);
    if (collection.stall) stalls.set(provider, collection.stall);
  }

  // Printed on EVERY sweep, not only a failing one (#1385). The budget is the
  // mechanism that decides whether a provider gets configured at all, and it was
  // invisible until it had already cost one: a healthy line here is what makes a
  // creeping write cost readable before it crosses the ceiling.
  console.log(
    `   collect-models: post-Save waits spent ` +
      `${Math.round((SWEEP_SAVE_BUDGET_MS - budget.remainingMs) / 1000)}s of the sweep's ` +
      `${Math.round(SWEEP_SAVE_BUDGET_MS / 1000)}s shared budget — ${formatBudgetSpend(budget.spent)}.`,
  );

  return { models: allModels, stalls };
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
  const buildAxis = await probeBuildAxis(page.request, keyedProviderNames);

  // Step 2: Collect models from UI via Settings
  const { models, stalls } = await collectModels(page);

  // Step 3: Validate the key axis and merge both verdicts
  const providers = await collectProviders(models, buildAxis, stalls);
  fs.writeFileSync(PROVIDERS_PATH, JSON.stringify(providers, null, 2), "utf-8");
  console.log(`providers.json saved with ${providers.length} providers.`);

  // Step 3: Persist models with each provider's settled model first, so
  // "one model per provider" spec parametrization targets the model that
  // actually validated.
  const ordered = promoteSettledModels(models, providers);
  fs.writeFileSync(MODELS_PATH, JSON.stringify(ordered, null, 2), "utf-8");
  console.log(`models.json saved with ${ordered.length} models.`);
}
