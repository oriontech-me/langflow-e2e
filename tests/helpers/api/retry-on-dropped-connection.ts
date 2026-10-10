/**
 * Run one API call, re-dialling ONCE if the request fails at the transport layer.
 *
 * Moved here from `helpers/enterprise/rbac.ts` (#2243): its callers are in every
 * area, and none of them is about RBAC. `rbac.ts` re-exports it.
 *
 * The drop it absorbs is attributed (#2236). On Linux Langflow runs under
 * gunicorn, whose `UvicornWorker` takes `timeout_keep_alive` from gunicorn's
 * `keepalive` — 2 s by default, not overridden by Langflow — so a request that
 * reuses a pooled socket at the instant the server closes it dies with
 * `socket hang up` / `read ECONNRESET`. Measured on `1.13.0.dev35`: 5 of 15 reads
 * dropped at an idle gap of exactly 2000 ms, none at 1500, 1950, 2050 or 3000 ms.
 * The drop this helper was first written for (#1562) was on the Enterprise
 * variant, where the idle close measured ~5 s, and it was never attributed; it
 * is not claimed to be the same edge.
 *
 * It matters because `expect.poll` PROPAGATES a throw from its poller. A poll
 * written to tolerate timing cannot tolerate the one error that actually shows
 * up, so the run dies on a dropped connection instead of re-reading a moment
 * later. Keeping poll intervals off the 2 s edge makes a drop unlikely for the
 * gaps a poll controls (`scripts/lib/poll-keepalive-cadence.test.ts` pins that), though the
 * client's own processing still adds to each gap; this covers what is left, and
 * the gaps a poll does not control at all, like the first read after a UI step.
 *
 * Deliberately narrow, so nothing here softens an assertion: only a THROWN
 * request is retried, and only once. A response that arrived carrying a non-2xx
 * is a statement about the product and is passed straight through.
 */
export async function retryOnDroppedConnection<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/socket hang up|ECONNRESET|ECONNREFUSED|EPIPE|socket disconnected/i.test(message)) {
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    return await call();
  }
}
