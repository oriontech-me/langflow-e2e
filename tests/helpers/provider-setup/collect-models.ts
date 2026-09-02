// Test spec that runs this helper: tests/collect-models.spec.ts
import type { APIRequestContext, Page } from "@playwright/test";
import path from "path";
import fs from "fs";
import { SettingsPage } from "../../pages/SettingsPage";
import {
  keyedProviders,
  keyedProviderNames,
  langflowProviderName,
  type Provider,
} from "./provider-config";
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
  /**
   * Whether `model` is ENABLED on this instance — the difference between a run
   * whose specs find their target model in the picker and one that takes the cold
   * path and has to enable it itself (#1666).
   *
   * Four states, not a boolean, because `off` and `absent` send a reader to
   * different places and collapsing them is the ambiguity #1666 had to spend an
   * investigation resolving. `unknown` is never "fine" and never a failure: the
   * provider was never probed, the enable did not answer, or the confirmation read
   * did not (#1012). `null` means there was no target to enable at all.
   *
   * Written by `ensureTargetModelsEnabled` via `targetEnablementVerdict` and read by
   * `collect-models.spec.ts`, which is what makes the cold path a recorded fact of
   * the run rather than one warning line in a job log.
   */
  targetEnablement?: TargetEnablementState | null;
  /** What was observed, for a state that is not `enabled`. */
  targetEnablementDetail?: string | null;
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
 * Ceiling for EACH `enabled_models` call that makes the run's target models usable
 * (#1666).
 *
 * Generous against the measurement, not against a hang: `POST
 * /api/v1/models/enabled_models` calls `validate_model_provider_key` once PER MODEL
 * being enabled, synchronously, inside the request — measured on an idle
 * 1.12.0.dev45 container, 0.42–1.01 s for one model against 103 s for thirty, and
 * 0.02 s to DISABLE the same thirty (no validation on that path). One target model
 * per provider is what keeps this affordable; see `ensureTargetModelsEnabled`.
 *
 * It is PER CALL, so the worst case is one write per keyed provider plus the single
 * confirmation read. That total is part of the pre-flight's non-wait reserve and is
 * asserted against the spec's own timeout in `collect-models.test.ts` — the sizing
 * invariant #1385 pinned, which a per-call ceiling can silently break.
 */
const ENABLE_TARGETS_TIMEOUT_MS = 30_000;

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
/** Exposed for the sizing invariant in `collect-models.test.ts` (#1385/#1666). */
export const enableTargetsTimeoutMs = ENABLE_TARGETS_TIMEOUT_MS;

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

/** What the server said about the models the run is going to target (#1649/#1666). */
export type ServerConfirmation =
  | { kind: "confirmed"; expected: number }
  | {
      kind: "shortfall";
      expected: number;
      enabled: number;
      /** Present in the provider's map, reported `false`. */
      off: string[];
      /** Not a key of the provider's map at all — a name/visibility mismatch. */
      absent: string[];
      message: string;
    }
  | { kind: "unavailable"; message: string };

/**
 * Confirms enablement against the SERVER, which is the only source that can.
 *
 * The panel's `aria-checked` cannot: `useModelToggleQueue` applies an optimistic
 * `setQueryData` before any request leaves the browser, so a write that never
 * landed is indistinguishable from one that did (#1649, measured on 1.12.0.dev44 —
 * all 36 clicks "confirmed" while the POST only went out at t=8132 ms).
 *
 * `off` and `absent` are separated because they have different causes and the first
 * version of this check could not tell them apart. #1666 spent an investigation on
 * exactly that ambiguity: `0 of 36 missing` reads identically whether the write was
 * lost or whether the names the sweep collected are not the keys the endpoint uses.
 * Neither counts as enabled — the endpoint lists every model of a configured,
 * policy-visible provider, so a key it does not carry is one no spec can pick — but
 * they send a reader to different places.
 *
 * `readAnswered` is a separate argument rather than inferred from `serverEnabled`
 * being undefined, because those are two different states with opposite severity: a
 * read that never answered is UNKNOWN, while an answered read that does not list the
 * provider is a DEFINITE negative (the provider is not configured, or a model
 * provider policy hides it — `provider_policy.allows()` in `api/v1/models.py`).
 * Collapsing them reported the second as "the read did not answer", which is false
 * and is the only path where a definite negative used to pass the gate.
 *
 * It is a REQUIRED argument, with no default: whichever way a default fell it would
 * make an omission silently pick a severity, and one of the two is the harsher
 * verdict on a state the caller may not have observed.
 *
 * Pure, and read ONCE by the caller — never polled: polling this endpoint while a
 * write is in flight was measured stalling a single-worker backend at 20 s.
 */
export function confirmEnabledOnServer(
  serverEnabled: Record<string, boolean> | undefined,
  expected: string[],
  readAnswered: boolean,
): ServerConfirmation {
  if (expected.length === 0) return { kind: "confirmed", expected: 0 };

  const list = (models: string[]): string =>
    `${models.slice(0, 10).join(", ")}${models.length > 10 ? ` (+${models.length - 10} more)` : ""}`;
  const coldPath =
    ` Every spec that targets one of these runs on the COLD PATH — it finds the provider on its ` +
    `MIN_DEFAULT_MODELS default and has to enable the model itself, which is the fragile path ` +
    `#1649 documents.`;

  if (!readAnswered) {
    return {
      kind: "unavailable",
      message:
        `collect-models: the enabled state of ${expected.length} model(s) could not be confirmed ` +
        `against the server — the read did not answer. Reported as UNKNOWN rather than ` +
        `confirmed: an unevaluated check is unknown, not clean (#1012/#1649).`,
    };
  }

  if (serverEnabled === undefined) {
    return {
      kind: "shortfall",
      expected: expected.length,
      enabled: 0,
      off: [],
      absent: [...expected],
      message:
        `collect-models: the server ANSWERED and does not list this provider at all, so none of its ` +
        `${expected.length} target model(s) can be enabled: ${list(expected)}. This is not a failed ` +
        `read — the provider is either unconfigured on this instance or hidden by a model-provider ` +
        `policy (\`provider_policy.allows()\`).` + coldPath,
    };
  }

  const off = expected.filter((model) => model in serverEnabled && serverEnabled[model] !== true);
  const absent = expected.filter((model) => !(model in serverEnabled));
  if (off.length === 0 && absent.length === 0) {
    return { kind: "confirmed", expected: expected.length };
  }

  const enabled = expected.length - off.length - absent.length;
  return {
    kind: "shortfall",
    expected: expected.length,
    enabled,
    off,
    absent,
    message:
      `collect-models: the server confirms only ${enabled} of ${expected.length} target model(s) as ` +
      `enabled.` +
      (off.length > 0 ? ` Listed but OFF (the enable did not take effect): ${list(off)}.` : "") +
      (absent.length > 0
        ? ` Not listed for this provider at all (a model-name/provider-key mismatch, or a model the ` +
          `catalog no longer exposes — NOT an enable that failed): ${list(absent)}.`
        : "") +
      coldPath,
  };
}

/** How the write went, as `targetEnablementVerdict` needs to weigh it. */
export interface EnableWriteOutcome {
  /** The POST answered 2xx. */
  ok: boolean;
  /** Why it did not, verbatim from the server or the transport. `null` when ok. */
  detail: string | null;
}

/**
 * One provider's target-model state, as `providers.json` records it and the
 * pre-flight gate reads it (#1666).
 *
 * `unknown` is deliberately NOT a synonym for "not enabled": it is the state in
 * which this run has no verdict, and the gate must not fail on it (#1012 —
 * reported loudly, never as clean).
 */
export type TargetEnablementState = "enabled" | "off" | "absent" | "unknown";

export interface TargetEnablement {
  state: TargetEnablementState;
  /** What was observed. Empty only for `enabled`. */
  detail: string;
}

/**
 * Combines the write's outcome with the confirmation read into ONE verdict, with
 * the WRITE taking precedence over a negative read.
 *
 * That precedence is the whole point, and getting it backwards is a false positive
 * on the lane where `Collect models` is a hard gate. Two states produce a model the
 * server reports as not enabled, and only one of them is a defect:
 *
 *   - the write answered 2xx and the model still reads off/absent — a real negative,
 *     the run IS on the cold path, and the gate should fail;
 *   - the write never answered 2xx (dropped into a wedged backend, or refused) — the
 *     read is then describing the state BEFORE an enable that never happened. On
 *     2026-09-01 the daily measured 19 outages and four `WORKER TIMEOUT` -> SIGKILL
 *     cycles, so a dropped write is the likely shape of a bad day, not an exotic
 *     one; failing on it would redden `pr-validation.yml`'s whole E2E job for a
 *     transient (#980/#1012).
 *
 * The refusal case is included in the second branch on purpose. `HTTP 400 Cannot
 * enable not supported model: o3` is a definite answer that the model can never be
 * enabled — reachable whenever the key axis settles on one of OpenAI's
 * `not_supported` entries, which render in the panel and reach `models.json` — but
 * the cause is the CANDIDATE CHOICE, not a lost enable, and reporting it as `off`
 * would print "the enable did not take effect" about a server that refused on
 * purpose. It is `unknown` carrying the server's own words, which is what a reader
 * needs, and it is warned about rather than silently tolerated.
 *
 * PURE, so both branches of the precedence are reachable from a unit test.
 */
export function targetEnablementVerdict(
  write: EnableWriteOutcome,
  confirmation: ServerConfirmation,
): TargetEnablement {
  if (confirmation.kind === "confirmed") return { state: "enabled", detail: "" };

  if (confirmation.kind === "unavailable") {
    return { state: "unknown", detail: confirmation.message };
  }

  if (!write.ok) {
    return {
      state: "unknown",
      detail:
        `the enable itself did not answer 2xx (${write.detail ?? "no detail"}), so the read below ` +
        `describes the state BEFORE it: ${confirmation.message}`,
    };
  }

  return {
    state: confirmation.off.length > 0 ? "off" : "absent",
    detail: confirmation.message,
  };
}

/**
 * Makes the models this run will actually TARGET enabled, and confirms it (#1666).
 *
 * ## Why the sweep no longer enables every model through the panel
 *
 * `collectModelsForProvider` used to click every unchecked toggle. Those writes did
 * not reach the server while the sweep was running. Every toggle feeds
 * `useModelToggleQueue`, which batches behind a 1000 ms debounce and CANCELS +
 * DISCARDS the pending batch both on its unmount cleanup ("an explicit close already
 * consumes its batch through flushPendingChanges before unmount") and on its
 * identity effect, which fires the moment the selected provider changes. The loop
 * clicks faster than the debounce, so the timer never fired mid-loop, and the sweep
 * then navigated straight to the next provider.
 *
 * Measured on a clean 1.12.0.dev45 container with every `enabled_models` call
 * logged: **74 toggles across three providers produced ZERO
 * `POST /models/enabled_models` for the whole duration of the sweep** — including
 * past the confirmation read at the end of it, which is why #1651's server read
 * reported `0 of 30` for google. Only the LAST provider's batch left at all, ~5 s
 * after the sweep had moved on, so openai's 36 and anthropic's 9 were discarded
 * outright while google's 30 landed too late for any verdict.
 *
 * Waiting for those batches to leave was tried and REJECTED on cost, not on
 * difficulty. `POST /api/v1/models/enabled_models` calls
 * `validate_model_provider_key` once per model being enabled, synchronously, inside
 * the request — and the lanes run `LANGFLOW_WORKERS=1`. Measured on an idle
 * 1.12.0.dev45 container: 30 models enabled in **103 s**, the same 30 DISABLED in
 * **0.02 s** (that path does no validation), one model in 0.42–1.01 s. Making all
 * 74 land therefore costs ~250 s of a blocked backend per sweep, twice per shard —
 * the `Collect models` wedge the lanes already carry a health gate for
 * (#922/#927/#1045). The prototype confirmed it: the sweep went from 40 s to 120 s+,
 * google's write did not answer inside 45 s, and the confirmation read then timed
 * out as well. The panel enables its five defaults on its own, and the suite only
 * ever picks the SETTLED model per provider out of `models.json`, so one write per
 * provider buys everything the run needs for ~1 s each.
 *
 * Never throws: like every other verdict in this file it reports, and the caller
 * decides (`collect-models.spec.ts` fails the pre-flight on a definite negative).
 */
export async function ensureTargetModelsEnabled(
  request: Pick<APIRequestContext, "get" | "post">,
  targets: Array<{ providerDisplayName: string; model: string }>,
): Promise<Map<string, TargetEnablement>> {
  const byProvider = new Map<string, string[]>();
  for (const { providerDisplayName, model } of targets) {
    const models = byProvider.get(providerDisplayName) ?? [];
    if (!models.includes(model)) models.push(model);
    byProvider.set(providerDisplayName, models);
  }

  const verdicts = new Map<string, TargetEnablement>();
  if (byProvider.size === 0) return verdicts;

  // ONE request per provider, not one for every target. The endpoint validates
  // per model and raises on the FIRST update it rejects, before persisting any of
  // them — so a single batch lets one provider's rejected model cost every other
  // provider its enable. Round trips are milliseconds against a write measured at
  // ~1 s, which makes the isolation free (#980: coverage first).
  const writes = new Map<string, EnableWriteOutcome>();
  for (const [provider, models] of byProvider) {
    const write: EnableWriteOutcome = await request
      .post("/api/v1/models/enabled_models", {
        data: models.map((model) => ({
          provider,
          model_id: model,
          model_type: "llm" as const,
          enabled: true,
        })),
        timeout: ENABLE_TARGETS_TIMEOUT_MS,
      })
      .then(async (r) => ({
        ok: r.ok(),
        detail: r.ok() ? null : `HTTP ${r.status()} ${(await r.text()).slice(0, 300)}`,
      }))
      .catch((error: unknown) => ({
        ok: false,
        detail: `no HTTP status (${error instanceof Error ? error.message : String(error)})`,
      }));
    writes.set(provider, write);

    if (!write.ok) {
      // Reported, not thrown: the model may already be enabled from an earlier
      // sweep against the same instance, and the read below is what decides.
      console.warn(
        `⚠️  collect-models: enabling [${provider}] ${models.join(", ")} answered ${write.detail}. ` +
          `The confirmation read below is what says whether the run is on the cold path (#1666).`,
      );
    }
  }

  // `readAnswered` is tracked separately from the payload so an answered response
  // that omits a provider is not reported as a failed read (see
  // `confirmEnabledOnServer`). The per-type map is preferred over the flat one for
  // the reason the backend states about its own shapes: "Per-type map is exact; flat
  // map ORs rows that share provider/name", so the flat map can read `true` for an
  // `llm` target whose only enabled row is `embeddings` — which is also why the
  // product's own `isModelEnabled` prefers the typed map.
  const read = await request
    .get("/api/v1/models/enabled_models?purpose=configure", { timeout: ENABLE_TARGETS_TIMEOUT_MS })
    .then(async (r) => ({ answered: r.ok(), body: r.ok() ? await r.json() : null }))
    .catch(() => ({ answered: false, body: null }));
  const flat = read.body?.enabled_models as Record<string, Record<string, boolean>> | undefined;
  const typed = read.body?.enabled_models_by_type as
    | Record<string, Record<string, Record<string, boolean>>>
    | undefined;
  const mapFor = (provider: string): Record<string, boolean> | undefined =>
    typed?.[provider]?.llm ?? flat?.[provider];

  for (const [provider, models] of byProvider) {
    const confirmation = confirmEnabledOnServer(mapFor(provider), models, read.answered);
    const verdict = targetEnablementVerdict(
      writes.get(provider) ?? { ok: false, detail: "no write was issued" },
      confirmation,
    );
    verdicts.set(provider, verdict);
    if (verdict.state === "enabled") {
      console.log(
        `   collect-models: [${provider}] ${models.join(", ")} confirmed enabled on the server.`,
      );
    } else {
      console.warn(`⚠️  [${provider}] ${verdict.detail}`);
    }
  }
  return verdicts;
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
  // in DOM but collapses them under a "Show N deprecated models" button, and a
  // hidden row's model name is not one this catalog should carry (see PR #330).
  const toggles = page.locator('[data-testid^="llm-toggle"]:visible');
  const toggleCount = await toggles.count();
  const models: ModelRecord[] = [];

  // READ ONLY. This loop used to click every unchecked toggle as well, and #1666
  // measured that none of those writes ever landed: `useModelToggleQueue` batches
  // them behind a 1000 ms debounce and cancels + DISCARDS the batch when the panel
  // unmounts or the selected provider changes, which is exactly what this function
  // does next. 74 clicks across three providers produced ZERO
  // `POST /models/enabled_models` on a clean 1.12.0.dev45 container.
  //
  // Making them land was rejected on measured COST, not difficulty: the endpoint
  // validates the provider key once per model, synchronously, so those 74 writes
  // cost ~250 s of a `LANGFLOW_WORKERS=1` backend per sweep (103 s for 30 models
  // against 0.02 s to disable the same 30). The panel enables its five defaults on
  // its own and the suite only ever picks the SETTLED model per provider, so
  // `ensureTargetModelsEnabled` writes those — one per provider, ~1 s each — after
  // the key axis has settled them. See its docstring for the full measurement.
  for (let i = 0; i < toggleCount; i++) {
    const modelName = await toggles.nth(i).locator("..").locator("span.text-sm").textContent();
    if (modelName?.trim()) {
      models.push({ provider: providerName, model: modelName.trim() });
    }
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

  // BOTH data files are written BEFORE the target-model step, and providers.json is
  // then patched with its verdict. Order matters more than it looks: step 3b spends
  // up to one write per keyed provider plus a read against a single-worker backend,
  // and it sits at the very end of a sweep that has already spent minutes — so a
  // `test.setTimeout` abort inside it used to discard the ENTIRE sweep output.
  // `resolveTestTargets()` with no models.json resolves one `(fallback)` target and
  // every parametrized spec skips green, which is the #570/#1012 trap this file
  // works hard elsewhere to prevent. Written first, an abort costs the verdict, not
  // the catalog.
  fs.writeFileSync(PROVIDERS_PATH, JSON.stringify(providers, null, 2), "utf-8");
  console.log(`providers.json saved with ${providers.length} providers.`);

  // Persist models with each provider's settled model first, so "one model per
  // provider" spec parametrization targets the model that actually validated.
  const ordered = promoteSettledModels(models, providers);
  fs.writeFileSync(MODELS_PATH, JSON.stringify(ordered, null, 2), "utf-8");
  console.log(`models.json saved with ${ordered.length} models.`);

  // Step 3b: make the models this run will TARGET actually usable (#1666).
  //
  // Deliberately after step 3, not inside the UI sweep: the target model is
  // whatever the key axis SETTLED on, which is not known until here, and
  // `promoteSettledModels` above is what puts it in front of every consumer. Only
  // ACTIVE providers get a write — an inactive one has no settled model, and
  // enabling into a dead key answers 400 (the endpoint validates per model).
  //
  // The display name is looked up through `keyedProviders` rather than cast from
  // `record.provider`, so a record naming a provider this map does not know falls
  // through with no verdict instead of reaching `langflowProviderName`. That
  // function still throws by contract if a `providerTestId` loses its prefix, which
  // is the loud failure it is for — and now costs only the verdict, since both data
  // files are already on disk.
  const displayNames = new Map(
    keyedProviders.map(([provider]) => [provider as string, langflowProviderName(provider)]),
  );
  const enablement = await ensureTargetModelsEnabled(
    page.request,
    providers.flatMap((record) => {
      const providerDisplayName = displayNames.get(record.provider);
      return record.status === "active" && record.model && providerDisplayName
        ? [{ providerDisplayName, model: record.model }]
        : [];
    }),
  );
  for (const record of providers) {
    const providerDisplayName = displayNames.get(record.provider);
    const verdict = providerDisplayName ? enablement.get(providerDisplayName) : undefined;
    if (record.status !== "active" || !record.model) {
      // No target to enable at all, which is not the same claim as "unknown".
      record.targetEnablement = null;
      record.targetEnablementDetail = null;
      continue;
    }
    record.targetEnablement = verdict?.state ?? "unknown";
    record.targetEnablementDetail =
      verdict === undefined
        ? `no target-model verdict was produced for provider "${record.provider}" — it is not in ` +
          `providerConfigMap, or the enable step did not reach it`
        : verdict.detail || null;
  }
  // Rewritten with the verdict attached. The first write above is what survives an
  // abort; this one is what the pre-flight gate reads.
  fs.writeFileSync(PROVIDERS_PATH, JSON.stringify(providers, null, 2), "utf-8");
}
