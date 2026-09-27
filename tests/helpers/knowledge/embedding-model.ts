import type { APIRequestContext } from "@playwright/test";

/**
 * Enablement of one embeddings model in `/api/v1/models/enabled_models`.
 *
 * A configured provider key does NOT enable its embeddings models: every one ships
 * disabled, and the Embedding Model pickers (Create Knowledge Base, Create Memory)
 * list from this map, not from `GET /api/v1/models` (measured on 1.12.0.dev22 and
 * 1.13.0.dev22). A spec that drives a picker enables the model BEFORE the page loads
 * — the frontend caches the list — and restores the previous flag afterwards.
 *
 * The POST merges into the user's own enabled/disabled lists rather than replacing
 * the map, so it cannot disturb another worker's enablement.
 */

const URL = "/api/v1/models/enabled_models";

export interface EmbeddingModelRef {
  /** Provider as `enabled_models` keys it, e.g. `OpenAI`. */
  provider: string;
  modelId: string;
}

export async function isEmbeddingModelEnabled(
  request: APIRequestContext,
  model: EmbeddingModelRef,
  options?: { headers?: Record<string, string> },
): Promise<boolean> {
  const res = await request.get(URL, { headers: options?.headers ?? {} });
  if (res.status() !== 200) {
    throw new Error(`GET ${URL} failed: ${res.status()} — ${(await res.text()).slice(0, 200)}`);
  }
  const body = (await res.json()) as {
    enabled_models?: Record<string, Record<string, boolean>>;
  };
  return body.enabled_models?.[model.provider]?.[model.modelId] === true;
}

export async function setEmbeddingModelEnabled(
  request: APIRequestContext,
  model: EmbeddingModelRef,
  enabled: boolean,
  options?: { headers?: Record<string, string> },
): Promise<void> {
  const res = await request.post(URL, {
    headers: options?.headers ?? {},
    data: [
      { provider: model.provider, model_id: model.modelId, enabled, model_type: "embeddings" },
    ],
  });
  if (res.status() !== 200) {
    throw new Error(
      `POST ${URL} (${model.modelId} -> ${enabled}) failed: ${res.status()} — ` +
        `${(await res.text()).slice(0, 200)}`,
    );
  }
}
