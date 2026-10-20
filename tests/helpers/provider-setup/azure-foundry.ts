// Azure AI Foundry as a provider the agent specs can run against (#2281).
//
// ## Why it is not configured by the `collect-models` sweep
//
// The sweep saves every keyed provider through the Settings UI and leaves it
// configured for the whole run. Doing that for Foundry would break the Foundry
// provider spec (`azure-ai-foundry-provider-setup.spec.ts`), whose subject includes
// the UNCONFIGURED surface: tests 2, 3, 5 and 6 skip on an instance that already
// holds a Foundry credential, tests 1 and 4 assert state only an unconfigured
// provider shows, test 3 saves bogus credentials, and tests 5 and 6 store a real one
// and delete it in their teardown. A
// sweep-configured Foundry would therefore cost those tests on every run, and their
// teardown would delete the credential under any agent spec running on Azure.
//
// So the split is:
//
//  - `collect-models` validates the declared deployment against Azure DIRECTLY
//    (`validateAzureFoundry`) and records it in providers.json / models.json, never
//    touching Langflow;
//  - Langflow is configured only when the run actually TARGETS Azure
//    (`azureFoundryTargeted`): once in `globalSetup`, before any worker, and again
//    idempotently by `setupAzureFoundry` as a fallback;
//  - the Foundry provider spec yields on exactly those runs (same predicate), with
//    the reason stated rather than as an unexplained skip.
//
// ## Why the deployment must reach the Agent through Langflow's live listing
//
// Langflow labels every Foundry deployment whose model starts with `gpt-5` as a
// reasoning model (`_AZURE_AI_FOUNDRY_REASONING_PATTERN` in
// `lfx/base/models/model_utils.py`), and the only effect of that label at
// instantiation is dropping `temperature`. The `gpt-5.6-sol` deployment REJECTS any
// non-default temperature — measured 2026-10-14: `temperature: 0.1` answers `400
// Unsupported value: 'temperature' does not support 0.1 with this model`. The label
// comes from the live deployment listing, which is what the Agent's picker reads once
// the provider is configured and the deployment enabled — so this module enables the
// deployment and lets the picker offer it, instead of writing a bare model name into
// the flow.
import type { APIRequestContext } from "@playwright/test";
import { langflowProviderName, providerConfigMap } from "./provider-config";
import type { ModelRecord } from "./test-targets";
import {
  ensureConfiguredOverApi,
  onDemandProviderTargeted,
  type OnDemandConfigureResult,
} from "./on-demand-provider";

export const AZURE_FOUNDRY = "azure-ai-foundry" as const;
const CONFIG = providerConfigMap[AZURE_FOUNDRY];

/** What the environment declares for Foundry, or which variables are missing. */
export type AzureFoundryDeclaration =
  | { declared: true; apiKey: string; endpoint: string; deployment: string }
  | { declared: false; missing: string[] };

export function azureFoundryDeclaration(
  env: NodeJS.ProcessEnv = process.env,
): AzureFoundryDeclaration {
  const [keyVar, endpointVar] = CONFIG.variables;
  const missing = CONFIG.envKeys.filter((key) => !env[key]);
  if (missing.length > 0) return { declared: false, missing };
  return {
    declared: true,
    apiKey: env[keyVar] as string,
    endpoint: (env[endpointVar] as string).replace(/\/+$/, ""),
    deployment: env[CONFIG.deploymentEnvKey] as string,
  };
}

/**
 * The OpenAI-compatible chat-completions URL for a configured endpoint.
 *
 * Mirrors the one rewrite Langflow applies (`normalize_azure_ai_foundry_endpoint`):
 * the Foundry portal shows the PROJECT endpoint (`…/api/projects/<name>`) most
 * prominently, and Langflow maps it to `…/openai/v1`. Without the same mapping a
 * project endpoint would validate here as broken while working in Langflow.
 */
export function azureFoundryChatUrl(endpoint: string): string {
  const url = new URL(endpoint);
  const path = url.pathname.toLowerCase();
  if (path.startsWith("/api/projects/") || path.replace(/\/+$/, "") === "/api/projects") {
    return `${url.protocol}//${url.host}/openai/v1/chat/completions`;
  }
  return `${endpoint.replace(/\/+$/, "")}/chat/completions`;
}

export interface AzureFoundryValidation {
  status: "active" | "inactive";
  model: string | null;
  error: string | null;
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Ceiling for the key-axis probe. It runs inside the `collect-models` sweep BEFORE
 * providers.json and models.json are written, so an endpoint that accepts the
 * connection and never answers would otherwise hold the sweep for undici's ~300 s
 * default and risk the spec's own timeout — which discards the whole sweep output,
 * the #570/#1012 trap. Langflow bounds the same resource (`AZURE_AI_FOUNDRY_REQUEST_TIMEOUT`).
 */
export const AZURE_FOUNDRY_PROBE_TIMEOUT_MS = 30_000;

/**
 * The key axis for Foundry: one tiny chat completion against the declared deployment,
 * from the test host, with no Langflow involved.
 *
 * Sends no `temperature` (the deployment rejects a non-default one, see the header)
 * and `max_completion_tokens` rather than `max_tokens`, which `gpt-5*` models refuse.
 * The cap is small but not 1: a reasoning-capable model can spend its budget before
 * emitting text, and a probe that fails on its own cap would read as a dead account.
 */
export async function validateAzureFoundry(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: FetchLike = fetch,
): Promise<AzureFoundryValidation> {
  const declaration = azureFoundryDeclaration(env);
  if (!declaration.declared) {
    return { status: "inactive", model: null, error: `${declaration.missing.join(", ")} not set` };
  }
  const { apiKey, endpoint, deployment } = declaration;

  let url: string;
  try {
    url = azureFoundryChatUrl(endpoint);
  } catch {
    return {
      status: "inactive",
      model: deployment,
      // Not echoed: the endpoint is a secret on every lane that declares it, and this
      // message lands in providers.json, which ships as an unmasked artifact.
      error: "AZURE_AI_FOUNDRY_ENDPOINT is not a URL",
    };
  }

  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "api-key": apiKey },
      signal: AbortSignal.timeout(AZURE_FOUNDRY_PROBE_TIMEOUT_MS),
      body: JSON.stringify({
        model: deployment,
        messages: [{ role: "user", content: "hi" }],
        max_completion_tokens: 16,
      }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      // The status leads the message: Azure's rate-limit wording ("exceeded token rate
      // limit … retry after N seconds") carries neither `429` nor `quota`, so without it
      // collect-models' BILLING_OR_QUOTA test read a transient 429 as a dead key.
      const message = body?.error?.message;
      return {
        status: "inactive",
        model: deployment,
        error: message ? `HTTP ${res.status}: ${message}` : `HTTP ${res.status}`,
      };
    }
    return { status: "active", model: deployment, error: null };
  } catch (e) {
    return {
      status: "inactive",
      model: deployment,
      error: (e as Error)?.message ?? "Unknown error",
    };
  }
}

/**
 * Whether THIS run's agent specs will run on Foundry — the one predicate that decides
 * who owns the instance's Foundry credential. See `onDemandProviderTargeted`; an
 * undeclared Foundry is never targeted.
 */
export function azureFoundryTargeted(
  opts: {
    env?: NodeJS.ProcessEnv;
    models?: ModelRecord[];
    skipReasons?: Map<string, string>;
  } = {},
): boolean {
  const env = opts.env ?? process.env;
  if (!azureFoundryDeclaration(env).declared) return false;
  return onDemandProviderTargeted(AZURE_FOUNDRY, { ...opts, env });
}

export type AzureFoundryConfigureResult = OnDemandConfigureResult;

/**
 * Deployments THIS process has already seen enabled, keyed by endpoint and deployment —
 * see `ensureConfiguredOverApi` for why the enable is validated once per worker.
 */
const ENABLED_IN_THIS_PROCESS = new Set<string>();

/**
 * Configure Foundry in Langflow over the API: the key and endpoint variables, then the
 * deployment enabled. Idempotent and race-tolerant (`ensureConfiguredOverApi`).
 */
export async function ensureAzureFoundryConfigured(
  ctx: APIRequestContext,
  env: NodeJS.ProcessEnv = process.env,
  enabledMemo: Set<string> = ENABLED_IN_THIS_PROCESS,
  /** The deployment to enable; the declared one unless a run pins another (MODEL_TEST_ID). */
  deploymentOverride?: string,
): Promise<AzureFoundryConfigureResult> {
  const declaration = azureFoundryDeclaration(env);
  if (!declaration.declared) {
    return {
      configured: false,
      wrote: false,
      detail: `${declaration.missing.join(", ")} not set in the environment`,
    };
  }
  const deployment = deploymentOverride ?? declaration.deployment;
  return ensureConfiguredOverApi(ctx, {
    displayName: langflowProviderName(AZURE_FOUNDRY),
    variables: [
      { name: CONFIG.variables[0], value: declaration.apiKey },
      { name: CONFIG.variables[1], value: declaration.endpoint },
    ],
    model: deployment,
    modelNoun: "deployment",
    memo: enabledMemo,
    memoKey: `${declaration.endpoint}::${deployment}`,
  });
}
