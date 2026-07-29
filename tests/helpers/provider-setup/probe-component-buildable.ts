import type { APIRequestContext } from "@playwright/test";
import { getAuthToken } from "../auth/get-auth-token";
import type { Provider } from "./provider-config";

// The BUILD axis of collect-models (#900): can THIS Langflow image actually
// instantiate a provider's component? Independent of the key axis, which calls
// the provider's own API upstream of Langflow and therefore cannot see a
// packaging gap. A valid key on an image that cannot build the model used to
// record a false `active`; the real failure then surfaced tens of layers
// downstream as a generic node-build timeout, costing a full triage cycle each
// time (#898 / LE-1974, #907 / LE-1987).
//
// TWO LAYERS, because neither catches the other's shape. Which shape a provider
// produces is decided upstream by where a maintainer puts an `import`, and it is
// inconsistent across components — measured on 1.12.0.dev8:
//
//   | Component                            | langchain-* import | missing =>          |
//   |--------------------------------------|--------------------|---------------------|
//   | OpenAIModelComponent / Embeddings    | module level       | absent from registry|
//   | GoogleGenerativeAI* (chat via lfx.base) | module level    | absent from registry|
//   | AnthropicModelComponent              | LAZY, in build_model | PRESENT, fails at build |
//
//   1. CATALOG — a component whose distribution is not installed has no key in
//      GET /api/v1/all. One request covers every provider.
//   2. BUILD — a component whose distribution IS installed but whose runtime
//      package is missing registers normally and only fails when built. Proven by
//      hiding site-packages/langchain_anthropic and restarting: the registry still
//      exposed the Anthropic component while the build reported
//      "No module named 'langchain_anthropic'".
//
// Do NOT collapse this back to the catalog check alone — that was the design this
// issue started with, and Anthropic already falsifies it.
//
// This module is consumed by the node --test units lane, so its only
// @playwright/test import is type-only (same constraint provider-health.ts and
// get-auth-token.ts honour).

/**
 * `/api/v1/all` carries a lowercased echo of every component type under this
 * pseudo-category. It is not a component namespace: counting it would report a
 * component present after its real category is gone.
 */
const DISPLAY_NAMES_CATEGORY = "component_display_names";

/**
 * The exact registry keys each provider needs, replacing the substring token
 * match in `probe-component-available.ts` (where `openai` also matched
 * `OpenAI Compatible`). These are the 1.12 `lfx-bundles` per-vendor names
 * (#1040); an upstream rename makes the catalog layer report the provider
 * absent, which is a loud failure by design rather than a silent pass.
 *
 * Only the providers `collect-models` validates appear here. Groq and Mistral are
 * deliberately absent: they are not bundled in the image by product decision
 * (#1039) and are gated per-spec by `isProviderComponentAvailable`. Keeping them
 * out is what makes a declared "expected in this image?" flag unnecessary —
 * every provider listed here is one the image is expected to ship.
 */
export const PROVIDER_COMPONENTS: Record<Provider, readonly string[]> = {
  openai: [
    "ext:openai:OpenAIModelComponent@official",
    "ext:openai:OpenAIEmbeddingsComponent@official",
  ],
  anthropic: ["ext:anthropic:AnthropicModelComponent@official"],
  google: [
    "ext:google:GoogleGenerativeAIComponent@official",
    "ext:google:GoogleGenerativeAIEmbeddingsComponent@official",
  ],
};

export type BuildAxisFailure =
  | { layer: "distribution"; missing: string[] }
  | { layer: "runtime-package"; component: string; message: string };

/**
 * The declared component keys that the registry does not expose.
 *
 * Exact match on the second-level COMPONENT-TYPE keys only — never on nested
 * template field names, so a field like `ollama_base_url` on the unified Language
 * Model cannot false-positive the Ollama component.
 */
export function missingComponentKeys(
  registry: Record<string, unknown>,
  keys: readonly string[],
): string[] {
  const present = new Set<string>();
  for (const [category, components] of Object.entries(registry)) {
    if (category === DISPLAY_NAMES_CATEGORY) continue;
    if (components && typeof components === "object") {
      for (const componentType of Object.keys(components as Record<string, unknown>)) {
        present.add(componentType);
      }
    }
  }
  return keys.filter((key) => !present.has(key));
}

/**
 * Langflow's standardised wording, plus the ad-hoc messages components raise from
 * their own guarded imports. Both shapes occur — which one surfaces depends on
 * whether the component wraps its import in a try/except, so the matcher accepts
 * either.
 */
const PACKAGING_ERROR =
  /no module named|not installed in this environment|is not installed|could not import|modulenotfounderror|importerror/i;

/**
 * Whether a build error means the component's runtime package is missing.
 *
 * This is a NEGATIVE-match classifier on purpose. The probe builds with no API
 * key, so the expected error on a healthy image is a credentials error — and a
 * credentials error is a PASS on this axis: it proves the client class was
 * imported and constructed. Only the packaging signature reprove. Matching
 * positively on "looks like a credentials error" instead would have to keep four
 * different provider-specific strings in sync and would fail closed on any new
 * wording, i.e. record every provider inactive.
 */
export function isPackagingError(message: string | undefined | null): boolean {
  if (!message) return false;
  return PACKAGING_ERROR.test(message);
}

/**
 * The `inactive` reason recorded in providers.json.
 *
 * It must name the LAYER, because the operator fix differs: a missing
 * distribution is fixed by installing the vendor package (or `lfx-bundles`), a
 * missing runtime package by installing the `langchain-*` extra.
 *
 * It must also never match `BILLING_OR_QUOTA` in `tests/collect-models.spec.ts`,
 * which downgrades an inactive provider to a warning. A packaging gap is a broken
 * environment, not a transient ops state, so it has to fail the gate loud — that
 * is the whole point of #900. `probe-component-buildable.test.ts` asserts it.
 */
export function buildAxisReason(failure: BuildAxisFailure): string {
  if (failure.layer === "distribution") {
    return (
      `${BUILD_AXIS_PREFIX}component distribution not installed in this Langflow image — ` +
      `${failure.missing.join(", ")} absent from GET /api/v1/all. ` +
      `Install the provider's lfx distribution (see #1040)`
    );
  }
  return (
    `${BUILD_AXIS_PREFIX}component runtime package missing — ${failure.component} is ` +
    `exposed by the registry but fails to build: ${failure.message.split("\n")[0]}. ` +
    `Install the provider's langchain-* package`
  );
}

/**
 * Stamped on every build-axis reason so a consumer can tell WHICH axis recorded an
 * `inactive` without re-deriving it from the wording.
 */
const BUILD_AXIS_PREFIX = "build axis: ";

/**
 * Whether a providers.json `error` was written by this axis rather than the key
 * probe.
 *
 * `collect-models.spec.ts` asserts on it to cover a case the existing
 * `hardFailures` check structurally cannot: that check skips every provider whose
 * env key is unset, but a component that cannot build is a broken IMAGE — the
 * verdict does not depend on whether anyone configured a key for it. Without this
 * predicate, running with (say) no `ANTHROPIC_API_KEY` would let a genuinely
 * unbuildable Anthropic component pass the gate in silence, which is the same
 * silent-skip class #900 exists to remove.
 */
export function isBuildAxisReason(error: string | null | undefined): boolean {
  return !!error && error.startsWith(BUILD_AXIS_PREFIX);
}

// ─── I/O ──────────────────────────────────────────────────────────────────────

export interface BuildAxisResult {
  /** false only on a PROVEN packaging gap; a probe that could not run is `true`. */
  ok: boolean;
  reason?: string;
}

interface BuildVertexOutcome {
  componentKey: string;
  errorMessage: string;
}

/**
 * Strips every secret field so the build cannot make a billable call.
 *
 * Load-bearing, not hygiene: the registry template ships `api_key` as
 * `{ value: "OPENAI_API_KEY", load_from_db: true }`, so an un-neutralised probe
 * loads the global variable `collect-models` itself just saved and the default
 * `text_output` output invokes the model for real. With the key blanked, every
 * provider fails on missing credentials before any network call — measured on all
 * five components.
 */
function neutraliseSecrets(template: Record<string, unknown>): void {
  const fields = template.template as Record<string, Record<string, unknown>> | undefined;
  if (!fields) return;
  for (const field of Object.values(fields)) {
    if (field && typeof field === "object" && field._input_type === "SecretStrInput") {
      field.value = "";
      field.load_from_db = false;
      field.required = false;
    }
  }
}

/**
 * Builds every given component as a disconnected vertex of ONE throwaway flow and
 * returns the ones that failed with a packaging error.
 *
 * One flow rather than one per provider: the vertices are independent, so a single
 * create/build/delete covers all of them (~9 s measured, against ~5 round-trips
 * otherwise). The build endpoint requires a PERSISTED flow — passing `data` inline
 * against a random UUID returns `404 Flow with id ... not found` — hence the
 * create, and hence the `finally` that deletes it.
 */
async function buildComponents(
  request: APIRequestContext,
  auth: string,
  registry: Record<string, Record<string, unknown>>,
  componentKeys: string[],
): Promise<BuildVertexOutcome[]> {
  const headers = auth ? { Authorization: auth } : undefined;
  const nodeIdToKey = new Map<string, string>();
  const nodes = componentKeys.map((key, i) => {
    const template = JSON.parse(
      JSON.stringify(findTemplate(registry, key)),
    ) as Record<string, unknown>;
    neutraliseSecrets(template);
    const id = `build-probe-${i}`;
    nodeIdToKey.set(id, key);
    return {
      id,
      type: "genericNode",
      position: { x: i * 400, y: 0 },
      data: { id, type: (template.name as string) ?? key, node: template },
    };
  });

  const graph = { nodes, edges: [] };
  const created = await request.post("/api/v1/flows/", {
    headers,
    data: { name: `build-probe-${Date.now()}`, description: "collect-models build axis (#900)", data: graph },
    timeout: 30000,
  });
  if (!created.ok()) throw new Error(`flow create failed: HTTP ${created.status()}`);
  const flowId = (await created.json()).id as string;

  try {
    const started = await request.post(`/api/v1/build/${flowId}/flow?log_builds=false`, {
      headers,
      data: { data: graph },
      timeout: 30000,
    });
    if (!started.ok()) throw new Error(`build start failed: HTTP ${started.status()}`);
    const jobId = (await started.json()).job_id as string;

    // 60s against ~9s measured for all five components. Deliberately tight: this
    // runs in the daily's `Collect models` PRE-FLIGHT, which shares its Langflow
    // container with the @stable shard and has a history of wedging it (#922/#927,
    // and #1011 where an over-eager pre-flight cost the entire run). Because the
    // whole probe fails OPEN, an expired timeout degrades to "no build signal" and
    // a warning — never to a blocked pre-flight or an inactive provider — so
    // erring on the short side is the safe direction.
    const events = await request.get(`/api/v1/build/${jobId}/events`, {
      headers,
      timeout: 60000,
    });
    if (!events.ok()) throw new Error(`build events failed: HTTP ${events.status()}`);

    const outcomes: BuildVertexOutcome[] = [];
    for (const line of (await events.text()).split("\n")) {
      if (!line.trim()) continue;
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        continue; // a partial frame is not a verdict — ignore it
      }
      if (event?.event !== "end_vertex") continue;
      const buildData = event.data?.build_data;
      const key = nodeIdToKey.get(buildData?.id);
      if (!key) continue;
      for (const output of Object.values(buildData?.data?.outputs ?? {})) {
        const errorMessage = (output as any)?.message?.errorMessage;
        if (typeof errorMessage === "string" && errorMessage) {
          outcomes.push({ componentKey: key, errorMessage });
        }
      }
    }
    return outcomes;
  } finally {
    // Always — a probe must never leak a flow onto the instance under test.
    await request.delete(`/api/v1/flows/${flowId}`, { headers, timeout: 30000 }).catch(() => {});
  }
}

function findTemplate(
  registry: Record<string, Record<string, unknown>>,
  key: string,
): Record<string, unknown> {
  for (const [category, components] of Object.entries(registry)) {
    if (category === DISPLAY_NAMES_CATEGORY) continue;
    if (components && typeof components === "object" && key in components) {
      return (components as Record<string, Record<string, unknown>>)[key];
    }
  }
  throw new Error(`template not found for ${key}`);
}

/**
 * Runs both layers and returns a verdict per provider.
 *
 * FAILS OPEN on its own infrastructure. An unreachable registry, a build endpoint
 * error or a timeout returns `ok: true` for everyone and logs a warning: the gate
 * must never convert a runner-side hiccup into an `inactive` provider, which
 * would be a hard failure of collect-models plus the silent downstream skips the
 * whole mechanism exists to prevent. Same rule `readProviderHealth` (#1029) and
 * `TRANSIENT_TRANSPORT` (#1011) already encode.
 */
export async function probeBuildAxis(
  request: APIRequestContext,
  providers: readonly Provider[],
): Promise<Record<string, BuildAxisResult>> {
  const results: Record<string, BuildAxisResult> = {};
  for (const provider of providers) results[provider] = { ok: true };

  try {
    const auth = await getAuthToken(request);
    const res = await request.get("/api/v1/all", {
      headers: auth ? { Authorization: auth } : undefined,
      timeout: 30000,
    });
    if (!res.ok()) throw new Error(`registry unreachable: HTTP ${res.status()}`);
    const registry = (await res.json()) as Record<string, Record<string, unknown>>;

    // Layer 1 — catalog.
    const stillPresent: string[] = [];
    for (const provider of providers) {
      const keys = PROVIDER_COMPONENTS[provider] ?? [];
      const missing = missingComponentKeys(registry, keys);
      if (missing.length > 0) {
        results[provider] = { ok: false, reason: buildAxisReason({ layer: "distribution", missing }) };
        continue;
      }
      stillPresent.push(...keys);
    }
    if (stillPresent.length === 0) return results;

    // Layer 2 — buildability, for whatever survived layer 1.
    // Logged BEFORE the build so the step is observable even if the build hangs:
    // a probe whose success is indistinguishable from a probe that never ran is
    // the #505 class of blind spot this whole mechanism exists to remove.
    console.log(`   build axis: building ${stillPresent.length} component(s) with no API key — ${stillPresent.join(", ")}`);
    const outcomes = await buildComponents(request, auth, registry, stillPresent);
    for (const provider of providers) {
      if (!results[provider].ok) continue;
      const keys = PROVIDER_COMPONENTS[provider] ?? [];
      const broken = outcomes.find(
        (o) => keys.includes(o.componentKey) && isPackagingError(o.errorMessage),
      );
      if (broken) {
        results[provider] = {
          ok: false,
          reason: buildAxisReason({
            layer: "runtime-package",
            component: broken.componentKey,
            message: broken.errorMessage,
          }),
        };
      }
    }
  } catch (e: any) {
    console.warn(
      `⚠️  build-axis probe could not run (${e?.message ?? e}) — keeping the key-axis ` +
        `verdict for every provider. This is a fail-open by design (#900).`,
    );
    for (const provider of providers) results[provider] = { ok: true };
  }

  for (const provider of providers) {
    const r = results[provider];
    console.log(`   build axis: ${r.ok ? "✅" : "❌"} ${provider}${r.ok ? "" : ` — ${r.reason}`}`);
  }
  return results;
}
