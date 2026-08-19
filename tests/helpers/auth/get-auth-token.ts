import type { APIRequestContext } from "@playwright/test";

/**
 * Retry budget, sized from what the failures actually look like — not from
 * what a worker recycle costs in isolation.
 *
 * A recycle alone is ~15-20 s (the container log times a full Langflow boot at
 * ~18 s, 11 s of it the component registry). But on daily #1057 and on both CI
 * runs of #1080 the outage outlasted that: `auto_login` died on every one of
 * Playwright's three test-level attempts for one target, while a sibling spec
 * recovered on its third — i.e. the backend came back on a ~1-minute scale,
 * not a ~20-second one. A single short retry would not have changed any of
 * those results, so the budget spans the observed window instead.
 *
 * Backoff, not a tight loop: a wedged backend must not be hammered, and each
 * attempt already carries its own request timeout (~20 s under the suite's
 * `actionTimeout`), so the wall-clock span is roughly the delays plus those.
 * Cost when the backend is genuinely dead: this budget, once, then the error.
 * Relieving the wedge itself remains #1077 — this only survives it.
 */
export const DEFAULT_RETRY_DELAYS_MS = [2000, 8000, 20000];

export interface GetAuthTokenOptions {
  /** Override the backoff. Tests pass `[]` or short delays; callers should not set it. */
  retryDelaysMs?: number[];
  /**
   * Override how the backoff waits. **Unit tests only** — a spec must not pass it.
   *
   * The wait is a real `setTimeout`, and the only way to assert it *happened*
   * from the outside was to sleep and compare `Date.now()` against the delay.
   * Node may fire a timer a fraction of a millisecond before `Date.now()` shows
   * the full interval elapsed, so that assertion sat exactly on the boundary and
   * failed on a runner whose clock granularity landed the wrong way (#1454 —
   * twice in a row on PR #1496, green locally). Injecting the sleep lets the test
   * assert what the helper *asked for*, which is the actual contract, with no
   * clock in the loop.
   */
  sleep?: (ms: number) => Promise<void>;
}

/** The real backoff wait, kept out of the loop so tests can replace it. */
const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Retrieves a Langflow authentication token.
 * In auto_login mode (default), uses /api/v1/auto_login.
 * Returns the Authorization header ready for use.
 *
 * A request that THROWS (the shared backend recycling its worker mid-run, so
 * the call never answers and Playwright kills it at its timeout) is retried
 * within the budget above. A request that ANSWERS non-ok is not: that is an
 * environment without auth, not an outage, and retrying it would slow every
 * caller down.
 *
 * Every retry is logged. The wedge stays visible in the run output — the point
 * is to survive it, never to hide it.
 *
 * If the budget runs out, the original error propagates. It must never degrade
 * into the empty-token fallback: the callers would carry on unauthenticated
 * and fail somewhere far less diagnosable (#1086).
 */
export async function getAuthToken(
  request: APIRequestContext,
  {
    retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
    sleep = realSleep,
  }: GetAuthTokenOptions = {},
): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await request.get("/api/v1/auto_login");

      if (res.ok()) {
        const body = await res.json();
        if (body?.access_token) {
          return `Bearer ${body.access_token}`;
        }
      }

      // fallback: no token (environment without auth)
      return "";
    } catch (error) {
      if (attempt >= retryDelaysMs.length) throw error;
      const delay = retryDelaysMs[attempt];
      console.warn(
        `⚠️  auth: /api/v1/auto_login did not answer (${(error as Error)?.message?.split("\n")[0] ?? error}) — retry ${attempt + 1}/${retryDelaysMs.length} in ${delay}ms. The backend is wedged or recycling (see #1077).`,
      );
      await sleep(delay);
    }
  }
}
