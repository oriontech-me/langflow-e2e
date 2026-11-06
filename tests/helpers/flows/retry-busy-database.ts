import type { APIResponse } from "@playwright/test";

/**
 * Retries a Langflow write that answered "the database is busy" (#2400).
 *
 * On SQLite, a write route that loses a write-lock race can answer
 * `503 {"detail": "The database is busy. Please retry the request."}` with
 * `Retry-After: 1`. Most flow write routes absorb that inside the server
 * (`run_with_lock_retry`, `lock_retry.py`); `POST …/versions/{id}/activate` does not,
 * and under parallel load it answered that `503` in 33 of 40 calls (measured on
 * `1.14.0.dev18`, spec doc `docs/api/flows/api-flows-versions.md`).
 *
 * Langflow's own client replays a failed mutation on a `5xx` up to 3 times and waits
 * for `Retry-After` (`MAX_MUTATION_RETRIES` in the frontend's `request-processor.ts`).
 * This helper follows that contract, narrowed to the one answer measured:
 *
 * - Only a `503` whose `detail` is exactly {@link DATABASE_BUSY_DETAIL} is retried.
 *   Any other status, any other `detail` (the migration pause is also a `503`), and a
 *   body that cannot be read are returned at once, so the caller's assertion sees them.
 * - At most {@link MAX_BUSY_RETRIES} retries, waiting `Retry-After` each time.
 * - The final response is returned whatever it is. The helper never asserts and never
 *   throws, so a caller still asserting `200` fails on an exhausted retry exactly as it
 *   would have without the helper. Each retry is returned so the caller can report it.
 *
 * Unlike a retry on a `500` (which #1225 declined for `deleteFlow`), this does not hide
 * a defect: the server's own answer says to try again.
 */

export const DATABASE_BUSY_DETAIL = "The database is busy. Please retry the request.";

/** The product client's `MAX_MUTATION_RETRIES`. */
export const MAX_BUSY_RETRIES = 3;

/** Used when `Retry-After` is absent or not a number of seconds. */
const DEFAULT_RETRY_AFTER_MS = 1000;

/** Langflow sends `1`; a larger value would only slow a test past its use. */
const MAX_RETRY_AFTER_MS = 5000;

/** The part of a Playwright `APIResponse` this helper reads. */
export type ResponseLike = Pick<APIResponse, "status" | "headers" | "text">;

/** One busy answer that was retried. */
export interface BusyRetry {
  /** 1-based number of the attempt that answered busy. */
  attempt: number;
  /** The `Retry-After` header as sent, if any. */
  retryAfter: string | undefined;
  /** How long the helper waited before the next attempt. */
  delayMs: number;
}

export interface BusyRetryResult<R extends ResponseLike> {
  /** The last response received. */
  response: R;
  /** Every busy answer that was retried, in order. Empty when the first answer was used. */
  retries: BusyRetry[];
}

export interface BusyRetryOptions {
  maxRetries?: number;
  /** Replaces the real wait. Unit tests only. */
  sleep?: (ms: number) => Promise<void>;
}

/** Whether `response` is the retryable busy `503`. Never throws. */
export async function isDatabaseBusy(response: ResponseLike): Promise<boolean> {
  if (response.status() !== 503) return false;
  try {
    const body = JSON.parse(await response.text()) as { detail?: unknown } | null;
    return body?.detail === DATABASE_BUSY_DETAIL;
  } catch {
    return false;
  }
}

/** Milliseconds to wait for a `Retry-After` given in seconds. */
export function retryAfterMs(header: string | undefined): number {
  if (header === undefined || header.trim() === "") return DEFAULT_RETRY_AFTER_MS;
  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds < 0) return DEFAULT_RETRY_AFTER_MS;
  return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
}

/** One line for an assertion message or an annotation. */
export function describeBusyRetries(retries: BusyRetry[]): string {
  if (retries.length === 0) return "no busy retry";
  const each = retries
    .map((r) => `attempt ${r.attempt} busy (Retry-After ${r.retryAfter ?? "absent"}, waited ${r.delayMs} ms)`)
    .join("; ");
  return `${retries.length} busy ${retries.length === 1 ? "retry" : "retries"}: ${each}`;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Sends the request built by `send`, and sends it again while the answer is the busy
 * `503`, at most `maxRetries` times. `send` must build a fresh request on each call.
 */
export async function retryBusyDatabase<R extends ResponseLike>(
  send: () => Promise<R>,
  options: BusyRetryOptions = {},
): Promise<BusyRetryResult<R>> {
  const maxRetries = options.maxRetries ?? MAX_BUSY_RETRIES;
  const sleep = options.sleep ?? realSleep;
  const retries: BusyRetry[] = [];

  let response = await send();
  while (retries.length < maxRetries && (await isDatabaseBusy(response))) {
    const retryAfter = response.headers()["retry-after"];
    const delayMs = retryAfterMs(retryAfter);
    retries.push({ attempt: retries.length + 1, retryAfter, delayMs });
    await sleep(delayMs);
    response = await send();
  }
  return { response, retries };
}
