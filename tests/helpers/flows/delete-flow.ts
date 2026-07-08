import type { APIRequestContext } from "@playwright/test";

/**
 * Deletes a flow via the Langflow REST API and surfaces a failed deletion.
 *
 * Playwright's `APIRequestContext.delete()` resolves to an `APIResponse` even
 * on 4xx/5xx and never throws, so an unchecked cleanup call lets a failed
 * deletion pass silently — the flow stays behind and the suite quietly starts
 * re-accumulating leftover flows (the buildup #545 set out to stop). This
 * helper checks the response and throws on failure so cleanup regressions are
 * visible instead of silent.
 *
 * A single transient teardown 5xx (e.g. under parallel load) is absorbed by one
 * retry before throwing, so a genuinely-failed deletion still surfaces without
 * an otherwise-green test being failed by a one-off blip. A non-5xx client
 * error (401/403/422/…) is deterministic — it won't change on retry — so it
 * throws immediately.
 *
 * Pass `page.request` (browser-context cookie/state auth is reused
 * automatically) or a standalone `request` with an explicit Authorization
 * header via `options.headers`.
 *
 * @param request  A Playwright `APIRequestContext` (`page.request` or the `request` fixture).
 * @param id       The flow ID to delete.
 * @param options  Optional Playwright request options (same shape as `request.delete`'s), e.g. `{ headers: { Authorization } }`.
 */
export async function deleteFlow(
  request: APIRequestContext,
  id: string,
  options?: Parameters<APIRequestContext["delete"]>[1],
): Promise<void> {
  const url = `/api/v1/flows/${id}`;
  // 404 means the flow is already gone — for idempotent cleanup that IS the
  // desired end state (e.g. a concurrent worker's sweep removed it first), not
  // a failure.
  const isDone = (r: { ok(): boolean; status(): number }) =>
    r.ok() || r.status() === 404;

  const res = await request.delete(url, options);
  if (isDone(res)) return;

  // Only a transient server error (5xx) is worth retrying; a 4xx is a
  // deterministic client error (auth, bad id) that won't change on retry, so
  // surface it right away with its original body.
  if (res.status() < 500) {
    throw new Error(`Flow cleanup failed: ${res.status()} — ${await res.text()}`);
  }

  // One retry to absorb a transient teardown 5xx under parallel load.
  const retry = await request.delete(url, options);
  if (isDone(retry)) return;
  throw new Error(
    `Flow cleanup failed: ${retry.status()} — ${await retry.text()}`,
  );
}
