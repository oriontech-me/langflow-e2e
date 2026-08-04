// Configure the routed keyless provider ONCE, before any worker starts (#1187).
//
// ## The race this removes
//
// `setupOllama` configures the provider through the UI, from inside whichever spec
// runs first. That is fine for one spec and breaks at two: CI runs
// `workers: 2` on every lane (`playwright.config.ts`), so two routed spec FILES start
// concurrently — `test.describe.configure({ mode: "serial" })` only serializes within
// a file — and both take the not-yet-configured branch, because each checks before
// the other has finished. Both then save the base URL, and the loser gets
//
//     POST /api/v1/variables/ → 400 {"detail":"Variable name already exists"}
//
// so that create is rejected — and the frontend invalidates its model-options cache
// only after its OWN create succeeds, so the loser keeps the empty list it started with
// and reaches the model dropdown with zero Ollama options. `setupOllama` correctly
// refuses to skip on an empty list and throws `OLLAMA_PROVIDER_UNREACHABLE` — a message
// about an unreachable instance, for a perfectly reachable one.
//
// The backend is never the problem here, and getting that right is what decides the
// fix: enumeration is LIVE per read (`fetch_live_ollama_models()` hits `/api/tags` on
// every options build) and a provider counts as configured purely because its base-URL
// variable exists, so the winner's variable already satisfies the loser. Hence: write
// the variable once before anyone races for it — not make the loser retry.
//
// Measured on the #1187 adoption dispatches of the three re-tiered specs: 3 of 5 runs
// lost exactly one of 4 declarations this way, each time a different one, with
// `Running 4 tests using 2 workers` and the 400 above in the log. (Disjoint from the
// five pilot dispatches quoted in `agent-system-prompt.spec.ts`: those ran on `main`
// before any re-tier, one spec file, and every failure there was a sentinel miss with
// the reply recorded.) The same runs also logged `IntegrityError: UNIQUE constraint
// failed: flow.user_id, flow.name` — a second, independent collision of two workers
// loading the same template, left alone here because `loadTemplateByName` already
// retries that class (#1002) and no run has failed on it.
//
// PR #1212 could not see it: its pilot was a single file, so nothing ran in parallel
// and 3/3 held. The defect appears the moment the tier has more than one member.
//
// ## Why here and not in the lane YAML
//
// The hosted path does not have this race because `Collect models` imports every
// credential BEFORE the run, so `setupOpenAI` and friends short-circuit. This is that
// step's routed counterpart — but as a `globalSetup` phase rather than a workflow
// step, because it must also hold for a developer running a routed spec locally, and
// because `globalSetup` is the one place guaranteed to run before any worker in the
// process (once per shard under sharding, which is exactly the granularity needed).
//
// ## Why the API and not the UI
//
// The UI save is two calls and neither needs a browser:
// `POST /api/v1/models/validate-provider` (stateless — it only validates) and
// `POST /api/v1/variables/`, which persists the base URL as a `Global` variable. The
// variable alone is what makes the provider configured. Driving that directly costs no
// page load and cannot be intercepted by an inspector panel.
//
// This step adds a third call the UI save does NOT make — `POST
// /api/v1/models/enabled_models` — and the reason is not that the bypass lost
// something. Live tags come back with the first **five** marked `default=True`
// (`MIN_DEFAULT_MODELS` in `lfx/base/models/model_utils.py`), so on the CI image's
// single baked model the variable would be enough. It is insurance for the instance
// that serves more than five: the pinned tag can sort past position 5 and then it is
// not selectable, which would surface mid-spec as `MODEL_NOT_AVAILABLE`.
//
// It is deliberately IDEMPOTENT and never fails the suite on its own: `setupOllama`
// remains the authority on whether the provider is usable, and it reports the real
// verdict per spec. This step only removes the concurrent-first-write window, so a
// failure here is announced and left for `setupOllama` to characterise.
import type { APIRequestContext } from "@playwright/test";
import { getAuthToken } from "../auth/get-auth-token";
import { providerConfigMap, type Provider } from "./provider-config";
import { ollamaBaseUrlFromLangflow, ollamaTestModel } from "./ollama-endpoint";

/**
 * Langflow's display name for a provider, as `enabled_models` keys it — DERIVED from
 * `providerConfigMap`, not restated.
 *
 * `provider-config.ts` promises that adding a provider needs no changes elsewhere, and
 * a second hand-written table here would quietly break that promise. `providerTestId`
 * already carries the display name (`provider-item-Ollama`), so read it from there: a
 * new keyless provider gets its display name for free, and a renamed testid surfaces as
 * a reported refusal rather than a silent mismatch.
 */
function displayNameOf(provider: Provider): string | undefined {
  const prefix = "provider-item-";
  const testId = providerConfigMap[provider].providerTestId;
  return testId.startsWith(prefix) ? testId.slice(prefix.length) : undefined;
}

/**
 * The `Global` variable Langflow reads the base URL from — also derived. A keyless
 * provider declares exactly one `envKeys` entry and it IS that variable name.
 */
function baseUrlVariableOf(config: { envKeys: readonly string[] }): string | undefined {
  return config.envKeys.length === 1 ? config.envKeys[0] : undefined;
}

export interface PreconfigureResult {
  /** `false` when nothing was attempted (no routing requested). */
  attempted: boolean;
  /** `true` when the provider is configured and the pinned model is enabled. */
  configured: boolean;
  /** Human-readable outcome, always safe to print. */
  detail: string;
}

/**
 * Ensure the provider named by `ANY_COMPLETION_PROVIDER` is configured.
 *
 * A no-op unless routing is requested. Returns a result instead of throwing: the
 * caller decides how loud to be, and `setupOllama` still gates every spec.
 */
export async function preconfigureRoutedProvider(
  ctx: APIRequestContext,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PreconfigureResult> {
  const routed = env.ANY_COMPLETION_PROVIDER;
  if (!routed) return { attempted: false, configured: false, detail: "no routing requested" };

  if (!(routed in providerConfigMap)) {
    return {
      attempted: true,
      configured: false,
      detail: `ANY_COMPLETION_PROVIDER="${routed}" is not a provider this suite knows`,
    };
  }
  const provider = routed as Provider;
  const config = providerConfigMap[provider];
  if (config.credential !== "base-url") {
    return {
      attempted: true,
      configured: false,
      detail: `ANY_COMPLETION_PROVIDER="${routed}" is an API-key provider — nothing to pre-configure`,
    };
  }

  const variableName = baseUrlVariableOf(config);
  const displayName = displayNameOf(provider);
  const model = ollamaTestModel(env);
  if (!variableName || !displayName) {
    return {
      attempted: true,
      configured: false,
      detail:
        `cannot derive the pre-configuration inputs for keyless provider "${routed}" ` +
        `from providerConfigMap (providerTestId "${config.providerTestId}", envKeys ` +
        `[${config.envKeys.join(", ")}]) — a display name and exactly one base-URL ` +
        `variable are required`,
    };
  }
  if (!model) {
    return {
      attempted: true,
      configured: false,
      detail: `OLLAMA_TEST_MODEL is not set — the model to enable cannot be inferred`,
    };
  }

  const authHeader = await getAuthToken(ctx);
  if (!authHeader) {
    return { attempted: true, configured: false, detail: "could not obtain an auth token" };
  }
  const headers = { Authorization: authHeader };
  const url = ollamaBaseUrlFromLangflow(env);

  // 1. The base URL, as a `Global` variable. A 400 "already exists" is the SUCCESS
  //    case for our purposes — some earlier run or worker created it — so it is
  //    treated as configured rather than retried or reported.
  const existing = await ctx.get("/api/v1/variables/", { headers });
  const rows = existing.ok()
    ? ((await existing.json()) as Array<{ id?: string; name?: string; value?: string }>)
    : [];
  const current = rows.find((v) => v.name === variableName);

  // A STALE value is the case a name check alone misses, and it is reachable: a
  // developer's instance holds `host.docker.internal` from a dockerized run while the
  // lane wants `ollama:11434`, or the reverse. `type: "Global"` is not secret, so the
  // listing carries the plaintext value and the comparison is free — whereas leaving it
  // meant a run that "pre-configured successfully" against the wrong address, with the
  // real verdict deferred to whichever spec opened the dropdown first.
  // `PATCH /api/v1/variables/{id}`, not the collection — the collection answers 405, and
  // that is not a hypothetical: the first local run of this code hit it, because the box
  // held `host.docker.internal` from an earlier dockerized run while the run wanted
  // `localhost`. The warning path did its job (announced, non-fatal, `setupOllama` took
  // over and the specs still passed), which is exactly why the wrong route could have
  // shipped unnoticed had the comparison not been added at all.
  //
  // The update is VALIDATED server-side, and that is load-bearing rather than incidental:
  // writing a provider-mapped variable runs the provider's real check, so an address
  // Langflow cannot reach comes back `400 {"detail":"Invalid Ollama base URL"}` (measured
  // on 1.12.0.dev10 — loopback and an un-allow-listed private IP both rejected, the
  // reachable host accepted with 200). So a stale value cannot be replaced by an
  // unreachable one silently: the rejection is reported with its cause.
  if (current && current.value && current.value !== url && current.id) {
    const patched = await ctx.patch(`/api/v1/variables/${current.id}`, {
      headers,
      data: { id: current.id, name: variableName, value: url, type: "Global", default_fields: [] },
    });
    if (!patched.ok()) {
      const body = await patched.text().catch(() => "");
      return {
        attempted: true,
        configured: false,
        detail:
          `${variableName} holds "${current.value}" but this run needs "${url}", and ` +
          `updating it failed (HTTP ${patched.status()}: ${body.slice(0, 200)})`,
      };
    }
  }

  if (!current) {
    const created = await ctx.post("/api/v1/variables/", {
      headers,
      data: { name: variableName, value: url, type: "Global", default_fields: [] },
    });
    if (!created.ok()) {
      const body = await created.text().catch(() => "");
      // Concurrent creation is benign — that is the whole point of this step, and it
      // can still happen if two shards start at the same instant.
      const duplicate = created.status() === 400 && /already exists/i.test(body);
      if (!duplicate) {
        return {
          attempted: true,
          configured: false,
          detail: `could not create ${variableName} (HTTP ${created.status()}: ${body.slice(0, 200)})`,
        };
      }
    }
  }

  // 2. Enable the pinned tag explicitly — see the header: not because the bypass lost
  //    an auto-enable, but because only the first five live tags are default-enabled.
  //    Idempotent: posting `enabled: true` for an already-enabled model is a no-op.
  const enabled = await ctx.post("/api/v1/models/enabled_models", {
    headers,
    data: [{ provider: displayName, model_id: model, enabled: true, model_type: "llm" }],
  });
  if (!enabled.ok()) {
    const body = await enabled.text().catch(() => "");
    return {
      attempted: true,
      configured: false,
      detail:
        `${variableName} is set, but enabling "${model}" failed ` +
        `(HTTP ${enabled.status()}: ${body.slice(0, 200)})`,
    };
  }

  // `ok()` is not enough, and this is the one silent path in this file. An unknown
  // provider name is ACCEPTED: measured on 1.12.0.dev10, posting `"ollama"` instead of
  // `"Ollama"` answers HTTP 200 and stores `ollama::llm::llama3.2:1b` — an entry no
  // real provider matches, so nothing is enabled and the caller would print "routed
  // provider ready" over a no-op.
  //
  // The response echoes both resulting lists as `"<Provider>::<type>::<model>"`, so the
  // check is that COMPOSITE key, not the model name. A substring test on the model
  // alone passes for the misspelled provider — its bogus entry contains the tag too,
  // which is exactly how this check would have certified the bug it exists to catch.
  const echo = (await enabled.json().catch(() => null)) as {
    enabled_models?: unknown;
  } | null;
  const echoedList = Array.isArray(echo?.enabled_models) ? echo.enabled_models : [];
  const expectedKey = `${displayName}::llm::${model}`;
  if (!echoedList.some((entry) => entry === expectedKey)) {
    return {
      attempted: true,
      configured: false,
      detail:
        `${variableName} is set, but the server did not report "${expectedKey}" as ` +
        `enabled after the request (echo: ${JSON.stringify(echoedList).slice(0, 200)}). ` +
        `An unknown provider name is accepted with HTTP 200 and enables nothing.`,
    };
  }

  return {
    attempted: true,
    configured: true,
    detail: `${displayName} configured at ${url} with "${model}" enabled`,
  };
}
