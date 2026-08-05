// Reading and classifying the Agent node's provider binding on a PERSISTED flow
// payload (issue #1072).
//
// `SimpleAgentTemplatePage.load()` ends on a guard added by #751: it blocks until
// the Agent node is bound to the provider the caller asked for. On the 1.11+
// unified model selector (`ModelInput`), the node prefills `api_key` with the
// DEFAULT credential (`ANTHROPIC_API_KEY`) when it MOUNTS — not when the dropdown
// opens; picking the target provider's model rebinds it, and both the rebind and the
// selection reach the database through the editor's debounced autosave
// `PATCH /api/v1/flows/{id}`.
//
// The guard used to be a blind poll with a bare `expect(...).toBe(credential)`
// inside, so when it ran out the whole report carried was:
//
//     Expected: "GOOGLE_API_KEY"
//     Received: "ANTHROPIC_API_KEY"
//
// which reads like a wiring bug — a google-parameterized test observing an
// Anthropic credential — and was triaged as one across the 2026-07-22 and
// 2026-07-27 dailies before #1072 traced it to this guard. Several distinct states
// produce that identical line and they send a reader to different places, so this
// module names them instead of leaving them collapsed.
//
// It is pure over the flow payload, which is what lets the `node --test` lane cover
// the classification instead of re-deriving it from a daily's artifacts.
//
// #1274 — WHY THIS NO LONGER READS `api_key`, AND WHY IT IS STILL CALLED
// `agent-credential-settle`
//
// Upstream #14311 ("stop automatic provider field binding", `646bdd6b`, on the 1.12
// line since 2026-08-04) deleted the block that wrote the variable name into
// `api_key`. Measured on `1.12.0.dev16`: after selecting a Google model the persisted
// node reads `api_key: ""`, `load_from_db: false`, on every read from mount onward —
// so the transition this module used to wait for cannot happen, and 14 `@stable`
// specs failed the guard on the 2026-08-05 daily waiting 20s for it.
//
// The credential is no longer stored, but it is still DETERMINED — by the provider of
// the selected model. With `api_key` empty, `get_api_key_for_provider`
// (`lfx/base/models/unified_models/credentials.py`) resolves
// `get_provider_secret_variable_key(provider)` from the user's global variables. So
// this module now checks `model.value[0].provider`, which is not a weaker proxy for
// the credential — it is the input the runtime derives it from.
//
// The race #751 exists for is UNCHANGED and still real, which is why the guard is
// re-pointed rather than deleted. Same measurement, read 0: a freshly mounted node
// carries `{ name: "claude-opus-5", provider: "Anthropic" }` — the selector's default
// — and only later flips to the requested `{ name: "gemini-2.5-flash", provider:
// "Google Generative AI" }`. A caller that opens the Playground in between runs the
// DEFAULT provider's model, which is the original #744 signature (and, with the
// Anthropic key drained, an immediate hard failure).
//
// `api_key` is not asserted in either direction. Requiring it empty would swap one
// dated premise for another and break the `manual.yml` lanes that can still dispatch
// a pre-#14311 build; the field is simply no longer evidence about anything.
//
// The FILENAME and the `#751`/`#1072` references stay: both numbers appear in issue
// bodies, triage comments and error text already in circulation, and renaming the
// module would cost that traceability to buy an accurate noun.

/** The provider binding of the Agent node, as persisted in a flow payload. */
export interface AgentCredentialProbe {
  /**
   * `template.api_key.value` — the NAME of the Langflow global variable holding
   * the key (e.g. `"OPENAI_API_KEY"`), never the secret itself.
   *
   * **Reported, never classified on (#1274).** Since #14311 this is `""` on every
   * read, so it cannot separate any two states; it stays on the probe because the
   * failure diagnostic prints it, and a reader who knows the old behaviour needs to
   * see that it really is empty rather than wonder whether it was checked.
   */
  credential: string;
  /**
   * The `provider` of every model selected on the unified `ModelInput` selector —
   * Langflow's own spelling, e.g. `"Google Generative AI"`, `"Anthropic"`,
   * `"Ollama"` (see `langflowProviderName`).
   *
   * This is the axis the guard settles on. With `api_key` empty the runtime derives
   * the credential from exactly this field, so it is what proves the flow will run
   * against the provider the caller asked for.
   */
  selectedProviders: string[];
  /**
   * The `name` of every model selected on the unified `ModelInput` selector.
   *
   * `template.model.value` is an **array of model objects** (`{ name, provider,
   * icon, metadata, … }`), not a string — the backend executes
   * `model.value[0].name` directly (see `setAgentModelViaApi` in
   * `provider-setup/setup-language-model-openai.ts`, and the same read in
   * `agent-structured-output.spec.ts`). Reading it as a string is what made the
   * first cut of this module inert: every probe came back empty and every verdict
   * collapsed onto one.
   */
  selectedModels: string[];
}

export type CredentialSettleVerdict =
  /** Provider AND (when pinned) model are both applied — nothing to wait for. */
  | "settled"
  /**
   * The provider matches and a pinned model was expected, but NO model name is
   * observable — a degenerate payload (an entry carrying `provider` and no `name`).
   * Kept separate from `model-not-applied` because there is no other model to name
   * in the diagnostic, so "a DIFFERENT model is persisted" would be a claim about
   * something nobody saw.
   */
  | "model-pending"
  /**
   * A DIFFERENT provider is persisted than the one asked for (#1274). This is the
   * state the old `credential-pending` used to describe, moved onto the axis that
   * still exists: the selection has not landed, so the run would resolve the WRONG
   * provider's key. Waiting can help — the mount-time default sits here until the
   * autosave carries the pick.
   */
  | "provider-pending"
  /**
   * A DIFFERENT, non-empty model is persisted under the RIGHT provider: the
   * provider-setup step selected something other than what the caller asked for.
   * Waiting cannot fix it.
   */
  | "model-not-applied"
  /** No model is persisted at all — nothing has carried the selection. */
  | "nothing-persisted"
  /** The payload was read, and it carries no Agent node. */
  | "no-agent-node"
  /**
   * No read of the persisted flow ever succeeded, so there is nothing to classify.
   *
   * Kept distinct from `no-agent-node` because conflating them makes the guard
   * ASSERT a fact it never observed: on daily run 30444299314 every read in this
   * family timed out, and a collapsed verdict would have reported "the flow has no
   * Agent node" about a flow nobody managed to fetch.
   */
  | "read-failed";

interface FlowNodeLike {
  data?: {
    type?: string;
    node?: { template?: Record<string, { value?: unknown } | undefined> };
  };
}

/** `template.api_key.value` as a string, or `""` when absent/non-scalar. */
function credentialOf(node: FlowNodeLike): string {
  const value = node.data?.node?.template?.api_key?.value;
  return typeof value === "string" ? value : "";
}

/**
 * The selected model names out of `template.model.value`.
 *
 * Accepts the array-of-objects shape the running build persists, and tolerates a
 * bare string for the same reason `agent-structured-output.spec.ts` does: the
 * field carried one before the unified selector, and a stale flow payload must
 * degrade to "no model" rather than throw inside a poll.
 */
function selectedModelsOf(node: FlowNodeLike): string[] {
  return modelFieldStrings(node, "name");
}

/**
 * The `provider` of each selected model, out of the same `template.model.value`.
 *
 * A bare-string entry (the pre-unified-selector shape) yields no provider — the
 * field carried only a model name then — so such a payload degrades to "no provider
 * observed" rather than to a wrong one.
 */
function selectedProvidersOf(node: FlowNodeLike): string[] {
  return modelFieldStrings(node, "provider");
}

/** One string field out of every entry in `template.model.value`. */
function modelFieldStrings(node: FlowNodeLike, key: "name" | "provider"): string[] {
  const value = node.data?.node?.template?.model?.value;
  const entries = Array.isArray(value) ? value : [value];
  return entries
    .map((entry) => {
      // A bare string is a model NAME; it says nothing about the provider.
      if (typeof entry === "string") return key === "name" ? entry : "";
      const field = (entry as Record<string, unknown> | null)?.[key];
      return typeof field === "string" ? field : "";
    })
    .filter((field) => field.length > 0);
}

/**
 * Reads the Agent node's binding out of a `GET /api/v1/flows/{id}` payload, or
 * `null` when the flow carries no Agent node.
 *
 * Tolerant of every shape the endpoint can answer with (missing `data`, nodes
 * without `data.node`, a non-string `value`) because it runs inside a poll: a
 * transient partial payload must produce "not settled yet", never a crash that
 * escapes the retry loop.
 *
 * A flow with more than one Agent node probes the FIRST in array order. The
 * templates this guard runs against (Simple Agent) have exactly one, and
 * `load()` never adds a second; a multi-agent flow would need the caller to say
 * which node it means.
 */
export function readAgentCredentialProbe(
  flow: unknown,
): AgentCredentialProbe | null {
  const nodes = (flow as { data?: { nodes?: FlowNodeLike[] } })?.data?.nodes;
  const agent = (Array.isArray(nodes) ? nodes : []).find(
    (node) => node?.data?.type === "Agent",
  );
  if (!agent) return null;
  return {
    credential: credentialOf(agent),
    selectedProviders: selectedProvidersOf(agent),
    selectedModels: selectedModelsOf(agent),
  };
}

/**
 * Which state the probe is in.
 *
 * **The provider is the primary axis (#1274), and it is always available.** Every
 * caller of `load()` names a provider, so — unlike the credential this used to read,
 * and unlike `expectedModel` — there is no caller for which this check degrades to
 * nothing. That matters for the three specs that load WITHOUT pinning a model
 * (`model-provider-model-toggle`, `general-bugs-agent-images-playground`,
 * `agent-model-connection-isolation`), plus any spec whose `models.json` came back
 * empty: on the credential axis those would now settle on the first read and prove
 * nothing, because `api_key` is `""` from mount onward. On the provider axis they
 * still block on a real transition, since a freshly mounted node carries the
 * selector's DEFAULT provider (`"Anthropic"`, measured on `1.12.0.dev16`).
 *
 * `expectedModel` stays optional and stays a real check when supplied: same provider
 * with the wrong model still means the setup step clicked the wrong option.
 *
 * Gating on the model is only sound because a pinned model is never silently
 * substituted on this path: `setup-openai`, `setup-anthropic` and `setup-google`
 * each click the exact requested option or throw `MODEL_NOT_AVAILABLE` (which the
 * specs turn into a `test.skip`). The one substituting path —
 * `setupOpenAI(..., { fallbackToRanking: true })`, added for #606 — is opt-in and
 * used only by `helpers/other/initialGPTsetup.ts`, which calls the helper directly
 * and never through `SimpleAgentTemplatePage`. Wiring that option through
 * `providerSetupMap` would make this comparison fail on a legitimately substituted
 * model, so it must arrive with a way to tell the guard what was actually picked.
 *
 * `expectedProvider` is Langflow's own spelling of the provider name, which callers
 * get from `langflowProviderName()` — never this repo's `Provider` key, which does
 * not appear in the payload.
 */
export function classifyCredentialSettle(
  probe: AgentCredentialProbe | null,
  expectedProvider: string,
  expectedModel?: string,
): CredentialSettleVerdict {
  if (!probe) return "no-agent-node";

  // Nothing persisted at all is its own verdict, and it is checked FIRST: an empty
  // model list also has an empty provider list, so testing the provider before this
  // would report "a different provider is persisted" about a node carrying none.
  if (probe.selectedModels.length === 0 && probe.selectedProviders.length === 0) {
    return "nothing-persisted";
  }

  if (!probe.selectedProviders.includes(expectedProvider)) return "provider-pending";

  const modelApplied =
    !expectedModel || probe.selectedModels.includes(expectedModel);
  if (modelApplied) return "settled";
  // The provider is right, so the credential the run resolves is right; only the
  // pick within that provider is wrong. `model-not-applied` is the sharper of the
  // two when we can see a concrete other model.
  return probe.selectedModels.length > 0 ? "model-not-applied" : "model-pending";
}

export interface CredentialSettleFailure {
  flowId: string;
  provider: string;
  /** Langflow's own spelling of the provider — see `langflowProviderName`. */
  expectedProvider: string;
  expectedModel?: string;
  /** The last probe read, or `null` when the flow had no Agent node / was never read. */
  probe: AgentCredentialProbe | null;
  verdict: CredentialSettleVerdict;
  elapsedMs: number;
  reads: number;
  /** Last transport/HTTP error, when the reads themselves were failing. */
  lastReadError?: string;
}

/**
 * Per-verdict explanation: what to look at, and whether waiting could help.
 *
 * `settled` is absent on purpose — the formatter below only runs on failure, and a
 * guidance string that can never be printed is one more thing to keep true.
 */
const VERDICT_GUIDANCE: Record<
  Exclude<CredentialSettleVerdict, "settled">,
  string
> = {
  "model-pending":
    "The provider matches, so the credential the run resolves is already the right " +
    "one, but no model NAME is observable in the persisted selection while a " +
    "provider is. That is a degenerate payload, not a normal pending state — read " +
    "the `observed` line: if `models=[]` while a provider is present, the entry " +
    "carries a provider and no name, which no current build produces on the happy " +
    "path. Suspect a partially written autosave or a shape change in " +
    "`template.model.value`.",
  "provider-pending":
    "A DIFFERENT provider than the one requested is persisted on the Agent, so the " +
    "run would resolve the WRONG provider's key. Since #14311 the credential is not " +
    "stored at all — it is derived at run time from exactly this field (#1274) — so " +
    "this is the state that used to read as `credential-pending`. TWO causes fit and " +
    "the observed provider separates them: when it is the selector's mount-time " +
    "DEFAULT (`Anthropic`), the model pick has not been carried by the editor's " +
    "debounced autosave `PATCH /api/v1/flows/{id}` yet and waiting is the right " +
    "response (a saturated backend delays it — #1077). When it is some THIRD " +
    "provider, the setup step selected the wrong option and waiting cannot fix it. " +
    "Note this line prints only AFTER the budget expired, so retrying did NOT help " +
    "within it.",
  "model-not-applied":
    "The provider is right but a DIFFERENT model is persisted under it, so the run " +
    "would use the correct credential with the wrong model. Waiting cannot fix it: " +
    "look at the provider-setup helper for this provider (dropdown intercepted, " +
    "option missing, panel still animating). Before #1274 this verdict also covered " +
    "the wedged-save case, where the node kept its mount-time default; that state is " +
    "now `provider-pending`, because the default belongs to a different provider.",
  "nothing-persisted":
    "No model and no provider are persisted at all, so nothing carried the " +
    "selection. Two causes fit and this guard cannot separate them: the model click " +
    "never registered (provider setup), or the save never completed. Check the run " +
    "for `POST /api/v1/custom_component/update` — that is the request that refreshes " +
    "the field; the flows PATCH only persists its result.",
  "no-agent-node":
    "The persisted flow was read and has no Agent node: the Simple Agent template " +
    "did not instantiate as expected, or the id belongs to a different flow.",
  "read-failed":
    "No read of the persisted flow succeeded, so the binding is UNKNOWN — nothing " +
    "here says anything about the credential. Treat the read error above as the " +
    "finding (a wedged or recycling backend, #1077), not the binding.",
};

/**
 * The guidance for this failure.
 *
 * There is no longer a per-caller special case here. The old one existed because
 * `credential-pending`'s text asserted "the requested model IS applied" even for the
 * three callers that pin no model, where the model axis was unavailable. The primary
 * axis is now the provider, which EVERY caller supplies (#1274), so one string per
 * verdict is true for every caller.
 */
function guidanceFor(failure: CredentialSettleFailure): string {
  return VERDICT_GUIDANCE[
    failure.verdict as Exclude<CredentialSettleVerdict, "settled">
  ];
}

/**
 * The failure message the guard raises. Spelled out rather than left to a bare
 * `toBe` mismatch because this line is the entire product of the failure in a
 * daily's report — #1072 exists because the mismatch alone was triaged as a
 * provider-wiring bug across two separate runs.
 */
export function formatCredentialSettleFailure(
  failure: CredentialSettleFailure,
): string {
  const {
    flowId,
    provider,
    expectedProvider,
    expectedModel,
    probe,
    verdict,
    elapsedMs,
    reads,
    lastReadError,
  } = failure;

  const observed = probe
    ? `providers=[${probe.selectedProviders.join(", ")}] ` +
      `models=[${probe.selectedModels.join(", ")}] api_key="${probe.credential}"`
    : verdict === "read-failed"
      ? "no successful read of the persisted flow"
      : "the flow was read and carries no Agent node";

  return [
    `Agent credential never settled on the persisted flow (#751 guard, #1072).`,
    ``,
    `  flow           ${flowId}`,
    `  provider       ${provider} (expected "${expectedProvider}" on the persisted model)`,
    `  model wanted   ${expectedModel ?? "(caller let the setup helper choose)"}`,
    `  observed       ${observed}`,
    `  waited         ${(elapsedMs / 1000).toFixed(1)}s over ${reads} read(s)`,
    // Said once, here, because every reader of this message arrives knowing the old
    // behaviour and would otherwise read the empty api_key as the finding.
    `  note           api_key is EMPTY on every build since upstream #14311 and is`,
    `                 not asserted either way — the provider above is the axis (#1274).`,
    ...(lastReadError ? [`  last read err  ${lastReadError}`] : []),
    ``,
    `  verdict        ${verdict}`,
    `                 ${guidanceFor(failure)}`,
  ].join("\n");
}
