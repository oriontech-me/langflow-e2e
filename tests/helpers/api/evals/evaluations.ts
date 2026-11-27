import type { APIRequestContext } from "@playwright/test";
import { createCatalogFlow, fetchComponentCatalog } from "../../flows/build-catalog-flow";

/**
 * Evaluations — a flow run over a dataset, each row scored (Langflow 1.14, upstream
 * #15999). Shared by `api/evals/api-evaluations.spec.ts` (#2564) and the evals UI spec
 * (#2565). Contract and measurements: `docs/api/evals/api-evaluations.md`.
 *
 * Like `datasets.ts`, every function throws with the status and body on an unexpected
 * answer instead of calling `expect`, whose message is dropped outside the runner.
 */

export const EVALUATIONS = "/api/v1/evaluations";
export const EVALUATION_RUNS = "/api/v1/evaluation-runs";

export interface ScorerSpec {
  type: "exact_match" | "contains" | "similarity" | "llm_judge";
  name: string;
  weight?: number;
  config?: Record<string, unknown>;
}

export interface EvaluationRunRead {
  id: string;
  evaluation_id: string;
  status: string;
  flow_id: string | null;
  flow_name: string;
  flow_version_id: string | null;
  flow_version_number: number | null;
  flow_version_source: string;
  dataset_id: string | null;
  dataset_name: string;
  dataset_revision: number;
  config: { scorers: ScorerSpec[]; pass_threshold: number; output_vertex_id: string | null; [key: string]: unknown };
  total_items: number;
  completed_items: number;
  failed_items: number;
  passed_items: number;
  summary: {
    scores: Record<string, { mean: number; p50: number; p90: number }>;
    pass_rate: number | null;
    rows: { total: number; errored: number; decided: number };
    [key: string]: unknown;
  } | null;
  estimate: Record<string, unknown> | null;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
}

export interface EvaluationRead {
  id: string;
  name: string;
  project_id: string | null;
  flow_id: string | null;
  flow_name: string | null;
  dataset_id: string | null;
  dataset_name: string | null;
  output_vertex_id: string | null;
  scorers: Array<Required<ScorerSpec>>;
  pass_threshold: number;
  last_run: EvaluationRunRead | null;
  created_at: string;
  updated_at: string;
}

export interface EvaluationResultRead {
  id: string;
  position: number;
  input: string;
  expected_output: string | null;
  actual_output: string | null;
  output_truncated: boolean;
  error: string | null;
  scores: Record<string, { value: number | null; comment?: string }>;
  passed: boolean | null;
  duration_ms: number;
  trace_id: string | null;
  preview: boolean;
  [key: string]: unknown;
}

/** The part of a run the poller reads. */
export type RunSnapshot = Pick<EvaluationRunRead, "id" | "status" | "completed_items" | "total_items">;

/** `TERMINAL_RUN_STATUSES` upstream (`services/database/models/evaluation/evaluation.py`). */
const TERMINAL = new Set(["completed", "failed", "cancelled"]);

/**
 * Whether a run has ended. An unknown status is NOT terminal, so a status upstream
 * renames makes the wait time out naming it, rather than end early on a guess.
 */
export function isTerminalRunStatus(status: string): boolean {
  return TERMINAL.has(status);
}

export interface PollClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const realClock: PollClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * Reads the run until `accept` holds and returns that snapshot. On timeout, throws
 * naming what it waited for and where the run was — a stuck run then reads as
 * "running, 2/6 rows" rather than as a bare timeout.
 */
export async function pollRun<T extends RunSnapshot>(
  read: () => Promise<T>,
  accept: (run: T) => boolean,
  options: { describe: string; timeoutMs: number; intervalMs: number; clock?: PollClock },
): Promise<T> {
  const clock = options.clock ?? realClock;
  const deadline = clock.now() + options.timeoutMs;
  for (;;) {
    const run = await read();
    if (accept(run)) return run;
    if (clock.now() >= deadline) {
      throw new Error(
        `evaluation run ${run.id} did not reach ${options.describe} within ${options.timeoutMs} ms — ` +
          `last status "${run.status}", ${run.completed_items}/${run.total_items} rows`,
      );
    }
    await clock.sleep(options.intervalMs);
  }
}

async function failure(what: string, res: { status(): number; text(): Promise<string> }): Promise<Error> {
  return new Error(`${what} answered ${res.status()}: ${(await res.text()).slice(0, 400)}`);
}

/**
 * Evaluations created by one test, deleted by id afterwards.
 *
 * Deleting a flow does NOT delete its evaluations — they survive with `flow_id: null`,
 * measured on `1.14.0.dev39` — so this cleanup runs before the flows are deleted.
 */
export class EvaluationTracker {
  private readonly ids: string[] = [];

  track(id: string): void {
    this.ids.push(id);
  }

  /** Deletes every tracked id; a `404` means the test already deleted it. */
  async cleanup(request: APIRequestContext, headers: Record<string, string>): Promise<void> {
    const errors: string[] = [];
    for (const id of this.ids.splice(0)) {
      const res = await request.delete(`${EVALUATIONS}/${id}`, { headers });
      if (res.status() !== 204 && res.status() !== 404) {
        errors.push(`DELETE ${EVALUATIONS}/${id} answered ${res.status()}: ${(await res.text()).slice(0, 200)}`);
      }
    }
    if (errors.length > 0) throw new Error(`evaluation cleanup left evaluations behind:\n${errors.join("\n")}`);
  }
}

/** Node ids of the echo flow; the evaluation scores `ECHO_OUTPUT`. */
export const ECHO_INPUT = "ChatInput-in";
export const ECHO_OUTPUT = "ChatOutput-out";

/**
 * A Chat Input → Chat Output flow built from the live catalog: its answer to every
 * row is the row's input, which is what makes a keyless run's scores predictable.
 * Deleting it is the caller's job (`deleteFlow`), after its evaluations.
 *
 * Pass `options.catalog` when creating several: `GET /api/v1/all` is ~700 KB and took
 * ~9 s cold on `1.14.0.dev39`, so a spec should read it once per file, not per flow.
 */
export async function createEchoFlow(
  request: APIRequestContext,
  headers: Record<string, string>,
  name: string,
  options: { withOutput?: boolean; catalog?: Record<string, unknown> } = {},
): Promise<string> {
  const catalog = options.catalog ?? (await fetchComponentCatalog(request, headers));
  const withOutput = options.withOutput ?? true;
  return createCatalogFlow(
    request,
    catalog,
    {
      nodes: withOutput
        ? [
            { id: ECHO_INPUT, type: "ChatInput" },
            { id: ECHO_OUTPUT, type: "ChatOutput" },
          ]
        : [{ id: ECHO_INPUT, type: "ChatInput" }],
      edges: withOutput ? [{ source: ECHO_INPUT, output: "message", target: ECHO_OUTPUT, field: "input_value" }] : [],
    },
    { name, headers },
  );
}

/** `POST /evaluations` expecting `201`; the id is tracked before anything else can fail. */
export async function createEvaluation(
  request: APIRequestContext,
  headers: Record<string, string>,
  body: { flow_id: string; dataset_id: string; scorers: ScorerSpec[]; name?: string; pass_threshold?: number },
  tracker: EvaluationTracker,
): Promise<EvaluationRead> {
  const res = await request.post(EVALUATIONS, { headers, data: body });
  if (res.status() !== 201) throw await failure(`POST ${EVALUATIONS}`, res);
  const evaluation = (await res.json()) as EvaluationRead;
  tracker.track(evaluation.id);
  return evaluation;
}

/** `POST /evaluations/{id}/runs` expecting `202`. */
export async function startRun(
  request: APIRequestContext,
  headers: Record<string, string>,
  evaluationId: string,
): Promise<EvaluationRunRead> {
  const res = await request.post(`${EVALUATIONS}/${evaluationId}/runs`, { headers, data: {} });
  if (res.status() !== 202) throw await failure(`POST ${EVALUATIONS}/${evaluationId}/runs`, res);
  return (await res.json()) as EvaluationRunRead;
}

/** `GET /evaluation-runs/{id}` expecting `200`. */
export async function readRun(
  request: APIRequestContext,
  headers: Record<string, string>,
  runId: string,
): Promise<EvaluationRunRead> {
  const res = await request.get(`${EVALUATION_RUNS}/${runId}`, { headers });
  if (res.status() !== 200) throw await failure(`GET ${EVALUATION_RUNS}/${runId}`, res);
  return (await res.json()) as EvaluationRunRead;
}

/** Polls the run until it reaches a terminal status (any of them — the caller asserts which). */
export function waitForRunEnd(
  request: APIRequestContext,
  headers: Record<string, string>,
  runId: string,
  timeoutMs = 60_000,
): Promise<EvaluationRunRead> {
  return pollRun(
    () => readRun(request, headers, runId),
    (run) => isTerminalRunStatus(run.status),
    { describe: "a terminal status", timeoutMs, intervalMs: 500 },
  );
}

/** Every result of a run in position order, paging until `total` is reached. */
export async function listAllResults(
  request: APIRequestContext,
  headers: Record<string, string>,
  runId: string,
): Promise<{ total: number; items: EvaluationResultRead[] }> {
  const items: EvaluationResultRead[] = [];
  for (let page = 1; ; page++) {
    const res = await request.get(`${EVALUATION_RUNS}/${runId}/results`, { headers, params: { page, size: 200 } });
    if (res.status() !== 200) throw await failure(`GET ${EVALUATION_RUNS}/${runId}/results?page=${page}`, res);
    const body = (await res.json()) as { total: number; items: EvaluationResultRead[] };
    items.push(...body.items);
    if (body.items.length === 0 || items.length >= body.total) return { total: body.total, items };
  }
}
