// The model list the Langflow Assistant's selector should render for a provider (#1810).
//
// The panel never calls `GET /api/v1/agentic/check-config`. Its model state comes from
// two flow-scoped reads, `GET /api/v1/models?flow_id=<id>&purpose=use` and
// `GET /api/v1/models/enabled_models?flow_id=<id>&purpose=use` (both measured on
// 1.13.0.dev12), joined in the frontend's `useEnabledModels`:
//
//   providers.filter(p => p.is_enabled)
//     .models.filter(m => m.metadata?.model_type === "llm" &&
//                         isModelEnabledForType(enabled, p.provider, m.model_name, "llm"))
//
// and `isModelEnabledForType` treats a provider's TYPED map as authoritative for every
// model type once it exists, falling back to the flat `enabled_models` map only for a
// provider that has no typed map at all. This module restates that join so a spec can
// compare the rendered selector with the list the panel's own inputs imply.
//
// Upstream: src/frontend/src/components/core/assistantPanel/hooks/use-enabled-models.ts
//           src/frontend/src/controllers/API/helpers/enabled-model-policy.ts

/** One entry of `GET /api/v1/models`, narrowed to what the join reads. */
export interface CatalogProviderEntry {
  provider: string;
  is_enabled?: boolean;
  models?: ReadonlyArray<{ model_name?: string; metadata?: { model_type?: string } }>;
}

/** `GET /api/v1/models/enabled_models`, narrowed to what the join reads. */
export interface EnabledModelsResponse {
  enabled_models?: Record<string, Record<string, boolean>>;
  enabled_models_by_type?: Record<string, Partial<Record<string, Record<string, boolean>>>>;
}

function isEnabledLlm(enabled: EnabledModelsResponse, provider: string, model: string): boolean {
  const typed = enabled.enabled_models_by_type?.[provider];
  if (typed !== undefined) return typed.llm?.[model] === true;
  return enabled.enabled_models?.[provider]?.[model] === true;
}

/** The LLM names the Assistant's selector lists under `provider`, in catalog order. */
export function assistantSelectorModels(
  providers: readonly CatalogProviderEntry[],
  enabled: EnabledModelsResponse,
  provider: string,
): string[] {
  const entry = providers.find((p) => p.provider === provider);
  if (!entry?.is_enabled) return [];
  return (entry.models ?? [])
    .filter((m) => m.metadata?.model_type === "llm")
    .map((m) => m.model_name ?? "")
    .filter((name) => name !== "" && isEnabledLlm(enabled, provider, name));
}
