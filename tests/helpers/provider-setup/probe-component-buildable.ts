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

/** One component's outcome. `unknown` means the probe could not reach a verdict. */
export interface ComponentVerdict {
  key: string;
  state: "ok" | "packaging" | "unknown";
  message?: string;
}

export interface ProviderVerdict {
  state: "ok" | "failed" | "unknown";
  /** Only set for `failed` — this is what lands in providers.json. */
  reason?: string;
}

/**
 * Folds a provider's per-component outcomes into one verdict.
 *
 * `unknown` is a first-class state, NOT a synonym for ok. On PR #1051's first CI
 * run the probe timed out and still logged `✅` for all three providers, because
 * fail-open and real success produced identical output — the exact blind spot this
 * issue exists to remove, reintroduced one layer up. An unproven component now
 * reads as unproven everywhere: in the log, and by being excluded from the
 * `build axis: ` stamp so it can never reach providers.json as an inactive reason.
 *
 * A proven packaging failure outranks an unknown: one component we could not probe
 * does not make another component's hard evidence go away.
 */
export function aggregateVerdict(verdicts: ComponentVerdict[]): ProviderVerdict {
  const broken = verdicts.find((v) => v.state === "packaging");
  if (broken) {
    return {
      state: "failed",
      reason: buildAxisReason({
        layer: "runtime-package",
        component: broken.key,
        message: broken.message ?? "no error message recorded",
      }),
    };
  }
  const unproven = verdicts.filter((v) => v.state === "unknown");
  if (unproven.length > 0) {
    return {
      state: "unknown",
      reason:
        `not proven — ${unproven.length} component(s) could not be built within the ` +
        `probe budget: ${unproven.map((v) => `${v.key} (${v.message ?? "no detail"})`).join(", ")}`,
    };
  }
  return { state: "ok" };
}

// ─── I/O ──────────────────────────────────────────────────────────────────────

/**
 * Per-component build budget. Measured on 1.12.0.dev8: an isolated component
 * builds in 0.9–3.3 s, so 20 s is ~6× the slowest.
 *
 * Deliberately PER COMPONENT rather than one budget for the batch. On PR #1051's
 * first CI run all five were built in a single request; it exceeded the budget and
 * the whole axis fell back to fail-open, yielding no signal about any provider.
 * Isolated builds bound the damage to the component that is actually slow and
 * still return real verdicts for the rest — and the log then NAMES the slow one,
 * which a batched probe cannot do.
 */
const BUILD_TIMEOUT_MS = 20000;

/** Ceiling for the whole axis, so a systematically slow backend cannot hold the run. */
const TOTAL_BUDGET_MS = 90000;

const HTTP_TIMEOUT_MS = 20000;

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
 * Builds ONE component and classifies the outcome.
 *
 * `stop_component_id` restricts the build to that single vertex — verified on
 * 1.12.0.dev8, where each call emitted exactly one `end_vertex` for the requested
 * node. On timeout the job is CANCELLED: without that, the client stops waiting
 * while the server keeps building, which is what wedged the backend on PR #1051's
 * first CI run (gunicorn `WORKER TIMEOUT`, then a 120 s unreachable backend for
 * the next step). Stopping waiting and stopping working must be the same act.
 */
async function buildOne(
  request: APIRequestContext,
  headers: Record<string, string> | undefined,
  flowId: string,
  graph: unknown,
  nodeId: string,
  key: string,
): Promise<ComponentVerdict> {
  let jobId: string | undefined;
  try {
    const started = await request.post(
      `/api/v1/build/${flowId}/flow?log_builds=false&stop_component_id=${nodeId}`,
      { headers, data: { data: graph }, timeout: HTTP_TIMEOUT_MS },
    );
    if (!started.ok()) return { key, state: "unknown", message: `build start HTTP ${started.status()}` };
    jobId = (await started.json()).job_id as string;

    const events = await request.get(`/api/v1/build/${jobId}/events`, {
      headers,
      timeout: BUILD_TIMEOUT_MS,
    });
    if (!events.ok()) return { key, state: "unknown", message: `events HTTP ${events.status()}` };

    for (const line of (await events.text()).split("\n")) {
      if (!line.trim()) continue;
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        continue; // a partial frame is not a verdict
      }
      if (event?.event !== "end_vertex") continue;
      for (const output of Object.values(event.data?.build_data?.data?.outputs ?? {})) {
        const errorMessage = (output as any)?.message?.errorMessage;
        if (typeof errorMessage === "string" && isPackagingError(errorMessage)) {
          return { key, state: "packaging", message: errorMessage };
        }
      }
    }
    // Built, or failed for a reason that is NOT packaging (a credentials error is
    // the expected shape here and PROVES the client class was constructed).
    return { key, state: "ok" };
  } catch (e: any) {
    if (jobId) {
      // Best-effort: stop the server-side work we just abandoned.
      await request
        .post(`/api/v1/build/${jobId}/cancel`, { headers, timeout: 10000 })
        .catch(() => {});
    }
    return { key, state: "unknown", message: e?.message?.split("\n")[0] ?? String(e) };
  }
}

/**
 * Runs both layers and returns a verdict per provider.
 *
 * FAILS OPEN on its own infrastructure — but never SILENTLY. An unreachable
 * registry or an unbuildable-within-budget component yields `unknown`, which is
 * logged as `⚠️` and never written to providers.json: the gate must not convert a
 * runner-side hiccup into an `inactive` provider, and it must not report an
 * unproven component as proven either. Reporting `✅` on fail-open is exactly what
 * PR #1051's first CI run did, and it made a timed-out probe indistinguishable
 * from a passing one.
 */
export async function probeBuildAxis(
  request: APIRequestContext,
  providers: readonly Provider[],
): Promise<Record<string, ProviderVerdict>> {
  const results: Record<string, ProviderVerdict> = {};
  const started = Date.now();
  let flowId: string | undefined;
  const headers: Record<string, string> | undefined = undefined;

  try {
    const auth = await getAuthToken(request);
    const authHeaders = auth ? { Authorization: auth } : undefined;
    const res = await request.get("/api/v1/all", {
      headers: authHeaders,
      timeout: HTTP_TIMEOUT_MS,
    });
    if (!res.ok()) throw new Error(`registry unreachable: HTTP ${res.status()}`);
    const registry = (await res.json()) as Record<string, Record<string, unknown>>;

    // Layer 1 — catalog. One request, every provider.
    const toBuild: { provider: Provider; key: string; nodeId: string }[] = [];
    for (const provider of providers) {
      const keys = PROVIDER_COMPONENTS[provider] ?? [];
      const missing = missingComponentKeys(registry, keys);
      if (missing.length > 0) {
        results[provider] = {
          state: "failed",
          reason: buildAxisReason({ layer: "distribution", missing }),
        };
        continue;
      }
      for (const key of keys) {
        toBuild.push({ provider, key, nodeId: `build-probe-${toBuild.length}` });
      }
    }
    if (toBuild.length === 0) return results;

    // Layer 2 — buildability. ONE flow holds every surviving component as a
    // disconnected vertex; `stop_component_id` then builds them one at a time.
    const nodes = toBuild.map(({ key, nodeId }) => {
      const template = JSON.parse(JSON.stringify(findTemplate(registry, key))) as Record<string, unknown>;
      neutraliseSecrets(template);
      return {
        id: nodeId,
        type: "genericNode",
        position: { x: 0, y: 0 },
        data: { id: nodeId, type: (template.name as string) ?? key, node: template },
      };
    });
    const graph = { nodes, edges: [] };

    const created = await request.post("/api/v1/flows/", {
      headers: authHeaders,
      data: {
        name: `build-probe-${Date.now()}`,
        description: "collect-models build axis (#900)",
        data: graph,
      },
      timeout: HTTP_TIMEOUT_MS,
    });
    if (!created.ok()) throw new Error(`flow create failed: HTTP ${created.status()}`);
    flowId = (await created.json()).id as string;

    const verdicts = new Map<Provider, ComponentVerdict[]>();
    for (const { provider, key, nodeId } of toBuild) {
      const verdict =
        Date.now() - started > TOTAL_BUDGET_MS
          ? ({ key, state: "unknown", message: "total probe budget exhausted" } as ComponentVerdict)
          : await buildOne(request, authHeaders, flowId, graph, nodeId, key);
      const list = verdicts.get(provider) ?? [];
      list.push(verdict);
      verdicts.set(provider, list);
    }
    for (const [provider, list] of verdicts) results[provider] = aggregateVerdict(list);
  } catch (e: any) {
    const message = e?.message?.split("\n")[0] ?? String(e);
    for (const provider of providers) {
      results[provider] ??= { state: "unknown", reason: `probe could not run — ${message}` };
    }
  } finally {
    if (flowId) {
      // Always — a probe must never leak a flow onto the instance under test.
      await request.delete(`/api/v1/flows/${flowId}`, { headers, timeout: HTTP_TIMEOUT_MS }).catch(() => {});
    }
  }

  for (const provider of providers) {
    const r = (results[provider] ??= { state: "unknown", reason: "probe produced no verdict" });
    const icon = r.state === "ok" ? "✅" : r.state === "failed" ? "❌" : "⚠️";
    console.log(
      `   build axis: ${icon} ${provider}${r.state === "ok" ? "" : ` — ${r.reason}`}` +
        (r.state === "unknown" ? " [NOT PROVEN — this run gives no build signal for it]" : ""),
    );
  }
  return results;
}
