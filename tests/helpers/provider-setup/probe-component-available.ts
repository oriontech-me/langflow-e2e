import type { APIRequestContext } from "@playwright/test";
import { getAuthToken } from "../auth/get-auth-token";

// Probe whether a provider's component is actually EXPOSED by the running
// Langflow build — a build-side check, distinct from the provider specs' cloud
// API probe (which only validates the key). A component absent from the build
// makes the provider specs' `waitForSelector('[data-testid="groqGroq"]')`
// hard-fail after 30s; this probe converts that deep, misleading timeout into
// an explicit skip: "component not in this build".
//
// WHY a component can be absent — TWO independent gates, measured on
// 1.12.0.dev8 (#1039):
//
//   1. DISTRIBUTION. 1.12 moved most component families out of
//      `lfx.components.*` into separate per-vendor distributions (`lfx_openai`,
//      `lfx_anthropic`, `lfx_google`, `lfx_ollama`, …) plus an aggregate
//      `lfx-bundles` package. The default nightly installs ~20 vendor
//      distributions and NO `lfx-bundles`, so the whole Groq and Mistral
//      families are absent from the registry. Migration watch: #1040.
//   2. RUNTIME PACKAGE. With the distribution installed, a component is still
//      hidden when its `langchain-*` package is missing — the #907 / LE-1987
//      mechanism, still operative. Installing `lfx-bundles` alone leaves the
//      `mistral` category present but EMPTY; `langchain-mistralai` is what
//      makes `ext:mistral:MistralAIModelComponent@official` appear.
//
// The two gates do not behave identically, and that is the trap: with
// `lfx-bundles` installed but `langchain-groq` missing, the Groq component IS
// exposed in the registry and still fails at run time with
// `ComponentBuildError: Error building Component Groq: langchain-groq is not
// installed`. So a registry hit does NOT prove the component can build — this
// probe answers "is it placeable on the canvas", not "will it run" (#900).
//
// Signal: GET /api/v1/all returns the component registry as
// `{ category: { ComponentType: {...template...} } }`. We inspect the
// second-level COMPONENT-TYPE keys only (never nested field names), so a field
// like `ollama_base_url` on the unified Language Model does not false-positive
// the Ollama component. A provider whose distribution is installed exposes a
// matching type (e.g. `ext:openai:OpenAIModelComponent@official`); an absent
// distribution leaves NO matching type key.
//
// KNOWN LIMITATION: the match is a substring, so a short token can hit a
// neighbouring component type (`openai` also matches `OpenAI Compatible`). Fine
// for the current callers, whose tokens (`groq`, `mistral`) are unambiguous.
// Lifting this probe into the `collect-models` gate needs an explicit
// provider -> component-key map instead (#900).
export async function isProviderComponentAvailable(
  request: APIRequestContext,
  providerToken: string,
): Promise<boolean> {
  const token = providerToken.toLowerCase();
  try {
    const auth = await getAuthToken(request);
    const res = await request.get("/api/v1/all", {
      headers: auth ? { Authorization: auth } : undefined,
      timeout: 15000,
    });
    if (!res.ok()) return false;
    const registry = (await res.json()) as Record<string, unknown>;
    for (const comps of Object.values(registry)) {
      if (comps && typeof comps === "object") {
        for (const componentType of Object.keys(comps as Record<string, unknown>)) {
          if (componentType.toLowerCase().includes(token)) return true;
        }
      }
    }
    return false;
  } catch {
    // Treat an unreachable/erroring registry as "not available" — the caller
    // skips with a clear reason rather than proceeding into a 30s UI timeout.
    return false;
  }
}
