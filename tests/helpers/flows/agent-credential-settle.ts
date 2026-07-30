// Reading and classifying the Agent node's provider binding on a PERSISTED flow
// payload (issue #1072).
//
// `SimpleAgentTemplatePage.load()` ends on a guard added by #751: it blocks until
// the Agent node is bound to the provider the caller asked for. On the 1.11+
// unified model selector (`ModelInput`), opening the model dropdown auto-binds
// `api_key` to the DEFAULT credential (`ANTHROPIC_API_KEY`); picking the target
// provider's model rebinds it, and both the rebind and the selection reach the
// database through the editor's debounced autosave `PATCH /api/v1/flows/{id}`.
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

/** The provider binding of the Agent node, as persisted in a flow payload. */
export interface AgentCredentialProbe {
  /**
   * `template.api_key.value` — the NAME of the Langflow global variable holding
   * the key (e.g. `"OPENAI_API_KEY"`), never the secret itself. Empty string on a
   * freshly instantiated template, before any provider is configured.
   */
  credential: string;
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
  /** Credential AND (when known) model are both applied — nothing to wait for. */
  | "settled"
  /**
   * The credential is right but the requested model is not applied yet. The
   * dropdown's default binding IS the expected credential — i.e. the caller asked
   * for anthropic — so the credential axis alone proves nothing here.
   */
  | "model-pending"
  /**
   * The requested model is applied but the credential still is not: the selection
   * registered and only the rebind has yet to be persisted. Waiting helps.
   */
  | "credential-pending"
  /**
   * A DIFFERENT, non-empty model is persisted: the provider-setup step selected
   * something other than what the caller asked for. Waiting cannot fix it.
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
  const value = node.data?.node?.template?.model?.value;
  const entries = Array.isArray(value) ? value : [value];
  return entries
    .map((entry) => {
      if (typeof entry === "string") return entry;
      const name = (entry as { name?: unknown } | null)?.name;
      return typeof name === "string" ? name : "";
    })
    .filter((name) => name.length > 0);
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
    selectedModels: selectedModelsOf(agent),
  };
}

/**
 * Which state the probe is in.
 *
 * The credential is NOT sufficient on its own. `ANTHROPIC_API_KEY` is both the
 * dropdown's default auto-binding and the expected credential of the `anthropic`
 * provider, so a credential-only check returns "settled" for every anthropic
 * caller the instant the default binding persists — before the requested model is
 * applied at all. That is why `load()`'s contract ("every caller starts settled")
 * did not hold for anthropic, and why the issue's anthropic row
 * (`agent-max-iterations.spec.ts:255`) could never have been this guard's
 * expected/received mismatch: for anthropic the mismatch is unreachable.
 *
 * `expectedModel` is optional — a caller may let the provider-setup helper pick
 * the first available model, leaving no name to compare. Every parametrized agent
 * spec does pass one, so the model axis is available in the common case.
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
 */
export function classifyCredentialSettle(
  probe: AgentCredentialProbe | null,
  expectedCredential: string,
  expectedModel?: string,
): CredentialSettleVerdict {
  if (!probe) return "no-agent-node";

  const modelApplied =
    !expectedModel || probe.selectedModels.includes(expectedModel);

  if (probe.credential === expectedCredential) {
    return modelApplied ? "settled" : "model-pending";
  }
  if (probe.selectedModels.length === 0) return "nothing-persisted";
  if (!modelApplied) return "model-not-applied";
  return "credential-pending";
}

export interface CredentialSettleFailure {
  flowId: string;
  provider: string;
  expectedCredential: string;
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
    "The credential matches but the requested model is not applied, so nothing " +
    "here says the model selection worked. Read the credential before concluding: " +
    "when it is the selector's DEFAULT binding (ANTHROPIC_API_KEY) the match is " +
    "free and proves nothing — this verdict exists because a credential-only check " +
    "declared such a load settled. When it is any other provider's, the rebind did " +
    "land and only the selection has not. Either way, look at the provider setup " +
    "step for this provider, not at the credential.",
  "credential-pending":
    "The requested model IS applied, so the selection registered and only the " +
    "credential rebind is missing from the persisted flow. The rebind is computed " +
    "by `POST /api/v1/custom_component/update` and persisted by the editor's " +
    "debounced autosave `PATCH /api/v1/flows/{id}`; a saturated backend delays " +
    "both (#1077). Note this line prints only AFTER the budget expired, so " +
    "retrying did NOT help within it — and a persisted credential belonging to a " +
    "THIRD provider is a real misbinding, not slowness. Compare the observed " +
    "credential against the provider before concluding load.",
  "model-not-applied":
    "A DIFFERENT model is persisted, so the provider-setup step selected something " +
    "other than what was asked for — waiting longer cannot fix it. Look at the " +
    "provider setup helper for this provider (dropdown intercepted, option " +
    "missing from the list, panel still animating), not at the save path.",
  "nothing-persisted":
    "No model is persisted at all, so nothing carried the selection. Two causes " +
    "fit and this guard cannot separate them: the model click never registered " +
    "(provider setup), or the rebind never completed. Check the run for " +
    "`POST /api/v1/custom_component/update` — that is the request that computes " +
    "the binding; the flows PATCH only persists its result.",
  "no-agent-node":
    "The persisted flow was read and has no Agent node: the Simple Agent template " +
    "did not instantiate as expected, or the id belongs to a different flow.",
  "read-failed":
    "No read of the persisted flow succeeded, so the binding is UNKNOWN — nothing " +
    "here says anything about the credential. Treat the read error above as the " +
    "finding (a wedged or recycling backend, #1077), not the binding.",
};

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
    expectedCredential,
    expectedModel,
    probe,
    verdict,
    elapsedMs,
    reads,
    lastReadError,
  } = failure;

  const observed = probe
    ? `api_key="${probe.credential}" models=[${probe.selectedModels.join(", ")}]`
    : verdict === "read-failed"
      ? "no successful read of the persisted flow"
      : "the flow was read and carries no Agent node";

  return [
    `Agent credential never settled on the persisted flow (#751 guard, #1072).`,
    ``,
    `  flow           ${flowId}`,
    `  provider       ${provider} (expected credential "${expectedCredential}")`,
    `  model wanted   ${expectedModel ?? "(caller let the setup helper choose)"}`,
    `  observed       ${observed}`,
    `  waited         ${(elapsedMs / 1000).toFixed(1)}s over ${reads} read(s)`,
    ...(lastReadError ? [`  last read err  ${lastReadError}`] : []),
    ``,
    `  verdict        ${verdict}`,
    `                 ${VERDICT_GUIDANCE[verdict as Exclude<CredentialSettleVerdict, "settled">]}`,
  ].join("\n");
}
