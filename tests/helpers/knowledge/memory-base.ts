import type { APIRequestContext } from "@playwright/test";

/**
 * Helpers for the Memory Base API (`/api/v1/memories`).
 *
 * Registering a Memory Base creates the knowledge base it manages, named by the
 * server `<sanitized name>_<8 hex>` and returned as `kb_name`; that knowledge base
 * is marked `source_types: ["memory"]`, which is what the association guard on the
 * generic `/api/v1/knowledge_bases/{kb}` routes reads (#2044). Registration needs
 * no provider: the embedding model is only a name until something is ingested.
 *
 * Deleting the Memory Base deletes its knowledge base too (measured on
 * 1.13.0.dev28: `DELETE /memories/{id}` → 204, then `GET /knowledge_bases/{kb}` →
 * 404), which is the only way to remove it — the generic delete routes refuse it.
 */

const BASE = "/api/v1/memories";

type Headers = { headers?: Record<string, string> };

export interface MemoryBaseRecord {
  id: string;
  name: string;
  flow_id: string;
  kb_name: string;
  embedding_model: string;
}

export async function registerMemoryBase(
  request: APIRequestContext,
  input: { name: string; flowId: string; embeddingModel: string },
  options?: Headers,
): Promise<MemoryBaseRecord> {
  const res = await request.post(BASE, {
    headers: options?.headers ?? {},
    data: { name: input.name, flow_id: input.flowId, embedding_model: input.embeddingModel, threshold: 1 },
  });
  if (res.status() !== 201) {
    throw new Error(`POST ${BASE} failed: ${res.status()} — ${(await res.text()).slice(0, 200)}`);
  }
  const body = (await res.json()) as MemoryBaseRecord;
  if (!body.id || !body.kb_name) {
    throw new Error(`POST ${BASE} answered 201 without an id or kb_name: ${JSON.stringify(body).slice(0, 200)}`);
  }
  return body;
}

export async function listMemoryBases(
  request: APIRequestContext,
  flowId: string,
  options?: Headers,
): Promise<MemoryBaseRecord[]> {
  const url = `${BASE}?flow_id=${flowId}&page=1&size=50`;
  const res = await request.get(url, { headers: options?.headers ?? {} });
  if (res.status() !== 200) {
    throw new Error(`GET ${url} failed: ${res.status()} — ${(await res.text()).slice(0, 200)}`);
  }
  return ((await res.json()) as { items: MemoryBaseRecord[] }).items;
}

/** 404-tolerant: already gone is the end state a cleanup wants. */
export async function deleteMemoryBase(
  request: APIRequestContext,
  id: string,
  options?: Headers,
): Promise<void> {
  const url = `${BASE}/${id}`;
  const res = await request.delete(url, { headers: options?.headers ?? {} });
  if (res.status() !== 204 && res.status() !== 404) {
    throw new Error(`DELETE ${url} failed: ${res.status()} — ${(await res.text()).slice(0, 200)}`);
  }
}
