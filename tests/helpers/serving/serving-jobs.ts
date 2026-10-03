import type { APIRequestContext, APIResponse } from "@playwright/test";
import { SERVING_IDENTITY_HEADER } from "./serving-identity";

/**
 * Serving-plane end-user identity, job half: the five jobs doors, called as a
 * given end user, plus the two pure readings the gating spec compares with.
 *
 * `langflow-ai/langflow` #14550's phase 3 records the end user in
 * `job_metadata['end_user_id']` (the job's `user_id` stays the shared service
 * account) and checks it on every jobs endpoint. Each wrapper here takes an
 * optional `identity`: omitted means **no identity header at all**, which is the
 * anonymous caller — not the same request as a blank header.
 *
 * Spec doc: `docs/serving/end-user-job-lifecycle-gating.md`.
 */

/**
 * A job id no instance has issued, used to measure what "this job does not
 * exist" looks like on each door. A refusal of another end user's job is
 * compared against it: equal bodies mean the refusal does not reveal that the
 * job exists, which is why upstream answers `404` rather than `403`.
 */
export const NEVER_EXISTED_JOB_ID = "00000000-0000-4000-8000-000000000000";

/** One jobs-door response, reduced to what the gating spec asserts on. */
export interface JobCallReading {
  status: number;
  /** The parsed JSON body, or `null` when the body is not JSON (an event stream). */
  body: unknown;
  contentType: string;
  text: string;
}

/** One row of `GET /api/v2/workflows/pending?flow_id=`, as measured on 1.13.0.dev30. */
export interface PendingRequestRow {
  job_id: string;
  flow_id: string;
  session_id: string;
  request_id: string;
  allowed_decisions: string[];
}

/** One parsed `data:` line of an SSE replay. */
export interface SseEvent {
  event: string;
  data: unknown;
}

function withIdentity(headers: Record<string, string>, identity?: string): Record<string, string> {
  return identity === undefined ? { ...headers } : { ...headers, [SERVING_IDENTITY_HEADER]: identity };
}

async function readCall(res: APIResponse): Promise<JobCallReading> {
  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: res.status(), body, contentType: res.headers()["content-type"] ?? "", text };
}

/**
 * PURE. The body a refusal of `jobId` must equal: the never-existed job's body
 * with every occurrence of its id replaced by `jobId`.
 *
 * Every occurrence, at any depth — the status door names the id twice, in
 * `message` and in `job_id`, so a single replacement would make a correct
 * product fail. Only strings are touched, and the input is not mutated.
 */
export function expectedRefusalBody(neverExistedBody: unknown, jobId: string): unknown {
  if (typeof neverExistedBody === "string") {
    return neverExistedBody.split(NEVER_EXISTED_JOB_ID).join(jobId);
  }
  if (Array.isArray(neverExistedBody)) {
    return neverExistedBody.map((v) => expectedRefusalBody(v, jobId));
  }
  if (neverExistedBody !== null && typeof neverExistedBody === "object") {
    return Object.fromEntries(
      Object.entries(neverExistedBody).map(([k, v]) => [k, expectedRefusalBody(v, jobId)]),
    );
  }
  return neverExistedBody;
}

/**
 * PURE. Parse an SSE replay into its events.
 *
 * Langflow writes one `data: <json>` line per event, followed by an `id:` line
 * and a blank line (measured on 1.13.0.dev30). A `data:` line that is not JSON
 * THROWS, naming it: skipping it would turn a parse problem into "the event is
 * not in the replay", which reads as a product failure.
 */
export function parseSseEvents(text: string): SseEvent[] {
  const events: SseEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice("data:".length).trim();
    try {
      events.push(JSON.parse(payload) as SseEvent);
    } catch {
      throw new Error(`malformed SSE data line: ${line.slice(0, 200)}`);
    }
  }
  return events;
}

/**
 * `POST /api/v2/workflows` in `mode=background`, as `identity`. Returns the
 * job id, and throws when the submit was not accepted — every gating assertion
 * downstream is meaningless without a job to gate.
 */
export async function submitBackgroundRun(
  request: APIRequestContext,
  headers: Record<string, string>,
  {
    flowId,
    sessionId,
    identity,
    inputValue,
  }: { flowId: string; sessionId: string; identity?: string; inputValue: string },
): Promise<string> {
  const res = await request.post("/api/v2/workflows", {
    headers: withIdentity(headers, identity),
    data: { flow_id: flowId, input_value: inputValue, session_id: sessionId, mode: "background" },
  });
  const reading = await readCall(res);
  const jobId = (reading.body as { job_id?: unknown } | null)?.job_id;
  if (reading.status !== 200 || typeof jobId !== "string") {
    throw new Error(
      `background submit was not accepted: HTTP ${reading.status} ${reading.text.slice(0, 300)}`,
    );
  }
  return jobId;
}

/** `GET /api/v2/workflows?job_id=` — the job's status, as `identity`. */
export async function readJobStatus(
  request: APIRequestContext,
  headers: Record<string, string>,
  jobId: string,
  identity?: string,
): Promise<JobCallReading> {
  return readCall(
    await request.get(`/api/v2/workflows?job_id=${jobId}`, { headers: withIdentity(headers, identity) }),
  );
}

/** `GET /api/v2/workflows/pending?flow_id=` — the enumerating door, as `identity`. */
export async function listPendingRequests(
  request: APIRequestContext,
  headers: Record<string, string>,
  flowId: string,
  identity?: string,
): Promise<JobCallReading> {
  return readCall(
    await request.get(`/api/v2/workflows/pending?flow_id=${flowId}`, {
      headers: withIdentity(headers, identity),
    }),
  );
}

/** `POST /api/v2/workflows/stop`, as `identity`. */
export async function stopJob(
  request: APIRequestContext,
  headers: Record<string, string>,
  jobId: string,
  identity?: string,
): Promise<JobCallReading> {
  return readCall(
    await request.post("/api/v2/workflows/stop", {
      headers: withIdentity(headers, identity),
      data: { job_id: jobId },
    }),
  );
}

/** `POST /api/v2/workflows/{job_id}/resume`, as `identity`. */
export async function resumeJob(
  request: APIRequestContext,
  headers: Record<string, string>,
  jobId: string,
  body: { request_id: string; decision: { action_id: string } },
  identity?: string,
): Promise<JobCallReading> {
  return readCall(
    await request.post(`/api/v2/workflows/${jobId}/resume`, {
      headers: withIdentity(headers, identity),
      data: body,
    }),
  );
}

/**
 * `GET /api/v2/workflows/{job_id}/events`, as `identity`.
 *
 * Call it on a TERMINAL job when the owner is expected to be served: a
 * suspended job's stream tails until the run ends, while a finished one
 * replays and closes (measured at 17 ms). The 15 s timeout turns a stream that
 * never closes into a named failure instead of the 5-minute test timeout.
 */
export async function readJobEvents(
  request: APIRequestContext,
  headers: Record<string, string>,
  jobId: string,
  identity?: string,
): Promise<JobCallReading> {
  return readCall(
    await request.get(`/api/v2/workflows/${jobId}/events`, {
      headers: withIdentity(headers, identity),
      timeout: 15_000,
    }),
  );
}
