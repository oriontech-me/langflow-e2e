// OpenRouter as a provider the agent specs can run against (#2292).
//
// ## Why it is not configured by the `collect-models` sweep
//
// The sweep saves every keyed provider through the Settings UI and leaves it configured
// for the whole run. OpenRouter is the provider the suite relies on being UNCONFIGURED:
// `modelProviderModal.spec.ts` asserts its empty detail panel,
// `model-provider-modal-actions.spec.ts` asserts it shows no model badge and no stored
// key — and saves an invalid key into it — and the Foundry provider spec uses it as its
// differential control. A sweep-configured OpenRouter would break all of them on every
// lane that holds the key, so it takes Foundry's split (`azure-foundry.ts`):
//
//  - `collect-models` validates the key against OpenRouter DIRECTLY and records it in
//    providers.json / models.json, never touching Langflow;
//  - Langflow is configured only when the run actually TARGETS OpenRouter
//    (`openRouterTargeted`), by `globalSetup` before any worker and again idempotently
//    by `setupOpenRouter` as a fallback;
//  - the specs that need it unconfigured yield on exactly those runs, same predicate.
//
// ## Which models it records
//
// OpenRouter's catalog is live and large (469 models, 398 with tool calling, measured
// 2026-10-17), and Langflow reads the same `/models` once a key is saved. Recording all
// of it would give every `ALL_MODELS` / per-provider sweep hundreds of targets nobody
// chose, so models.json gets only the PREFERRED models the catalog offers with tool
// calling — `openai/gpt-4o-mini` first, the model the daily already trusts on OpenAI,
// so an OpenRouter run is comparable with an OpenAI one and proves the ROUTING rather
// than a different model family (the safe gate #2292 asks for). A family the rotation
// has none of (`meta-llama/llama-3.3-70b-instruct`) can be added to the list once this
// one holds.
import type { APIRequestContext } from "@playwright/test";
import { getAuthToken } from "../auth/get-auth-token";
import { langflowProviderName, providerConfigMap } from "./provider-config";
import { resolveTestTargets, type ModelRecord } from "./test-targets";
import {
  ensureConfiguredOverApi,
  onDemandProviderTargeted,
  type OnDemandConfigureResult,
} from "./on-demand-provider";

export const OPENROUTER = "openrouter" as const;
const CONFIG = providerConfigMap[OPENROUTER];

export const OPENROUTER_API_BASE = "https://openrouter.ai/api/v1";

/**
 * The models recorded and probed, in preference order. Exact ids: OpenRouter's catalog
 * carries dozens of `openai/gpt-4o-*` variants (`-search-preview`, dated snapshots)
 * that a prefix would sweep in.
 */
export const OPENROUTER_PREFERRED_MODELS: readonly string[] = [
  "openai/gpt-4o-mini",
  "openai/gpt-4.1-mini",
  "openai/gpt-4o",
];

/**
 * Ceiling for every request to OpenRouter. The key axis runs inside the
 * `collect-models` sweep BEFORE providers.json and models.json are written, so a
 * request that never answers would otherwise hold the sweep for undici's ~300 s default
 * and risk the spec's own timeout, which discards the whole sweep output (#570/#1012).
 */
export const OPENROUTER_PROBE_TIMEOUT_MS = 30_000;

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export function openRouterKey(env: NodeJS.ProcessEnv = process.env): string | null {
  return env[CONFIG.variable] || null;
}

/**
 * The status an OpenRouter refusal answers, said in words, so the record reads as what
 * it is (#2292 scope 4). 402 is the account: the credit ran out (or the key's own limit
 * was reached), which collect-models' BILLING_OR_QUOTA test downgrades to a transient
 * skip. 401 is the key itself: revoked or wrong — OpenRouter's own message for it is
 * the unhelpful "User not found." (measured 2026-10-17), hence the gloss.
 */
export function describeOpenRouterRefusal(status: number, message: string | undefined): string {
  const gloss =
    status === 402
      ? "OpenRouter credit exhausted (or the key's limit reached)"
      : status === 401
        ? "OpenRouter refused the key"
        : status === 429
          ? "OpenRouter rate-limited the request"
          : null;
  const parts = [`HTTP ${status}`, gloss, message].filter(Boolean);
  return parts.join(": ");
}

/**
 * The catalog's tool-capable model ids, or the reason it could not be read.
 *
 * Tool calling is read from `supported_parameters`, the field OpenRouter itself uses to
 * route a `tools` request; Langflow derives its own `tool_calling` flag per model from
 * the same catalog.
 */
export async function fetchOpenRouterToolModels(
  apiKey: string,
  fetchImpl: FetchLike = fetch,
): Promise<{ models: string[] } | { error: string }> {
  try {
    const res = await fetchImpl(`${OPENROUTER_API_BASE}/models`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(OPENROUTER_PROBE_TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      return { error: describeOpenRouterRefusal(res.status, body?.error?.message) };
    }
    const body = (await res.json().catch(() => null)) as {
      data?: Array<{ id?: unknown; supported_parameters?: unknown }>;
    } | null;
    if (!Array.isArray(body?.data)) {
      return { error: "OpenRouter /models answered without a `data` list" };
    }
    const models = body.data
      .filter((m) => Array.isArray(m.supported_parameters) && m.supported_parameters.includes("tools"))
      .map((m) => m.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    return { models };
  } catch (e) {
    return { error: (e as Error)?.message ?? "Unknown error" };
  }
}

/** The preferred models the catalog offers with tool calling, in preference order. */
export function openRouterCandidates(toolModels: readonly string[]): string[] {
  const offered = new Set(toolModels);
  return OPENROUTER_PREFERRED_MODELS.filter((model) => offered.has(model));
}

export interface OpenRouterModelVerdict {
  status: "active" | "inactive";
  error: string | null;
}

/**
 * The key axis for one model: a tiny chat completion, from the test host, with no
 * Langflow involved.
 */
export async function validateOpenRouterModel(
  model: string,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: FetchLike = fetch,
): Promise<OpenRouterModelVerdict> {
  const apiKey = openRouterKey(env);
  if (!apiKey) return { status: "inactive", error: `${CONFIG.variable} not set` };
  try {
    const res = await fetchImpl(`${OPENROUTER_API_BASE}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(OPENROUTER_PROBE_TIMEOUT_MS),
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 16,
      }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      return { status: "inactive", error: describeOpenRouterRefusal(res.status, body?.error?.message) };
    }
    return { status: "active", error: null };
  } catch (e) {
    return { status: "inactive", error: (e as Error)?.message ?? "Unknown error" };
  }
}

/**
 * Whether THIS run's agent specs will run on OpenRouter — the one predicate that
 * decides who owns the instance's OpenRouter credential. A run with no key never
 * targets it.
 */
export function openRouterTargeted(
  opts: {
    env?: NodeJS.ProcessEnv;
    models?: ModelRecord[];
    skipReasons?: Map<string, string>;
  } = {},
): boolean {
  const env = opts.env ?? process.env;
  if (!openRouterKey(env)) return false;
  return onDemandProviderTargeted(OPENROUTER, { ...opts, env });
}

/**
 * The model this run's OpenRouter targets resolve to — what `globalSetup` enables
 * before any worker starts. `null` when no target runs on OpenRouter.
 */
export function openRouterTargetModel(
  opts: {
    env?: NodeJS.ProcessEnv;
    models?: ModelRecord[];
    skipReasons?: Map<string, string>;
  } = {},
): string | null {
  const target = resolveTestTargets({
    tier: "tool-calling",
    env: opts.env ?? process.env,
    models: opts.models,
    skipReasons: opts.skipReasons,
  }).find((t) => t.options.provider === OPENROUTER && !t.skipReason);
  return target?.options.model ?? null;
}

/** Models THIS process has already seen enabled — see `ensureConfiguredOverApi`. */
const ENABLED_IN_THIS_PROCESS = new Set<string>();

/**
 * Configure OpenRouter in Langflow over the API: the key variable, then `model`
 * enabled. Idempotent and race-tolerant (`ensureConfiguredOverApi`).
 */
export async function ensureOpenRouterConfigured(
  ctx: APIRequestContext,
  model: string,
  env: NodeJS.ProcessEnv = process.env,
  enabledMemo: Set<string> = ENABLED_IN_THIS_PROCESS,
): Promise<OnDemandConfigureResult> {
  const apiKey = openRouterKey(env);
  if (!apiKey) {
    return { configured: false, wrote: false, detail: `${CONFIG.variable} not set in the environment` };
  }
  return ensureConfiguredOverApi(ctx, {
    displayName: langflowProviderName(OPENROUTER),
    variables: [{ name: CONFIG.variable, value: apiKey }],
    model,
    modelNoun: "model",
    memo: enabledMemo,
    memoKey: model,
  });
}

/**
 * Why a test that needs OpenRouter UNCONFIGURED must not run now, or `null` when it can.
 *
 * Two owners, either one enough. A run that TARGETS OpenRouter has it configured by
 * `globalSetup` for its agent specs. And an instance REUSED across runs — a developer's
 * local Langflow — keeps the credential a previous targeted run stored, since nothing
 * removes it: there the key is on the instance although this run does not target it.
 * The second is read from the instance itself, so a stored key is never overwritten
 * (the invalid-key test saves its bogus key over whatever is there).
 */
export async function openRouterUnconfiguredBlocker(ctx: APIRequestContext): Promise<string | null> {
  if (openRouterTargeted()) {
    return (
      "this run's agent specs target OpenRouter, so its credential is theirs (configured by " +
      "globalSetup) — this test needs OpenRouter unconfigured (#2292)"
    );
  }
  const authHeader = await getAuthToken(ctx);
  const listed = authHeader
    ? await ctx.get("/api/v1/variables/", { headers: { Authorization: authHeader } }).catch(() => null)
    : null;
  const rows = listed?.ok() ? await listed.json().catch(() => null) : null;
  if (!Array.isArray(rows)) return null;
  return (rows as Array<{ name?: string }>).some((row) => row.name === CONFIG.variable)
    ? `${CONFIG.variable} is already stored on this instance (left by an earlier run that ` +
        "targeted OpenRouter, or set by hand) — this test needs OpenRouter unconfigured and " +
        "would overwrite or misread it (#2292). Delete the variable to run it."
    : null;
}
