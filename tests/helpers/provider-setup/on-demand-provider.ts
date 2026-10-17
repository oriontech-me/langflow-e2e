// The part every ON-DEMAND provider shares (#2281, #2292): configured in Langflow over
// the API, only by a run that targets it, never by the `collect-models` UI sweep.
//
// Azure AI Foundry was the first such provider and carried all of this inline. The
// second (OpenRouter) differs only in WHAT it writes — one key instead of a key and an
// endpoint — and in what the model is called, so the write-and-enable transaction and
// the picker's recovery ladder live here once, and `azure-foundry.ts` /
// `openrouter.ts` supply the values.
import type { APIRequestContext, Page } from "@playwright/test";
import { getAuthToken } from "../auth/get-auth-token";
import { hideInspectorPanel } from "../ui/hide-inspector-panel";
import { openModelPickerAfterPanelClose, selectPinnedModelOption } from "./model-option";
import { resolveTestTargets, type ModelRecord } from "./test-targets";
import type { Provider } from "./provider-config";

export interface OnDemandConfigureResult {
  /** `true` when every variable exists and the model is enabled. */
  configured: boolean;
  /** `true` when this call created at least one variable (the picker cache is stale). */
  wrote: boolean;
  /** Human-readable outcome, always safe to print (never carries a secret). */
  detail: string;
}

export interface OnDemandConfiguration {
  /** Langflow's display name for the provider, as `enabled_models` keys it. */
  displayName: string;
  /** The variables to create, in WRITE order (the last one written is the one validated). */
  variables: Array<{ name: string; value: string }>;
  /** The model to enable. */
  model: string;
  /** What the provider calls a model, for messages: "deployment", "model". */
  modelNoun: string;
  /** Models this process has already seen enabled — see `ensureConfiguredOverApi`. */
  memo: Set<string>;
  /** The memo key: whatever identifies "this model on this account". */
  memoKey: string;
}

/**
 * Whether THIS run's agent specs will run on `provider` — the one predicate that decides
 * who owns the instance's credential for it.
 *
 * Derived from `resolveTestTargets` rather than restated, so it cannot drift from the
 * resolver the specs actually parametrize with: a pin to another provider answers
 * `false`, a pin to this one or an unpinned run whose catalog lists it answers `true`,
 * and a target the health gate would SKIP answers `false` (nothing will run on it, so
 * nothing needs the credential). `tool-calling` because that is the tier every hosted
 * agent spec declares; the routed `any-completion` tier never reaches a hosted provider.
 */
export function onDemandProviderTargeted(
  provider: Provider,
  opts: {
    env?: NodeJS.ProcessEnv;
    models?: ModelRecord[];
    skipReasons?: Map<string, string>;
  } = {},
): boolean {
  const targets = resolveTestTargets({
    tier: "tool-calling",
    env: opts.env ?? process.env,
    models: opts.models,
    skipReasons: opts.skipReasons,
  });
  return targets.some((t) => t.options.provider === provider && !t.skipReason);
}

/**
 * Configure a provider in Langflow over the API: its variables, then the model enabled.
 * Idempotent and race-tolerant.
 *
 * Over the API rather than the panel for the same reasons as
 * `preconfigure-routed-provider.ts`: it needs no page, and a concurrent first write from
 * another worker answers `400 "already exists"`, which here means "configured". An
 * existing variable is trusted as-is — a `Credential` value cannot be read back — and a
 * wrong one surfaces at the enable step, which validates against the provider.
 *
 * The enable is not a cheap write: Langflow validates the credentials on every
 * `POST /api/v1/models/enabled_models` that enables a model, already enabled or not
 * (`api/v1/models.py`, `update_enabled_models`), and that is a synchronous HTTP call to
 * the provider on the backend's event loop. Made once per test, it froze the backend
 * whenever Azure was slow — measured on the QA VM 2026-10-14 (run 20261014T134518Z): 8 s
 * outages on two shards' independent backends 2 s apart. So a worker validates once
 * (`memo`), and later calls that find the variables already present trust that answer.
 *
 * Returns a result instead of throwing: `globalSetup` must never die on it, and the
 * setup helpers turn a failure into an attributed error.
 */
export async function ensureConfiguredOverApi(
  ctx: APIRequestContext,
  config: OnDemandConfiguration,
): Promise<OnDemandConfigureResult> {
  const { displayName, model, modelNoun, memo, memoKey } = config;

  const authHeader = await getAuthToken(ctx);
  if (!authHeader) {
    return { configured: false, wrote: false, detail: "could not obtain an auth token" };
  }
  const headers = { Authorization: authHeader };

  const listed = await ctx.get("/api/v1/variables/", { headers });
  const rows = listed.ok() ? await listed.json().catch(() => null) : null;
  if (!Array.isArray(rows)) {
    return {
      configured: false,
      wrote: false,
      detail: `GET /api/v1/variables/ answered HTTP ${listed.status()} without a list — cannot tell what is configured`,
    };
  }
  const present = new Set(
    (rows as Array<{ name?: string }>).map((row) => row.name).filter(Boolean),
  );

  let wrote = false;
  for (const { name, value } of config.variables) {
    if (present.has(name)) continue;
    const created = await ctx.post("/api/v1/variables/", {
      headers,
      data: { name, value, type: "Credential", default_fields: [] },
    });
    if (created.ok()) {
      wrote = true;
      continue;
    }
    const body = await created.text().catch(() => "");
    // Another worker won the first write: the variable exists, which is the goal.
    if (created.status() === 400 && /already exists/i.test(body)) continue;
    return {
      configured: false,
      wrote,
      detail: `could not create ${name} (HTTP ${created.status()}: ${body.slice(0, 200)})`,
    };
  }

  // Nothing was written and this process already saw the model enabled: the enable
  // would only re-validate against the provider. A write always re-enables, since a new
  // variable is what the enable validates.
  if (!wrote && memo.has(memoKey)) {
    return {
      configured: true,
      wrote: false,
      detail: `${displayName} already configured with ${modelNoun} "${model}" enabled (checked earlier in this worker)`,
    };
  }

  // Validates through Langflow's own path, so a wrong credential already stored on the
  // instance is reported here, by name.
  const enabled = await ctx.post("/api/v1/models/enabled_models", {
    headers,
    data: [{ provider: displayName, model_id: model, enabled: true, model_type: "llm" }],
  });
  if (!enabled.ok()) {
    const body = await enabled.text().catch(() => "");
    return {
      configured: false,
      wrote,
      detail:
        `the variables are set, but enabling ${modelNoun} "${model}" failed ` +
        `(HTTP ${enabled.status()}: ${body.slice(0, 300)})`,
    };
  }
  const echo = (await enabled.json().catch(() => null)) as { enabled_models?: unknown } | null;
  const echoed = Array.isArray(echo?.enabled_models) ? echo.enabled_models : [];
  const expectedKey = `${displayName}::llm::${model}`;
  if (!echoed.includes(expectedKey)) {
    // An unknown provider name is accepted with HTTP 200 and enables nothing, so the
    // echo is the only proof the enable landed.
    return {
      configured: false,
      wrote,
      detail:
        `the server did not report "${expectedKey}" as enabled after the request ` +
        `(echo: ${JSON.stringify(echoed).slice(0, 200)})`,
    };
  }

  memo.add(memoKey);
  return {
    configured: true,
    wrote,
    detail: `${displayName} configured with ${modelNoun} "${model}" enabled`,
  };
}

export interface OnDemandPickerOptions {
  /** Langflow's display name, which labels the picker's options. */
  providerLabel: string;
  /** The model to select. */
  requested: string;
  /** What the provider calls a model, for messages. */
  modelNoun: string;
  /** The error-code prefix: `AZURE_FOUNDRY`, `OPENROUTER`. */
  code: string;
  /** Where the provider was validated before this run, for the failure messages. */
  validatedBy: string;
  /** Configure (or confirm) the provider; `fresh` bypasses the per-worker memo. */
  configure: (fresh: boolean) => Promise<OnDemandConfigureResult>;
}

/**
 * Select an on-demand provider's model on the Agent node of the open flow.
 *
 * Never opens the provider panel: the provider is configured over the API, which
 * `globalSetup` has normally already done before any worker started, and calling it
 * again here is the fallback for a run whose pre-configuration did not happen.
 *
 * When that fallback had to CREATE a variable, the page loaded before the provider
 * existed and its model options are stale, so the page is reloaded before the picker is
 * opened. When the picker still does not offer the model it reloads (another worker may
 * have made the write this page loaded before), and if that is not enough it re-enables
 * the model (a concurrent enable for another provider may have dropped it) and reloads
 * again. It never reports the model absent: an absence becomes a SKIP in the callers, so
 * a model still missing after a confirmed enable fails as `<code>_ENABLE_LOST`.
 */
export async function selectOnDemandModel(page: Page, opts: OnDemandPickerOptions): Promise<void> {
  const { providerLabel, requested, modelNoun, code, validatedBy } = opts;

  const result = await opts.configure(false);
  if (!result.configured) {
    throw new Error(
      `${code}_NOT_CONFIGURED: ${providerLabel} could not be configured in Langflow — ` +
        `${result.detail}. The provider was validated against ${validatedBy} by ` +
        `collect-models, so a failure here is Langflow's side of the configuration.`,
    );
  }
  if (result.wrote) await reloadToAgent(page);

  const pick = async (): Promise<boolean> => {
    await hideInspectorPanel(page);
    await openModelPickerAfterPanelClose(page, { providerLabel });
    const outcome = await selectPinnedModelOption(page, {
      requested,
      providerLabel,
      providerStrict: true,
      absentBehavior: "return",
    });
    return outcome.status === "selected";
  };
  if (await pick()) return;

  // 1. A stale page. `wrote` is false when ANOTHER worker created the variables (a
  //    duplicate 400), so a page loaded before that write can still hold the
  //    pre-configuration option list. A reload alone settles it.
  await reloadToAgent(page);
  if (await pick()) return;

  // 2. A lost enable. The enabled set is one per-user variable that every
  //    `enabled_models` POST reads, validates for seconds and rewrites whole, so a
  //    concurrent enable for another provider can save a list without this model, and
  //    the per-worker memo would never send it again. Re-enable for real, then look once
  //    more.
  const again = await opts.configure(true);
  if (!again.configured) {
    throw new Error(
      `${code}_NOT_CONFIGURED: the picker did not offer ${modelNoun} "${requested}", ` +
        `and re-enabling it failed — ${again.detail}. The provider was validated against ` +
        `${validatedBy} by collect-models, so a failure here is Langflow's side of the configuration.`,
    );
  }
  await reloadToAgent(page);
  if (await pick()) return;

  // Never a skip: the server has just echoed the model as enabled, so its absence from
  // the picker is not an absent model. A MODEL_NOT_AVAILABLE here would let the callers
  // skip the test on exactly the lane this provider exists for.
  throw new Error(
    `${code}_ENABLE_LOST: ${modelNoun} "${requested}" was enabled (the server echoed ` +
      `it) but the Agent's model picker still does not offer it for ${providerLabel} after ` +
      `a reload — the enabled set was rewritten again by a concurrent request, or the ` +
      `picker does not read it. Reported as a FAILURE, not a skip (#1012).`,
  );
}

/** Whether the open flow has an Agent node whose model picker this setup can drive. */
export async function hasAgentModelControl(page: Page): Promise<boolean> {
  const modelDropdown = page.getByTestId("model_model");
  const setupProviderBtn = page.getByRole("button", { name: "Setup Provider" });
  return (await modelDropdown.count()) > 0 || (await setupProviderBtn.count()) > 0;
}

async function reloadToAgent(page: Page): Promise<void> {
  await page.reload();
  await page.getByTestId("model_model").waitFor({ state: "visible", timeout: 60000 });
}
