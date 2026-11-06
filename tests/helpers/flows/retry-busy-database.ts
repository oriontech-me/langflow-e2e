import type { APIResponse } from "@playwright/test";

/**
 * Retries a version restore that answered "the database is busy", the way Langflow's
 * UI does (#2400).
 *
 * On SQLite, `POST …/versions/{id}/activate` can lose a write-lock race and answer
 * `503 {"detail": "The database is busy. Please retry the request."}`. Unlike the flow
 * create, PATCH and delete routes, it does not retry inside the server
 * (`run_with_lock_retry`, `lock_retry.py`). Under parallel load it answered that `503`
 * in 33 of 40 calls (measured on `1.14.0.dev18`, spec doc
 * `docs/api/flows/api-flows-versions.md`).
 *
 * The UI's restore (`src/frontend/src/hooks/flows/use-restore-version.ts`) sends
 * activate, and on a `503` waits {@link RETRY_BUSY_MS} and sends it once more; a second
 * failure shows the person "Failed to restore version". This helper does the same, so a
 * test that still fails after it is a restore a person would also have seen fail:
 *
 * - Only a `503` whose `detail` is exactly {@link DATABASE_BUSY_DETAIL} is retried. The
 *   UI retries any `503`; this is narrower on purpose, so another `503` (the migration
 *   pause is one) reaches the caller's assertion as it came. Any other status and a body
 *   that cannot be read are returned at once too.
 * - At most {@link MAX_BUSY_RETRIES} retry, after a fixed {@link RETRY_BUSY_MS}. The UI
 *   ignores `Retry-After`, and so does this.
 * - The last response is returned whatever it is, so a caller asserting `200` fails on a
 *   second busy answer exactly as it would have without the helper. The helper does not
 *   assert. It does not catch either: a transport error from `send` propagates.
 *
 * Unlike a retry on a `500` (which #1225 declined for `deleteFlow`), this does not hide
 * a defect from the test: it stops where the product's own client stops.
 */

export const DATABASE_BUSY_DETAIL = "The database is busy. Please retry the request.";

/** The UI's `RETRY_BUSY_MS` in `use-restore-version.ts`. */
export const RETRY_BUSY_MS = 700;

/** The UI sends activate once more, never more. */
export const MAX_BUSY_RETRIES = 1;

/** The part of a Playwright `APIResponse` this helper reads. */
export type ResponseLike = Pick<APIResponse, "status" | "text">;

/** One busy answer that was retried. */
export interface BusyRetry {
  /** 1-based number of the attempt that answered busy. */
  attempt: number;
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

/** One line for an assertion message or an annotation. */
export function describeBusyRetries(retries: BusyRetry[]): string {
  if (retries.length === 0) return "no busy retry";
  const each = retries.map((r) => `attempt ${r.attempt} busy, waited ${r.delayMs} ms`).join("; ");
  return `${retries.length} busy ${retries.length === 1 ? "retry" : "retries"} (${each})`;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Sends the request built by `send`, and sends it once more if the answer is the busy
 * `503`. `send` must build a fresh request on each call.
 */
export async function retryBusyDatabase<R extends ResponseLike>(
  send: () => Promise<R>,
  options: BusyRetryOptions = {},
): Promise<BusyRetryResult<R>> {
  const sleep = options.sleep ?? realSleep;
  const retries: BusyRetry[] = [];

  let response = await send();
  while (retries.length < MAX_BUSY_RETRIES && (await isDatabaseBusy(response))) {
    retries.push({ attempt: retries.length + 1, delayMs: RETRY_BUSY_MS });
    await sleep(RETRY_BUSY_MS);
    response = await send();
  }
  return { response, retries };
}
