import type { Page, Response } from "@playwright/test";
import {
  INFRA_PREFIX,
  PROBE_PATH,
  probeBackend,
  type BackendProbe,
} from "./page-entry-barrier";

/**
 * The `page-entry-barrier` contract (#1262/#1265), applied to a RESPONSE wait
 * instead of a selector (#1713).
 *
 * `page.waitForResponse` has the same ambiguity `waitForSelector` had, and it
 * cost the same mis-triage. On the 2026-09-04 daily (run 33873006780) two
 * `@stable` auth tests flaked in different shards with a byte-identical string:
 *
 *   TimeoutError: page.waitForResponse: Timeout 30000ms exceeded while waiting
 *   for event "response"
 *
 * Both came from the same `waitForResponse` in
 * `helpers/auth/sign-in-through-form.ts`, and that string cannot tell apart the
 * only two states that produce it:
 *
 *   1. the backend accepted the request and never answered — a wedge, collateral
 *      damage, nothing to do with the test;
 *   2. the frontend stopped issuing the request — a product regression, and the
 *      shape the issue's investigation directive named as prime suspect.
 *
 * Which is why `page.waitForResponse: Timeout` is deliberately NOT on
 * `scripts/lib/infra-signature-patterns.json` and must not be added: exempting
 * it would exempt (2) as well. Both history rows for this flake therefore carry
 * `infra_signature: null`, and `remove-stable-from-failures.ts` had no way to
 * tell whether the tag was owed.
 *
 * Measured rather than assumed, on nightly `1.13.0.dev2`, by `docker pause`ing
 * the container — connections accepted and never answered, the gunicorn wedge
 * shape — and driving the real helper against it, twice:
 *
 *   - the production signature reproduced verbatim;
 *   - the frontend DID issue `POST /api/v1/login` (`page.on("request")`), and it
 *     was never aborted (`requestfailed` empty — the nightly's bundle configures
 *     no client-side request timeout, so once issued the POST waits for the
 *     backend however long that takes);
 *   - no response ever arrived, so a 30 s wait inside a 96 s outage cannot do
 *     anything but expire;
 *   - a probe taken WHILE still wedged returned `unreachable` in 5019 ms with
 *     `apiRequestContext.get: Timeout 5000ms exceeded.`
 *
 * That last line is what makes this cost nothing: the message embeds the probe's
 * own transport error, which the EXISTING `api-request-timeout` signature
 * already matches — so a wedge is classifiable with no new pattern anywhere,
 * while a healthy probe stays unclassified on purpose.
 *
 * Three rules the unit tests pin, the same three the entry barrier pins:
 *
 *  - unreachable or non-2xx ⇒ `INFRA_PREFIX`, the marker meaning "the harness
 *    could not talk to Langflow";
 *  - a HEALTHY probe deliberately does NOT get that prefix — that failure is the
 *    product's, and mislabelling it would let a real regression through
 *    unquarantined;
 *  - a probe that could not run is UNKNOWN, never healthy (#1012).
 *
 * The budget is never widened. A barrier that outlasted the outage would report
 * a green run through a broken backend, which is the opposite of the point.
 *
 * KNOWN LIMITATION, inherited from the entry barrier and stated rather than
 * papered over: the probe runs AFTER the wait's budget is spent, so it reports
 * the backend's state then, not during. A wedge shorter than the wait clears
 * before the probe and reads `healthy`, and the message then blames the app.
 * That asymmetry is deliberate — over-claiming an outage is the more expensive
 * mistake.
 */

/** Default `surface` label for a caller that names none. */
export const REQUEST_SURFACE = "request";

export interface ResponseBarrierContext {
  /**
   * Human-readable description of the request waited on, e.g.
   * `POST /api/v1/login`. Named in the message because a predicate function is
   * not readable from a report — #1265's flake was mis-triaged for exactly that.
   */
  observable: string;
  timeoutMs: number;
  probe: BackendProbe;
  /** The original Playwright error text. */
  cause: string;
  /**
   * Which wait this barrier guards, e.g. `login`. Defaults to
   * `REQUEST_SURFACE`.
   */
  surface?: string;
}

/**
 * Build the attributed failure message. Pure — the unit tests drive it directly
 * with each probe state.
 */
export function responseBarrierMessage(ctx: ResponseBarrierContext): string {
  const { observable, timeoutMs, probe, cause } = ctx;
  const surface = ctx.surface?.trim() || REQUEST_SURFACE;
  // Playwright's transport errors already end in a period, and the entry
  // barrier's template appends another — `Timeout 5000ms exceeded..` shows up in
  // every wedge message it has ever written. Trimmed here rather than inherited.
  const detail = (probe.detail ?? "").replace(/\.\s*$/, "");
  const barrier = `${surface} barrier "${observable}" did not answer within ${timeoutMs}ms`;
  const url = probe.url;

  let head: string;
  switch (probe.state) {
    case "unreachable":
      head =
        `${INFRA_PREFIX} ${barrier} — and the backend did not answer GET ` +
        `${PROBE_PATH} within ${probe.ms}ms (${url}): ${detail}. ` +
        `Langflow was unreachable or restarting, so the request was accepted and ` +
        `never answered — this is NOT a frontend that stopped issuing it.`;
      break;
    case "http_error":
      head =
        `${INFRA_PREFIX} ${barrier} — the backend answered GET ${PROBE_PATH} ` +
        `with HTTP ${probe.status} in ${probe.ms}ms (${url}). Langflow is up but ` +
        `failing to serve, so this is NOT a frontend that stopped issuing the ` +
        `request.`;
      break;
    case "healthy":
      head =
        `${barrier} — the backend answered GET ${PROBE_PATH} with HTTP ` +
        `${probe.status} in ${probe.ms}ms (${url}), so the backend was reachable ` +
        `and the request was either never issued or never answered by the app: ` +
        `this IS a product/UI failure at the ${surface} surface.`;
      break;
    default:
      head =
        `${barrier} — backend liveness could not be probed ` +
        `(${detail}), so whether Langflow was reachable is UNKNOWN. ` +
        `Do not read this as a healthy backend.`;
  }

  return `${head}\n\nOriginal error:\n${cause}`;
}

export interface AttributedResponseOptions {
  observable: string;
  timeoutMs: number;
  surface?: string;
  baseURL?: string;
}

/**
 * `page.waitForResponse` with the timeout attributed.
 *
 * Drop-in: same predicate, same budget, same resolved `Response`. Only the
 * failure path changes.
 *
 * NOT `async` on purpose. Callers register the wait BEFORE the action that
 * triggers it — `signInThroughForm` registers, then clicks **Sign In**, so the
 * status read cannot race the navigation a `200` triggers. `page.waitForResponse`
 * subscribes synchronously, and this function must preserve that: making it
 * `async` would defer the subscription to the first `await` and silently reopen
 * the race. Pinned by a unit test.
 */
export function waitForAttributedResponse(
  page: Page,
  predicate: (response: Response) => boolean,
  options: AttributedResponseOptions,
): Promise<Response> {
  const pending = page.waitForResponse(predicate, { timeout: options.timeoutMs });
  return pending.catch(async (error: any) => {
    const probe = await probeBackend(page, { baseURL: options.baseURL });
    throw new Error(
      responseBarrierMessage({
        observable: options.observable,
        timeoutMs: options.timeoutMs,
        probe,
        surface: options.surface,
        cause: String(error?.message ?? error),
      }),
    );
  });
}
