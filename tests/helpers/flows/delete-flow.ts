import type { APIRequestContext } from "@playwright/test";
import { recordTokenAttribution } from "./token-attribution";
import { resolveTestAttribution } from "./resolve-test-attribution";

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
export interface DeleteFlowHooks {
  /**
   * Attribute this flow's tokens before deleting it. Defaults to `true`.
   *
   * `cleanAllFlows` passes `false`, and that is not a preference: it deletes
   * EVERY user flow on the shared instance, including flows another worker is
   * actively using. Naming those after whichever spec called the sweep writes
   * WRONG rows into `by_spec` -- strictly worse than a missing row, because a
   * wrong number carries no marker saying so (§2.2).
   */
  attribute?: boolean;
  /**
   * Override the source of test metadata. **Unit tests only** -- a spec must not
   * pass it. See `resolveTestAttribution`.
   */
  info?: Parameters<typeof resolveTestAttribution>[0];
}

export async function deleteFlow(
  request: APIRequestContext,
  id: string,
  options?: Parameters<APIRequestContext["delete"]>[1],
  hooks?: DeleteFlowHooks,
): Promise<void> {
  // BEFORE the DELETE, on purpose: a trace 404s the moment its flow is deleted
  // (#1197 design §2/S4), so this is the last instant the data exists. 157 specs
  // reach this helper, which is what makes one hook here worth 148 spec edits.
  //
  // Wrapped in its own try/catch even though `recordTokenAttribution` is
  // documented not to throw: this helper's contract is that it throws on a failed
  // DELETION, and telemetry must never be able to counterfeit that signal. An
  // unguarded rejection here would fail a spec's teardown for a reason that has
  // nothing to do with the flow (§2.3).
  if (hooks?.attribute !== false) {
    try {
      const attribution = resolveTestAttribution(hooks?.info);
      // No attribution means there is no running test to name -- this helper is
      // reachable from module scope and from setup helpers, not only from hooks.
      // That is an expected state, not a failure, so it is silent: warning here
      // would fire on every helper-invoked delete in the suite.
      if (attribution) {
        const result = await recordTokenAttribution({
          request,
          flowIds: [id],
          test: attribution.test,
          file: attribution.file,
          headers: (options as { headers?: Record<string, string> } | undefined)?.headers,
        });
        // A failure WITH a test to name is different, and it must not be silent.
        // This helper returns void, so `skipped` has nowhere to go -- and
        // discarding it would make a wedged monitor endpoint indistinguishable
        // from "no traces yet", which is exactly finding I8 of the #1197 review.
        // Warning is what `cleanup()` already does with the same list
        // (track-created-flows.ts:270-275), so this matches the established shape.
        if (result.skipped.length > 0) {
          console.warn(
            `⚠️  token attribution skipped ${result.skipped.length} flow(s): ` +
              result.skipped.join("; "),
          );
        }
      }
    } catch {
      // Last resort. `recordTokenAttribution` is documented not to throw, but this
      // helper's contract is that it throws on a failed DELETION -- telemetry must
      // never be able to counterfeit that signal. Losing an attribution is
      // acceptable; failing a teardown over one is not.
    }
  }

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
