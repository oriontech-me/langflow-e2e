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
import { decideEntryPoint, setupProviderButton, type EntryPointProbe } from "./provider-panel-entry";
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
  if (echoed.includes(expectedKey)) {
    memo.add(memoKey);
    return {
      configured: true,
      wrote,
      detail: `${displayName} configured with ${modelNoun} "${model}" enabled`,
    };
  }

  // The echo lists only EXPLICITLY enabled models. Enabling a catalog DEFAULT just takes
  // it off the disabled list (`_update_model_sets` in `api/v1/models.py`), so a default
  // model never appears in it however well the enable landed — OpenRouter's
  // `openai/gpt-4o-mini` is one (`openrouter_constants.py`), measured on 1.13.0.dev45:
  // HTTP 200, echo without it, every OpenRouter test failing here (#2292). Foundry never
  // reached this branch because it is explicit-enable-only. So the effective state is
  // read back, which is also what keeps the reason the echo check exists: an unknown
  // provider name is accepted with HTTP 200 and enables nothing, and reads back as such.
  const effective = await readEffectiveEnablement(ctx, headers, displayName, model);
  if (effective === true) {
    memo.add(memoKey);
    return {
      configured: true,
      wrote,
      detail: `${displayName} configured with ${modelNoun} "${model}" enabled (a catalog default, confirmed by a read)`,
    };
  }
  return {
    configured: false,
    wrote,
    detail:
      `the server did not report "${expectedKey}" as enabled after the request ` +
      `(echo: ${JSON.stringify(echoed).slice(0, 200)}; effective state read back: ` +
      `${effective === null ? "unreadable" : String(effective)})`,
  };
}

/**
 * Whether the server says `model` is enabled for `displayName` right now, or `null` when
 * the read does not answer. The per-type map is preferred over the flat one for the
 * reason `ensureTargetModelsEnabled` gives (the flat map ORs rows across model types).
 */
async function readEffectiveEnablement(
  ctx: APIRequestContext,
  headers: Record<string, string>,
  displayName: string,
  model: string,
): Promise<boolean | null> {
  const read = await ctx
    .get("/api/v1/models/enabled_models?purpose=configure", { headers })
    .catch(() => null);
  if (!read || !read.ok()) return null;
  const body = (await read.json().catch(() => null)) as {
    enabled_models?: Record<string, Record<string, boolean>>;
    enabled_models_by_type?: Record<string, Record<string, Record<string, boolean>>>;
  } | null;
  if (!body) return null;
  const state = body.enabled_models_by_type?.[displayName]?.llm?.[model] ?? body.enabled_models?.[displayName]?.[model];
  return state === true;
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

/**
 * Whether the open flow has an Agent node whose model picker this setup can drive.
 *
 * Polled to a deadline, never sampled once, for the reason `openProviderPanel` gives
 * (#1465): a template load navigates before ReactFlow mounts the nodes, so an immediate
 * count sees no Agent and the setup returned having configured nothing. Measured on the
 * first OpenRouter run (#2292, 1.13.0.dev45): 4 of ~30 agent tests logged "No Agent node
 * found on canvas — skipping OpenRouter setup" and then failed the #751 guard with
 * nothing persisted. Azure carried the same single sample. An Agent node that is present
 * with neither control reachable is a suite defect and throws, as it does there.
 */
export async function hasAgentModelControl(
  page: Page,
  providerLabel: string,
  timeout = 20000,
): Promise<boolean> {
  const modelDropdown = page.getByTestId("model_model");
  const setupBtn = setupProviderButton(page);
  const agentNodes = page.locator('[data-testid^="rf__node-Agent"]');
  const deadline = Date.now() + timeout;
  let probe: EntryPointProbe;
  for (;;) {
    probe = {
      modelDropdown: await modelDropdown.count(),
      setupButton: await setupBtn.count(),
      agentNodes: await agentNodes.count(),
    };
    if (probe.modelDropdown > 0 || probe.setupButton > 0) break;
    if (Date.now() >= deadline) break;
    await page.waitForTimeout(500);
  }
  const decision = decideEntryPoint(probe, providerLabel);
  if (decision.kind === "unreachable") throw new Error(decision.message);
  return decision.kind !== "no-agent";
}

async function reloadToAgent(page: Page): Promise<void> {
  await page.reload();
  await page.getByTestId("model_model").waitFor({ state: "visible", timeout: 60000 });
}
