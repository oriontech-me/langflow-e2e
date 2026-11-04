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
 * This helper was first written for #1562, on the Enterprise lane, where the drop
 * was load-dependent and its cause was not attributed at the time. The A2A
 * client spec later measured the same symptom at an idle gap of ~2 s against the
 * local nightly, on `[500, 1000, 2000]` intervals
 * (`docs/core-functionality/a2a/a2a-client-agent-as-tool.md`) -- consistent with
 * this edge. The Enterprise case is NOT explained by it: there the idle close
 * measured ~5 s, and `APIRequestContext` answered 200 at idle gaps of 2/4/6/8 s
 * (`docs/enterprise/authz/access-control-ui.md`), so it stays unattributed.
 *
 * It matters because `expect.poll` PROPAGATES a throw from its poller. A poll
 * written to tolerate timing cannot tolerate the one error that actually shows
 * up, so the run dies on a dropped connection instead of re-reading a moment
 * later. Keeping poll intervals off the 2 s edge makes a drop unlikely for the
 * gaps a poll controls (`scripts/lib/poll-keepalive-cadence.test.ts` pins that),
 * though the client's own processing still adds to each gap; this covers what is
 * left, and the gaps a poll does not control at all, like the first read after a
 * UI step.
 *
 * Deliberately narrow, so nothing here softens an assertion: only a THROWN
 * request is retried, and only once. A response that arrived carrying a non-2xx
 * is a statement about the product and is passed straight through.
 */
export async function retryOnDroppedConnection<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (!isDroppedConnection(error)) throw error;
    await new Promise((resolve) => setTimeout(resolve, 500));
    return await call();
  }
}

/** True when a request THREW at the transport layer — the family this file re-dials. */
export function isDroppedConnection(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /socket hang up|ECONNRESET|ECONNREFUSED|EPIPE|socket disconnected/i.test(message);
}

/**
 * A request that CREATES something, re-dialled once when the connection drops —
 * without leaking a second copy (#2354).
 *
 * `retryOnDroppedConnection` must never wrap such a request: the drop can happen after
 * the server took the request, and a blind retry then creates the resource twice. This
 * asks first. `landed` looks for what the first attempt would have created and answers
 * it when found, and then nothing is retried. When what landed cannot be used — an API
 * key whose secret only the lost response carried — `landed` removes it and answers
 * `undefined`, and the request is made again. Measured on the @instance-migration lane:
 * a `POST /api/v1/flows/` threw `socket hang up` in 1 of 5 runs of the same setup.
 */
export async function createWithoutLeak<T>(
  create: () => Promise<T>,
  landed: () => Promise<T | undefined>,
): Promise<T> {
  try {
    return await create();
  } catch (error) {
    if (!isDroppedConnection(error)) throw error;
    await new Promise((resolve) => setTimeout(resolve, 500));
    const found = await retryOnDroppedConnection(landed);
    if (found !== undefined) return found;
    return await create();
  }
}
