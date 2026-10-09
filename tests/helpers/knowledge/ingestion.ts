import type { APIRequestContext } from "@playwright/test";
import { retryOnDroppedConnection } from "../api/retry-on-dropped-connection";
import type { FolderAttempt } from "./folder-source";

/**
 * Helpers for the knowledge-base **ingestion** surface (`/api/v1/knowledge_bases`,
 * #2043): chunk preview, file and connector ingestion, the chunks written, the
 * ingestion runs and their cancellation. Creation and deletion stay in
 * `knowledge-base.ts`.
 *
 * None of these routes is in `/openapi.json` (the router is
 * `include_in_schema=False`); every shape below was measured on 1.13.0.dev22.
 * Pass the test-scoped `request` fixture with an explicit Authorization header so
 * the API-coverage recorder sees the calls.
 *
 * The READS re-dial once on a dropped connection (`retryOnDroppedConnection`): the
 * first read after a UI step reuses a socket the server closed while the page was
 * busy, and throws `socket hang up` (measured once in five runs of the UI test,
 * #2043; the 2 s keep-alive race recorded for #1810/#1855). Only a thrown request is
 * retried, never a response, and never a POST — a POST that reached the server
 * would be issued twice.
 */

const BASE = "/api/v1/knowledge_bases";

type Headers = { headers?: Record<string, string> };

export interface ChunkSettings {
  chunkSize: number;
  chunkOverlap: number;
  /** Sent as typed; the frontend's default is the two characters `\n`. */
  separator: string;
}

export interface TextFile {
  name: string;
  content: string;
}

function filePart(file: TextFile) {
  return {
    name: file.name,
    mimeType: "text/plain",
    buffer: Buffer.from(file.content, "utf8"),
  };
}

async function fail(res: { status(): number; text(): Promise<string> }, what: string): Promise<never> {
  throw new Error(`${what} failed: ${res.status()} — ${(await res.text()).slice(0, 300)}`);
}

export interface PreviewChunk {
  content: string;
  index: number;
  char_count: number;
  start: number;
  end: number;
}

/**
 * `POST /preview-chunks` for one file. Returns the previewed chunks — at most
 * `maxChunks` of them, from at most `maxChunks * chunkSize * 3` characters of text
 * (the server's `CHUNK_PREVIEW_MULTIPLIER`), so a caller comparing them with a full
 * ingestion must keep the document inside both bounds.
 */
export async function previewChunks(
  request: APIRequestContext,
  file: TextFile,
  settings: ChunkSettings & { maxChunks: number },
  options?: Headers,
): Promise<PreviewChunk[]> {
  const url = `${BASE}/preview-chunks`;
  const res = await request.post(url, {
    headers: options?.headers ?? {},
    multipart: {
      files: filePart(file),
      chunk_size: String(settings.chunkSize),
      chunk_overlap: String(settings.chunkOverlap),
      separator: settings.separator,
      max_chunks: String(settings.maxChunks),
    },
  });
  if (res.status() !== 200) return fail(res, `POST ${url}`);
  const body = (await res.json()) as { files?: Array<{ preview_chunks?: PreviewChunk[] }> };
  const chunks = body.files?.[0]?.preview_chunks;
  if (!Array.isArray(chunks)) {
    throw new Error(`POST ${url} answered 200 with no files[0].preview_chunks`);
  }
  return chunks;
}

/**
 * `POST /{kb}/ingest` with uploaded files. The ingestion runs in the background;
 * the returned id is both the job id and the ingestion run id.
 */
export async function ingestFiles(
  request: APIRequestContext,
  dirName: string,
  file: TextFile,
  settings: ChunkSettings,
  options?: Headers,
): Promise<string> {
  const url = `${BASE}/${dirName}/ingest`;
  const res = await request.post(url, {
    headers: options?.headers ?? {},
    multipart: {
      files: filePart(file),
      chunk_size: String(settings.chunkSize),
      chunk_overlap: String(settings.chunkOverlap),
      separator: settings.separator,
    },
  });
  if (res.status() !== 200) return fail(res, `POST ${url}`);
  const { id } = (await res.json()) as { id?: string };
  if (!id) throw new Error(`POST ${url} answered 200 with no run id`);
  return id;
}

/**
 * `POST /{kb}/ingest/connector` with the `folder` source. Returns the raw answer
 * rather than throwing on a refusal, because a refusal is how the allow-list is
 * read (`folder-source.ts`).
 */
export async function ingestFolderViaConnector(
  request: APIRequestContext,
  dirName: string,
  sourceConfig: { path: string; recursive?: boolean; extensions?: string[] },
  settings: Omit<ChunkSettings, "separator"> & { separator?: string },
  options?: Headers,
): Promise<FolderAttempt> {
  const res = await request.post(`${BASE}/${dirName}/ingest/connector`, {
    headers: options?.headers ?? {},
    data: {
      source_type: "folder",
      source_config: sourceConfig,
      chunk_size: settings.chunkSize,
      chunk_overlap: settings.chunkOverlap,
      separator: settings.separator ?? "",
    },
  });
  const text = await res.text();
  let body: { id?: string; detail?: unknown } = {};
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    body = { detail: text };
  }
  return { status: res.status(), detail: body.detail, runId: body.id };
}

export interface StoredChunk {
  id: string;
  content: string;
  char_count: number;
  metadata: {
    chunk_index?: number;
    file_name?: string;
    job_id?: string;
    source_type?: string;
    [key: string]: unknown;
  };
}

/**
 * Every chunk `GET /{kb}/chunks` returns for the given filters, all pages read,
 * sorted by `(file_name, chunk_index)` — the order a chunk was cut in, which the
 * endpoint itself does not guarantee.
 */
export async function listAllChunks(
  request: APIRequestContext,
  dirName: string,
  filters: { jobId?: string; sourceType?: string } = {},
  options?: Headers,
): Promise<{ total: number; chunks: StoredChunk[] }> {
  const chunks: StoredChunk[] = [];
  let total = 0;
  for (let page = 1; ; page++) {
    const params = new URLSearchParams({ page: String(page), limit: "100" });
    if (filters.jobId) params.set("job_id", filters.jobId);
    if (filters.sourceType) params.set("source_type", filters.sourceType);
    const url = `${BASE}/${dirName}/chunks?${params.toString()}`;
    const res = await retryOnDroppedConnection(() =>
      request.get(url, { headers: options?.headers ?? {} }),
    );
    if (res.status() !== 200) return fail(res, `GET ${url}`);
    const body = (await res.json()) as {
      chunks: StoredChunk[];
      total: number;
      total_pages: number;
    };
    chunks.push(...body.chunks);
    total = body.total;
    if (page >= body.total_pages) break;
  }
  chunks.sort(
    (a, b) =>
      String(a.metadata.file_name).localeCompare(String(b.metadata.file_name)) ||
      Number(a.metadata.chunk_index) - Number(b.metadata.chunk_index),
  );
  return { total, chunks };
}

export interface IngestionRun {
  id: string;
  kb_name: string;
  job_id: string | null;
  source_type: string;
  status: string;
  error_message: string | null;
  total_items: number;
  succeeded: number;
  failed: number;
  skipped: number;
  chunks_created: number;
  started_at: string | null;
  finished_at: string | null;
  items?: Array<{
    item_id: string;
    display_name: string;
    status: string;
    chunks_created: number;
    error_message: string | null;
  }>;
}

/** `GET /{kb}/runs` — the first page, newest first. */
export async function listRuns(
  request: APIRequestContext,
  dirName: string,
  options?: Headers,
): Promise<IngestionRun[]> {
  const url = `${BASE}/${dirName}/runs`;
  const res = await retryOnDroppedConnection(() =>
    request.get(url, { headers: options?.headers ?? {} }),
  );
  if (res.status() !== 200) return fail(res, `GET ${url}`);
  return ((await res.json()) as { runs: IngestionRun[] }).runs;
}

/**
 * `GET /{kb}/runs/{id}`, or `null` while the run is not visible yet: the job row
 * exists as soon as the ingest call returns, but the run's `kb_name` is seeded by
 * the background task, and until then the route answers 404.
 */
export async function getRun(
  request: APIRequestContext,
  dirName: string,
  runId: string,
  options?: Headers,
): Promise<IngestionRun | null> {
  const url = `${BASE}/${dirName}/runs/${runId}`;
  const res = await retryOnDroppedConnection(() =>
    request.get(url, { headers: options?.headers ?? {} }),
  );
  if (res.status() === 404) return null;
  if (res.status() !== 200) return fail(res, `GET ${url}`);
  return (await res.json()) as IngestionRun;
}

export const TERMINAL_RUN_STATUSES = ["succeeded", "partial", "failed", "cancelled"];

/**
 * How long a run may report a terminal status with `finished_at` still null.
 *
 * The two fields have different writers: `finalize_run` puts the terminal status in
 * the job's metadata from `perform_ingestion`'s `finally`, while `finished_at` is
 * projected from the job row's `finished_timestamp`, which `execute_with_status`
 * writes only after `perform_ingestion` has returned. Measured on 1.13.0.dev22: the
 * gap is ~70 ms, and a 20 ms poll landed in it 2 times out of 3. The budget is ~70x
 * that, so a run whose `finished_at` NEVER appears still fails, by name.
 */
export const FINISHED_AT_GRACE_MS = 5_000;

/**
 * Polls `GET /{kb}/runs/{id}` until the run has SETTLED — a terminal status and a
 * `finished_at` — and returns it. Throws naming the last status seen when the budget
 * runs out, and naming the missing timestamp when a terminal run does not get one
 * within `FINISHED_AT_GRACE_MS`.
 */
export async function waitForRunToFinish(
  request: APIRequestContext,
  dirName: string,
  runId: string,
  options?: Headers & { timeoutMs?: number },
): Promise<IngestionRun> {
  const deadline = Date.now() + (options?.timeoutMs ?? 120_000);
  let last: IngestionRun | null = null;
  let terminalSince: number | null = null;
  while (Date.now() < deadline) {
    last = await getRun(request, dirName, runId, options);
    if (last && TERMINAL_RUN_STATUSES.includes(last.status)) {
      if (last.finished_at) return last;
      terminalSince ??= Date.now();
      if (Date.now() - terminalSince > FINISHED_AT_GRACE_MS) {
        throw new Error(
          `Ingestion run ${runId} reports '${last.status}' but its finished_at stayed null ` +
            `for ${FINISHED_AT_GRACE_MS} ms`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      continue;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `Ingestion run ${runId} did not finish within ${options?.timeoutMs ?? 120_000} ms ` +
      `(last status: ${last ? last.status : "not visible yet"})`,
  );
}

/** `POST /{kb}/cancel` — raw, so a caller can assert the status and message. */
export async function cancelIngestion(
  request: APIRequestContext,
  dirName: string,
  options?: Headers,
): Promise<{ status: number; body: { message?: string; detail?: string } }> {
  const res = await request.post(`${BASE}/${dirName}/cancel`, {
    headers: options?.headers ?? {},
  });
  return { status: res.status(), body: (await res.json()) as { message?: string; detail?: string } };
}

/** The chunking a knowledge base's row records after an ingestion. */
export async function getChunkingSettings(
  request: APIRequestContext,
  dirName: string,
  options?: Headers,
): Promise<{ chunks: number; chunk_size: number | null; chunk_overlap: number | null; separator: string | null }> {
  const url = `${BASE}/${dirName}`;
  const res = await retryOnDroppedConnection(() =>
    request.get(url, { headers: options?.headers ?? {} }),
  );
  if (res.status() !== 200) return fail(res, `GET ${url}`);
  return (await res.json()) as {
    chunks: number;
    chunk_size: number | null;
    chunk_overlap: number | null;
    separator: string | null;
  };
}
