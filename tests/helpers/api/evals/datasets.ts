import type { APIRequestContext } from "@playwright/test";

/**
 * Datasets — the input of every evaluation (Langflow 1.14, upstream #15999).
 *
 * Shared by the evals family: `api/evals/api-datasets.spec.ts` drives the API, and the
 * evaluations (#2564) and UI (#2565) specs seed their datasets through it. Contract and
 * measurements: `docs/api/evals/api-datasets.md`.
 *
 * Every function throws with the status and the body on an unexpected answer instead of
 * calling `expect`: a helper's `expect` message is dropped outside the test runner, so a
 * failing seed would otherwise read as a bare "expected 201".
 */

export const DATASETS = "/api/v1/datasets";

export interface DatasetRead {
  id: string;
  name: string;
  description: string | null;
  revision: number;
  item_count: number;
  created_at: string;
  updated_at: string;
}

/** The exact key set of a `DatasetRead`, sorted — measured on `1.14.0.dev38`. */
export const DATASET_KEYS = ["created_at", "description", "id", "item_count", "name", "revision", "updated_at"];

export interface DatasetItemRead {
  id: string;
  position: number;
  input: string;
  expected_output: string | null;
  source: string;
  created_at: string;
  updated_at: string;
}

export interface DatasetItemWrite {
  input: string;
  expected_output?: string | null;
}

export type EvalsSurfaceVerdict =
  | { state: "enabled" }
  | { state: "absent"; reason: string }
  | { state: "disabled"; reason: string }
  | { state: "unreadable"; reason: string };

/**
 * What `GET /api/v1/config` says about the evals surface.
 *
 * - `enabled` — `feature_flags.evals` is `true` (the default since upstream #16591).
 * - `absent` — the flag map exists but has no `evals` key: a build that predates evals,
 *   where the routes do not exist. The caller skips, naming it.
 * - `disabled` — `evals` is `false` on a build that has it. The caller FAILS: the default
 *   is on, so this is a lane configured against the product default or a changed
 *   default, and a green all-skip would hide both (#1010).
 * - `unreadable` — no flag map, or a non-boolean flag. Never read as `absent`, because
 *   a config the spec cannot parse says nothing about which build it is (#1012).
 */
export function evalsSurfaceVerdict(config: unknown): EvalsSurfaceVerdict {
  const flags =
    config !== null && typeof config === "object" ? (config as { feature_flags?: unknown }).feature_flags : undefined;
  if (flags === null || typeof flags !== "object" || Array.isArray(flags)) {
    return { state: "unreadable", reason: `GET /api/v1/config has no feature_flags map (got ${JSON.stringify(flags)})` };
  }
  if (!("evals" in flags)) {
    return {
      state: "absent",
      reason: "feature_flags has no `evals` key — this build predates evals (langflow-ai/langflow#15999, 1.14)",
    };
  }
  const evals = (flags as { evals: unknown }).evals;
  if (evals === true) return { state: "enabled" };
  if (evals === false) {
    return {
      state: "disabled",
      reason:
        "feature_flags.evals is false — evals are on by default since langflow-ai/langflow#16591, so this instance " +
        "was configured against the product default (or the default changed upstream)",
    };
  }
  return { state: "unreadable", reason: `feature_flags.evals is not a boolean (got ${JSON.stringify(evals)})` };
}

/** Reads the config with the caller's credential and returns the verdict. */
export async function readEvalsSurface(
  request: APIRequestContext,
  headers: Record<string, string>,
): Promise<EvalsSurfaceVerdict> {
  const res = await request.get("/api/v1/config", { headers });
  if (res.status() !== 200) {
    return { state: "unreadable", reason: `GET /api/v1/config answered ${res.status()}: ${(await res.text()).slice(0, 200)}` };
  }
  return evalsSurfaceVerdict(await res.json());
}

async function failure(what: string, res: { status(): number; text(): Promise<string> }): Promise<Error> {
  return new Error(`${what} answered ${res.status()}: ${(await res.text()).slice(0, 400)}`);
}

/**
 * Datasets created by one test, deleted by id afterwards.
 *
 * Id-scoped on purpose: every worker runs as the same superuser, so a cleanup that
 * diffed the listing would delete another worker's datasets.
 */
export class DatasetTracker {
  private readonly ids: string[] = [];

  track(id: string): void {
    this.ids.push(id);
  }

  /** Deletes every tracked id; a `404` means the test already deleted it. */
  async cleanup(request: APIRequestContext, headers: Record<string, string>): Promise<void> {
    const errors: string[] = [];
    for (const id of this.ids.splice(0)) {
      const res = await request.delete(`${DATASETS}/${id}`, { headers });
      if (res.status() !== 204 && res.status() !== 404) {
        errors.push(`DELETE ${DATASETS}/${id} answered ${res.status()}: ${(await res.text()).slice(0, 200)}`);
      }
    }
    if (errors.length > 0) throw new Error(`dataset cleanup left datasets behind:\n${errors.join("\n")}`);
  }
}

/** `POST /datasets/` expecting `201`; the new id is tracked before anything else can fail. */
export async function createDataset(
  request: APIRequestContext,
  headers: Record<string, string>,
  body: { name: string; description?: string | null },
  tracker: DatasetTracker,
): Promise<DatasetRead> {
  const res = await request.post(`${DATASETS}/`, { headers, data: body });
  if (res.status() !== 201) throw await failure(`POST ${DATASETS}/`, res);
  const dataset = (await res.json()) as DatasetRead;
  tracker.track(dataset.id);
  return dataset;
}

/** `POST /datasets/{id}/items` expecting `201`; returns the created rows. */
export async function addItems(
  request: APIRequestContext,
  headers: Record<string, string>,
  datasetId: string,
  items: DatasetItemWrite[],
): Promise<DatasetItemRead[]> {
  const res = await request.post(`${DATASETS}/${datasetId}/items`, { headers, data: { items } });
  if (res.status() !== 201) throw await failure(`POST ${DATASETS}/${datasetId}/items`, res);
  return (await res.json()) as DatasetItemRead[];
}

/** `GET /datasets/{id}` expecting `200`. */
export async function readDataset(
  request: APIRequestContext,
  headers: Record<string, string>,
  datasetId: string,
): Promise<DatasetRead> {
  const res = await request.get(`${DATASETS}/${datasetId}`, { headers });
  if (res.status() !== 200) throw await failure(`GET ${DATASETS}/${datasetId}`, res);
  return (await res.json()) as DatasetRead;
}

/** Every row of a dataset in `position` order, paging until `total` is reached. */
export async function listAllItems(
  request: APIRequestContext,
  headers: Record<string, string>,
  datasetId: string,
): Promise<DatasetItemRead[]> {
  const items: DatasetItemRead[] = [];
  for (let page = 1; ; page++) {
    const res = await request.get(`${DATASETS}/${datasetId}/items`, { headers, params: { page, size: 500 } });
    if (res.status() !== 200) throw await failure(`GET ${DATASETS}/${datasetId}/items?page=${page}`, res);
    const body = (await res.json()) as { total: number; items: DatasetItemRead[] };
    items.push(...body.items);
    if (body.items.length === 0 || items.length >= body.total) return items;
  }
}

/** A multipart body carrying a CSV file plus optional form fields (`input_column`, …). */
export function csvUpload(
  fileName: string,
  content: string | Buffer,
  fields: Record<string, string> = {},
): Record<string, string | { name: string; mimeType: string; buffer: Buffer }> {
  return {
    ...fields,
    file: { name: fileName, mimeType: "text/csv", buffer: typeof content === "string" ? Buffer.from(content, "utf8") : content },
  };
}
