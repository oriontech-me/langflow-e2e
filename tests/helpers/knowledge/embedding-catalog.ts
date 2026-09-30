import type { APIRequestContext } from "@playwright/test";

/**
 * The embedding-model catalog the Create Knowledge Base dialog lists from (#2044).
 *
 * Opening the dialog fires `GET /api/v1/models?purpose=use` (and
 * `GET /api/v1/models/enabled_models?purpose=use`, which only decides what is
 * enabled) — measured on 1.13.0.dev28. The listing leaves out models the catalog
 * flags `deprecated` unless `include_deprecated=true` is passed, which the page
 * does on load and the dialog does not.
 */

const URL = "/api/v1/models";

export interface EmbeddingCatalogRow {
  /** Provider as the catalog names it, e.g. `Google Generative AI`. */
  provider: string;
  model: string;
  deprecated: boolean;
}

interface ProviderEntry {
  provider?: unknown;
  models?: Array<{ model_name?: unknown; metadata?: { model_type?: unknown; deprecated?: unknown } }>;
}

/** The embeddings models of a `GET /api/v1/models` body, one row per model. */
export function parseEmbeddingCatalog(body: unknown): EmbeddingCatalogRow[] {
  if (!Array.isArray(body)) {
    throw new Error(`GET ${URL} answered a body that is not a provider list: ${JSON.stringify(body)?.slice(0, 200)}`);
  }
  const rows: EmbeddingCatalogRow[] = [];
  for (const entry of body as ProviderEntry[]) {
    for (const model of entry.models ?? []) {
      if (model.metadata?.model_type !== "embeddings") continue;
      rows.push({
        provider: String(entry.provider),
        model: String(model.model_name),
        deprecated: model.metadata.deprecated === true,
      });
    }
  }
  return rows;
}

/**
 * The first of `models` that no tag in `servedTags` serves. A tag serves a model
 * when it is the model's name or the name followed by `:<tag>` — Ollama's own
 * naming (`all-minilm:latest`). Counting every `:<tag>` variant as served can only
 * skip a candidate, never pick one the server might answer for.
 */
export function firstUnservedModel(models: readonly string[], servedTags: readonly string[]): string | undefined {
  return models.find((model) => !servedTags.some((tag) => tag === model || tag.startsWith(`${model}:`)));
}

/** Reads the catalog exactly as the dialog asks for it, or with deprecated models included. */
export async function readEmbeddingCatalog(
  request: APIRequestContext,
  options: { includeDeprecated?: boolean; headers?: Record<string, string> } = {},
): Promise<EmbeddingCatalogRow[]> {
  const params = new URLSearchParams();
  if (options.includeDeprecated) params.set("include_deprecated", "true");
  params.set("purpose", "use");
  const url = `${URL}?${params.toString()}`;
  const res = await request.get(url, { headers: options.headers ?? {} });
  if (res.status() !== 200) {
    throw new Error(`GET ${url} failed: ${res.status()} — ${(await res.text()).slice(0, 200)}`);
  }
  return parseEmbeddingCatalog(await res.json());
}
