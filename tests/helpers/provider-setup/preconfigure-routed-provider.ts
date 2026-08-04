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
// so its save never lands, Langflow never enumerates the instance for it, and it
// reaches the model dropdown with zero Ollama options. `setupOllama` correctly refuses
// to skip on an empty list and throws `OLLAMA_PROVIDER_UNREACHABLE` — a message about
// an unreachable instance, for a perfectly reachable one.
//
// Measured on the #1187 adoption dispatches: 3 of 5 runs lost exactly one of 4
// declarations this way, each time a different one, with `Running 4 tests using 2
// workers` and the 400 above in the log. The same runs also logged
// `IntegrityError: UNIQUE constraint failed: flow.user_id, flow.name` — the second,
// independent collision of two workers loading the same template.
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
// The UI flow is three calls, and only the middle one needs a browser at all:
// `POST /api/v1/models/validate-provider` is stateless (it only validates),
// `POST /api/v1/variables/` persists the base URL as a `Global` variable, and
// `POST /api/v1/models/enabled_models` marks the served tags enabled. Driving them
// directly costs no page load and cannot be intercepted by an inspector panel.
//
// It is deliberately IDEMPOTENT and never fails the suite on its own: `setupOllama`
// remains the authority on whether the provider is usable, and it reports the real
// verdict per spec. This step only removes the concurrent-first-write window, so a
// failure here is announced and left for `setupOllama` to characterise.
import type { APIRequestContext } from "@playwright/test";
import { getAuthToken } from "../auth/get-auth-token";
import { providerConfigMap, type Provider } from "./provider-config";
import { ollamaBaseUrlFromLangflow, ollamaTestModel } from "./ollama-endpoint";

/** Langflow's display name for a provider, as `enabled_models` keys it. */
const PROVIDER_DISPLAY_NAME: Record<string, string> = { ollama: "Ollama" };

/** The `Global` variable Langflow reads the base URL from. */
const BASE_URL_VARIABLE: Record<string, string> = { ollama: "OLLAMA_BASE_URL" };

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
  const config = providerConfigMap[routed as Provider];
  if (config.credential !== "base-url") {
    return {
      attempted: true,
      configured: false,
      detail: `ANY_COMPLETION_PROVIDER="${routed}" is an API-key provider — nothing to pre-configure`,
    };
  }

  const variableName = BASE_URL_VARIABLE[routed];
  const displayName = PROVIDER_DISPLAY_NAME[routed];
  const model = ollamaTestModel(env);
  if (!variableName || !displayName) {
    return {
      attempted: true,
      configured: false,
      detail: `no pre-configuration recipe for keyless provider "${routed}"`,
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
  const names = existing.ok()
    ? new Set(
        ((await existing.json()) as Array<{ name?: string }>)
          .map((v) => v.name)
          .filter((n): n is string => !!n),
      )
    : new Set<string>();

  if (!names.has(variableName)) {
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

  // 2. Enable the pinned tag. Langflow auto-enables what the live instance serves
  //    when the provider is saved through the UI, but that enumeration is tied to
  //    the save we just bypassed — so state it explicitly. Idempotent: posting
  //    `enabled: true` for an already-enabled model is a no-op.
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

  return {
    attempted: true,
    configured: true,
    detail: `${displayName} configured at ${url} with "${model}" enabled`,
  };
}
