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
 * an otherwise-green test being failed by a one-off blip.
 *
 * Pass `page.request` (browser-context cookie/state auth is reused
 * automatically) or a standalone `request` with an explicit Authorization
 * header via `options.headers`.
 *
 * @param request  A Playwright `APIRequestContext` (`page.request` or the `request` fixture).
 * @param id       The flow ID to delete.
 * @param options  Optional request options, e.g. `{ headers: { Authorization } }`.
 */
export async function deleteFlow(
  request: APIRequestContext,
  id: string,
  options?: { headers?: Record<string, string> },
): Promise<void> {
  const res = await request.delete(`/api/v1/flows/${id}`, options);
  // 404 means the flow is already gone — for idempotent cleanup that IS the
  // desired end state (e.g. a concurrent worker's sweep removed it first), not
  // a failure. Only a genuine error (403/5xx/…) should surface.
  if (res.ok() || res.status() === 404) return;

  // One retry to absorb a transient teardown 5xx under parallel load.
  const retry = await request.delete(`/api/v1/flows/${id}`, options);
  if (!retry.ok() && retry.status() !== 404) {
    throw new Error(
      `Flow cleanup failed: ${retry.status()} — ${await retry.text()}`,
    );
  }
}
