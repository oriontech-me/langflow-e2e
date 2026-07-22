import type { APIRequestContext } from "@playwright/test";

/**
 * Helpers for the native Langflow **Knowledge Base** REST API
 * (`/api/v1/knowledge_bases`). A Knowledge Base is a persistent, Chroma-backed
 * vector store owned by the current user — it is core (bundle-free), which is
 * why RAG specs prefer it over drop-in vector-store bundles.
 *
 * A KB is an instance resource with its own lifecycle: unlike an in-memory
 * store it survives the flow that created it, so every test that creates one
 * MUST delete it in teardown (mirrors the scoped flow cleanup rationale, #515) —
 * otherwise the instance slowly accumulates orphan KBs.
 *
 * Pass a standalone `request` with an explicit Authorization header via
 * `options.headers` (`page.request` is unauthenticated under AUTO_LOGIN and
 * would 401), or `page.request` when its browser-context auth is available.
 */

const BASE = "/api/v1/knowledge_bases";

/** Total attempts (one initial call plus retries) for a transient delete 5xx. */
const MAX_DELETE_ATTEMPTS = 2;

export interface CreateKnowledgeBaseInput {
  /** Human name; Langflow slugifies it (spaces → `_`) into the `dir_name`. */
  name: string;
  /** Embedding provider, e.g. `"Google Generative AI"`. */
  embeddingProvider: string;
  /** Embedding model id, e.g. `"models/gemini-embedding-001"`. */
  embeddingModel: string;
}

/**
 * Creates a Knowledge Base and returns its `dir_name` (the slugified id used by
 * the `knowledge_base` component field and by the get/delete endpoints).
 *
 * Only the provider + model are needed — the KB stores that config and resolves
 * the embedding function (via the auto-imported provider credential) at ingest
 * time, so no `model_selection` blob is required. `backend_type` is `"chroma"`
 * (the core embedded backend).
 */
export async function createKnowledgeBase(
  request: APIRequestContext,
  input: CreateKnowledgeBaseInput,
  options?: { headers?: Record<string, string> },
): Promise<string> {
  const res = await request.post(BASE, {
    headers: options?.headers ?? {},
    data: {
      name: input.name,
      embedding_provider: input.embeddingProvider,
      embedding_model: input.embeddingModel,
      backend_type: "chroma",
    },
  });
  if (res.status() !== 201) {
    throw new Error(
      `POST ${BASE} failed: ${res.status()} — ${(await res.text()).slice(0, 200)}`,
    );
  }
  const body = (await res.json()) as { dir_name?: string };
  if (!body.dir_name) {
    throw new Error(`POST ${BASE} returned 201 with no dir_name`);
  }
  return body.dir_name;
}

export interface KnowledgeBaseInfo {
  dir_name: string;
  chunks: number;
  words: number;
  characters: number;
  embedding_model: string;
}

/**
 * Fetches a Knowledge Base's metadata — notably `chunks`, the number of indexed
 * chunks, which is the causal proof that an ingest actually embedded + indexed
 * the document.
 */
export async function getKnowledgeBase(
  request: APIRequestContext,
  dirName: string,
  options?: { headers?: Record<string, string> },
): Promise<KnowledgeBaseInfo> {
  const url = `${BASE}/${dirName}`;
  const res = await request.get(url, { headers: options?.headers ?? {} });
  if (!res.ok()) {
    throw new Error(
      `GET ${url} failed: ${res.status()} — ${(await res.text()).slice(0, 200)}`,
    );
  }
  return (await res.json()) as KnowledgeBaseInfo;
}

/**
 * Deletes a Knowledge Base, 404-tolerant (already gone IS the desired end state
 * for idempotent cleanup) and with one retry on a transient 5xx — same cleanup
 * philosophy as `deleteFlow`. A non-5xx client error surfaces immediately.
 */
export async function deleteKnowledgeBase(
  request: APIRequestContext,
  dirName: string,
  options?: { headers?: Record<string, string> },
): Promise<void> {
  const url = `${BASE}/${dirName}`;
  const isDone = (r: { ok(): boolean; status(): number }) =>
    r.ok() || r.status() === 404;

  for (let attempt = 1; attempt <= MAX_DELETE_ATTEMPTS; attempt++) {
    const res = await request.delete(url, { headers: options?.headers ?? {} });
    if (isDone(res)) return;
    if (res.status() < 500) {
      throw new Error(
        `Knowledge base cleanup failed: ${res.status()} — ${await res.text()}`,
      );
    }
    if (attempt === MAX_DELETE_ATTEMPTS) {
      throw new Error(
        `Knowledge base cleanup failed after ${MAX_DELETE_ATTEMPTS} attempts: ${res.status()} — ${await res.text()}`,
      );
    }
  }
}

/**
 * Asserts the embedding provider's API key is configured as a Langflow global
 * variable — not merely present in the process environment.
 *
 * KB ingestion resolves its embedding function from the Langflow credential:
 * `get_embedding_model_options(user_id)` is credential-gated, so with no global
 * variable for the provider the embedding model is absent from the registry and
 * ingest raises a misleading `ComponentBuildError` ("embedding model '<name>' is
 * no longer recognized"). At the UI that surfaces only as the run's
 * `node_duration` badge never rendering — a 90s `toBeVisible` timeout whose true
 * cause (a missing credential) is invisible. The env-var-only `test.skip` guard
 * does not catch this: the var can be set in `.env` while the Langflow credential
 * was never imported (e.g. `collect-models` never ran, or its provider setup
 * flaked). This precondition converts that opaque timeout into an immediate,
 * actionable failure, without masking a genuine ingest regression (if the
 * credential IS present and ingest still fails, the real assertions still fire).
 */
export async function assertEmbeddingCredentialConfigured(
  request: APIRequestContext,
  variableName: string,
  options?: { headers?: Record<string, string> },
): Promise<void> {
  const url = "/api/v1/variables/";
  const res = await request.get(url, { headers: options?.headers ?? {} });
  if (!res.ok()) {
    throw new Error(
      `GET ${url} failed: ${res.status()} — ${(await res.text()).slice(0, 200)}`,
    );
  }
  const variables = (await res.json()) as Array<{ name?: string }>;
  const names = variables.map((v) => v.name).filter(Boolean);
  if (!names.includes(variableName)) {
    throw new Error(
      `Embedding credential '${variableName}' is set in the environment but is NOT ` +
        `configured as a Langflow global variable (present: ${names.join(", ") || "none"}). ` +
        `Knowledge Base ingestion resolves embeddings from the Langflow credential, not the ` +
        `env var, so ingest would fail with a misleading "embedding model no longer recognized" ` +
        `error (a 90s node_duration timeout at the UI). Run ` +
        `\`npx playwright test tests/collect-models.spec.ts\` first to import the credential ` +
        `(the daily-stable CI does this automatically).`,
    );
  }
}
