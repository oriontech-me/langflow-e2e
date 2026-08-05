import { type Page } from "@playwright/test";
import { BasePage } from "./BasePage";
import { adjustScreenView } from "../helpers/ui/adjust-screen-view";
import { loadTemplateByName } from "../helpers/flows/load-template-by-name";
import { getAuthToken } from "../helpers/auth/get-auth-token";
import {
  classifyCredentialSettle,
  formatCredentialSettleFailure,
  readAgentCredentialProbe,
  type AgentCredentialProbe,
} from "../helpers/flows/agent-credential-settle";
import {
  langflowProviderName,
  providerConfigMap,
  providerSetupMap,
  hasProviderEnvKeys,
  missingProviderEnvKeys,
  type Provider,
} from "../helpers/provider-setup";

export interface LoadSimpleAgentOptions {
  provider?: Provider;
  model?: string;
}

/**
 * How long the guard waits for the binding to appear in the persisted flow.
 *
 * Deliberately left at the pre-#1072 value. Of the four occurrences the caret line
 * of each run's `results.json` pins on this guard, three recovered on a retry; the
 * fourth hard-failed on 2026-07-22, a day the daily recorded 22 hard failures in
 * total. Both readings point at the environment rather than at this number, and the
 * relief for that belongs to the saturation work (#1077) — a bigger budget here
 * would only make a genuinely stuck binding cost longer before it is reported. Two
 * mechanisms were tried and rejected instead of inflating it:
 *
 *  - **An autosave barrier** (`waitForFlowSaveSettled` before the check). It
 *    cannot work from here: it is attached AFTER the model click, and the rebind
 *    chain is a 300 ms `mutateTemplate` debounce → `POST
 *    /api/v1/custom_component/update` → the editor's autosave debounce, which is
 *    `GET /api/v1/config.auto_saving_interval` and answers **1000** on the running
 *    nightly (the 300 ms in `wait-for-flow-save-settled.ts` is only the store's
 *    pre-fetch default). The earliest `PATCH /api/v1/flows/{id}` is therefore
 *    ~1.3 s + a round trip away, while the helper's quiet window is 700 ms with
 *    nothing in flight at attach time — so it expires first. Measured locally: it
 *    resolved at ~0.7 s on a settle that completed at 1.5 s, having tracked no
 *    request at all. Under load it degenerates into a 700 ms sleep.
 *  - **Waiting on the rebind POST itself** (armable in `load()` before the setup
 *    call, so no change to the setup helpers). The disqualifier is that the same
 *    POST has ALREADY fired once when the Agent node mounted — the `api_key`
 *    prefill — so a single `waitForResponse` resolves on the prefill, not on the
 *    rebind, and telling them apart means inspecting bodies for a value this guard
 *    can read directly from the flow.
 */
const CREDENTIAL_SETTLE_TIMEOUT_MS = 20_000;

/** Read spacing; the last entry repeats until the budget ends. */
const CREDENTIAL_SETTLE_INTERVALS_MS = [250, 500, 1000, 2000];

/**
 * Above this, a SUCCESSFUL settle is still reported to the run output. A near-miss
 * is the early warning for the wedge behind #1077, and it is worth exactly one
 * line: the pre-#1072 guard was silent right up to the point where it failed, so a
 * daily could not show that the margin had been shrinking.
 */
const CREDENTIAL_SETTLE_SLOW_MS = 5_000;

export class SimpleAgentTemplatePage extends BasePage {
  constructor(page: Page) {
    super(page);
  }

  /**
   * Loads the Simple Agent template and configures the provider. Returns the
   * created flow's id (from `loadTemplateByName`) so callers can delete only
   * that flow in their teardown — never a global `cleanAllFlows`, which races
   * concurrent tests in the fully-parallel suite (#515).
   */
  async load(options: LoadSimpleAgentOptions = {}): Promise<string> {
    const { provider = "openai", model } = options;

    if (!hasProviderEnvKeys(provider)) {
      throw new Error(
        `Missing env vars for provider "${provider}": ${missingProviderEnvKeys(provider).join(", ")}`,
      );
    }

    // Load the Simple Agent template onto the canvas (opens the templates modal,
    // handles the 1.10.0 welcome overlay). Deliberately does NOT clear existing
    // flows — the cross-worker wipe was removed in #553.
    const flowId = await loadTemplateByName(this.page, "Simple Agent");

    // Adjust canvas view and configure the provider.
    // JSON stores model names (e.g. "claude-opus-4-6") — passed directly to setup for hasText matching
    await adjustScreenView(this.page);
    await providerSetupMap[provider](this.page, model);

    // #751: the Agent node mounts on the model selector's DEFAULT model — measured
    // on 1.12.0.dev16 as `{ name: "claude-opus-5", provider: "Anthropic" }` — and
    // only flips to the requested model once the editor's debounced autosave
    // `PATCH /api/v1/flows/{id}` carries the pick. A caller that opens the Playground
    // and sends a message in between runs the DEFAULT provider's model with that
    // provider's key, surfacing as "Flow build failed: Incorrect API key provided"
    // and a `div-chat-message` that never renders (the daily-#744 signature). Block
    // until the PERSISTED flow shows the requested provider, so every caller starts
    // settled.
    //
    // The axis is the PROVIDER of the persisted model, not `api_key` (#1274). Upstream
    // #14311 stopped writing that field — it reads `""` from mount onward on every
    // 1.12 build — so waiting on it could only ever time out, which is what failed 14
    // @stable specs on the 2026-08-05 daily. The provider is not a weaker substitute:
    // with `api_key` empty the runtime resolves the key FROM it
    // (`get_api_key_for_provider`), so it is the input that decides which credential
    // the run uses.
    //
    // This also fixes what the credential axis could not express for a KEYLESS
    // provider (#1187): `""` was both the settled state and the pre-selection state,
    // so the guard leaned on the caller passing a model. `provider: "Ollama"` is a
    // positive assertion, which is why no `credential === "base-url"` special case
    // survives here — and why the three callers that pin no model
    // (`model-provider-model-toggle`, `general-bugs-agent-images-playground`,
    // `agent-model-connection-isolation`) still block on a real transition.
    await this.waitForAgentCredentialSettled(
      flowId,
      langflowProviderName(provider),
      { provider, model },
    );

    return flowId;
  }

  /**
   * Block until the persisted flow shows the Agent carrying `expectedProvider`
   * AND the requested model. #751, reworked in #1072, re-pointed in #1274.
   *
   * What #1072 changed, and what it deliberately did not:
   *
   *  - **The check is no longer credential-only.** For `provider: "anthropic"` the
   *    expected credential IS the selector's default auto-binding, so the old
   *    check returned "settled" before the model selection had been applied at
   *    all — `load()`'s contract did not hold for that provider. See
   *    `classifyCredentialSettle`.
   *  - **The failure is now self-describing** rather than a bare `toBe` mismatch
   *    that reads as a provider-wiring bug (which is how it was triaged twice).
   *  - **The budget is unchanged.** The recorded flakes are load-induced and the
   *    relief for that is #1077; see `CREDENTIAL_SETTLE_TIMEOUT_MS` for the two
   *    wait mechanisms measured and rejected here.
   *
   * Why the PERSISTED flow and not a UI signal, which directive (c) of #1072 asks
   * about: the model widget (`model_model`) does settle earlier — it renders from
   * the in-memory store, and `modelInputComponent.spec.ts` already reads it — but
   * it only covers the axis that is not the risk. The risk #751 exists for is the
   * credential, and that has no non-modal surface: on the running nightly the
   * Agent's `api_key` is `show: true, advanced: true` (check it with `GET
   * /api/v1/all` → `.models_and_agents.Agent.template.api_key`), so reading it off the canvas
   * means opening the node's advanced-settings modal — an extra interaction on the
   * very canvas whose state is being measured. One persisted read covers both axes
   * and is the only observable that PROVES the rebind instead of proxying it.
   */
  private async waitForAgentCredentialSettled(
    flowId: string,
    expectedProvider: string,
    expected: { provider: Provider; model?: string },
  ): Promise<void> {
    const startedAt = Date.now();
    const deadline = startedAt + CREDENTIAL_SETTLE_TIMEOUT_MS;

    let reads = 0; // successful reads only — what the diagnostic reports
    let sleeps = 0; // drives the interval tier, so a retry cannot skip one
    let probe: AgentCredentialProbe | null = null;
    let everRead = false;
    let lastReadError: string | undefined;
    // Same-origin reads inherit the browser session's cookies, so the happy path
    // costs no extra request. `getAuthToken` is the fallback for an environment
    // that answers those unauthenticated — never the default, because it hits
    // `/api/v1/auto_login`, and on daily run 30444299314 that one call was where
    // 18 attempts across 8 agent specs died while the backend was wedged.
    let headers: Record<string, string> | undefined;
    let triedAuthFallback = false;

    for (;;) {
      try {
        const res = await this.page.request.get(`/api/v1/flows/${flowId}`, {
          headers,
        });
        if ((res.status() === 401 || res.status() === 403) && !triedAuthFallback) {
          triedAuthFallback = true;
          // No inner retry budget: this loop IS the retry, and `getAuthToken`'s
          // default `[2000, 8000, 20000]` backoff plus its per-attempt request
          // timeout would add ~110 s inside a single iteration, past this guard's
          // own deadline. One attempt, then the outer loop decides.
          const auth = await getAuthToken(this.page.request, { retryDelaysMs: [] });
          if (auth) {
            // Said out loud on purpose: a green run is not evidence that the
            // cookie path worked — the fallback would carry it silently. This
            // line is what makes "the happy path costs no auto_login" checkable.
            console.warn(
              `⚠️  agent credential guard: /api/v1/flows/${flowId} answered ` +
                `${res.status()} on the browser session, falling back to an explicit ` +
                `token (one extra /api/v1/auto_login on this load — #1072).`,
            );
            headers = { Authorization: auth };
            continue; // retry immediately with the explicit token
          }
        }
        if (res.ok()) {
          // Parse BEFORE counting the read. A 2xx whose body does not parse (a
          // truncated response from a recycling worker, a proxy's HTML) throws
          // here; marking the read as successful first would leave `probe` null
          // with `everRead` true and make the guard report "the flow was read and
          // carries no Agent node" about a body it never parsed — the exact
          // conflation `read-failed` exists to prevent.
          const body = await res.json();
          reads++;
          everRead = true;
          probe = readAgentCredentialProbe(body);
          lastReadError = undefined;
          if (
            classifyCredentialSettle(probe, expectedProvider, expected.model) ===
            "settled"
          ) {
            const elapsedMs = Date.now() - startedAt;
            if (elapsedMs > CREDENTIAL_SETTLE_SLOW_MS) {
              console.warn(
                `⚠️  agent credential settled slowly: ${(elapsedMs / 1000).toFixed(1)}s ` +
                  `over ${reads} read(s) for ${expected.provider} on flow ${flowId} ` +
                  `(#751 guard; a saturated backend delays the rebind and its ` +
                  `autosave — #1077).`,
              );
            }
            return;
          }
        } else {
          lastReadError = `HTTP ${res.status()} ${res.statusText()}`;
        }
      } catch (error) {
        // A read that never answers (the shared backend recycling its worker) is
        // retried within the budget like any other unsettled read — the guard's
        // verdict must describe the binding, not the first transport hiccup.
        lastReadError = (error as Error)?.message?.split("\n")[0] ?? String(error);
      }

      if (Date.now() >= deadline) break;
      const interval =
        CREDENTIAL_SETTLE_INTERVALS_MS[
          Math.min(sleeps, CREDENTIAL_SETTLE_INTERVALS_MS.length - 1)
        ];
      sleeps++;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(interval, Math.max(0, deadline - Date.now()))),
      );
    }

    throw new Error(
      formatCredentialSettleFailure({
        flowId,
        provider: expected.provider,
        expectedProvider,
        expectedModel: expected.model,
        probe,
        // A binding nobody managed to read is UNKNOWN, not absent: collapsing the
        // two would make the guard assert "this flow has no Agent node" about a
        // flow it never fetched — the shape of every read on daily 30444299314.
        verdict: everRead
          ? classifyCredentialSettle(probe, expectedProvider, expected.model)
          : "read-failed",
        elapsedMs: Date.now() - startedAt,
        reads,
        lastReadError,
      }),
    );
  }
}
