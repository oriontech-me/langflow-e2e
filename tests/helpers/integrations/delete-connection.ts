import type { APIRequestContext } from "@playwright/test";

/**
 * Deletes a Dedicated Integrations connection via `DELETE /api/v1/connections/{id}`
 * and surfaces a failed deletion — the connection-level sibling of `deleteFlow` /
 * `deleteProject`, and the teardown every spec that seeds a connection goes through.
 *
 * **Why the 429 branch exists.** Connection writes are rate-limited per USER, not
 * per client: creates, updates, revokes and deletes share one bucket of
 * `connection_write_rate_limit_per_minute` (30 by default), and a `DELETE` that
 * answers `404` is counted too, because the limiter runs before the lookup.
 * Measured on `1.13.0.dev19`. The suite shares one superuser, so any spec seeding
 * connections can exhaust the bucket for every other one on the same backend, and
 * the refusal — `429` with `retry-after: 60` — says nothing about Langflow. So a
 * `429` is waited out ONCE, for the window the server advertises, and a second one
 * throws: looping would turn a genuinely saturated instance into a silent stall.
 *
 * The retry is teardown robustness, never an assertion softened: a spec whose
 * SUBJECT is this endpoint issues its own raw `request.delete` and asserts the
 * status it gets (`api/connections/api-connections-lifecycle.spec.ts`).
 *
 * Contract, mirroring `deleteProject`:
 *  - `2xx` or `404` (already gone) is the desired idempotent end state;
 *  - `429` waits `retry-after` once, then retries; a second `429` throws;
 *  - a `5xx` is retried once after a short backoff, then throws;
 *  - any other status is deterministic (401/403/422/…) and throws at once, with
 *    the body.
 */

/** Added to every advertised wait, so the retry lands after the window, not on it. */
export const RETRY_AFTER_MARGIN_MS = 500;

/**
 * The longest a `429` can cost. The bucket is per minute, so waiting a whole
 * window is guaranteed to clear it — and anything longer is the header lying.
 */
export const MAX_RETRY_AFTER_MS = 60_000 + RETRY_AFTER_MARGIN_MS;

const TRANSIENT_5XX_BACKOFF_MS = 250;

/**
 * How long to wait after a `429`, from its `retry-after` header.
 *
 * Langflow sends whole seconds (`retry-after: 60`). Anything else — no header, a
 * value that is not a non-negative integer, or the HTTP-date form, which is legal
 * HTTP but never sent here — reads as the whole window, since that is the only
 * wait known to clear a per-minute bucket. A `0` still waits a second: the header
 * was sent BECAUSE the request was refused, so "retry now" cannot be what it means.
 */
export function retryAfterMs(headers: Record<string, string>): number {
  const raw = headers["retry-after"];
  if (raw === undefined || !/^\d+$/.test(raw.trim())) return MAX_RETRY_AFTER_MS;
  const seconds = Math.max(1, Number(raw.trim()));
  return Math.min(seconds * 1000 + RETRY_AFTER_MARGIN_MS, MAX_RETRY_AFTER_MS);
}

export interface DeleteConnectionOptions {
  /** e.g. `{ Authorization }` from `getAuthToken` — omit when using `page.request`. */
  headers?: Record<string, string>;
  /**
   * Override how the helper waits. **Unit tests only** — a spec must not pass it.
   * Same reason as `getAuthToken`'s: asserting the wait that was ASKED FOR is the
   * contract, and a real clock in a unit test sits on a boundary (#1454).
   */
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function deleteConnection(
  request: APIRequestContext,
  id: string,
  { headers, sleep = realSleep }: DeleteConnectionOptions = {},
): Promise<void> {
  const url = `/api/v1/connections/${id}`;
  let waitedForBudget = false;
  let retriedTransient = false;

  for (;;) {
    const res = await request.delete(url, headers ? { headers } : undefined);
    const status = res.status();
    if (res.ok() || status === 404) return;

    if (status === 429 && !waitedForBudget) {
      waitedForBudget = true;
      const wait = retryAfterMs(res.headers());
      // Visible on purpose: how often teardown hits the shared write bucket is
      // the number that says whether the integrations specs need a lane budget.
      console.warn(
        `⚠️ Connection cleanup for ${id} hit the per-user write limit (429) — waiting ${wait} ms for the window to reset`,
      );
      await sleep(wait);
      continue;
    }

    if (status >= 500 && !retriedTransient) {
      retriedTransient = true;
      console.warn(`⚠️ Connection cleanup got ${status} for ${id} — retrying once`);
      await sleep(TRANSIENT_5XX_BACKOFF_MS);
      continue;
    }

    throw new Error(`Connection cleanup failed for ${id}: ${status} — ${await res.text()}`);
  }
}
