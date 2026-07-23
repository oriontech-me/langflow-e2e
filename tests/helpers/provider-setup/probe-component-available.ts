import type { APIRequestContext } from "@playwright/test";
import { getAuthToken } from "../auth/get-auth-token";

// Probe whether a provider's component is actually EXPOSED by the running
// Langflow build — a build-side check, distinct from the provider specs' cloud
// API probe (which only validates the key). On 1.12.x Langflow HIDES a
// component from the sidebar (and drops it from the component registry) when its
// runtime langchain package is missing: the nightly image stopped bundling
// `langchain-groq` / `langchain-mistralai`, so the Groq/MistralAI components
// vanish and the provider specs' `waitForSelector('[data-testid="groqGroq"]')`
// hard-fails after 30s (#907, upstream LE-1987). This probe converts that deep,
// misleading timeout into an explicit skip: "component not in this build".
//
// Signal: GET /api/v1/all returns the component registry as
// `{ category: { ComponentType: {...template...} } }`. We inspect the
// second-level COMPONENT-TYPE keys only (never nested field names), so a field
// like `ollama_base_url` on the unified Language Model does not false-positive
// the Ollama component. A provider whose langchain package is installed exposes
// a matching type (e.g. `ext:openai:OpenAIModelComponent@official`); a missing
// package leaves NO matching type key.
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
