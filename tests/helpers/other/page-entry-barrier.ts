import type { Page } from "@playwright/test";

/**
 * The page-entry barrier every helper that lands on the home page waits on
 * (`mainpage_title`, then `new-project-btn`), with the failure ATTRIBUTED — and,
 * since #1265, the same attribution for any other entry observable a spec has to
 * wait on before it can start asserting (see `waitForAttributedSelector`).
 *
 * Why this exists (#1262). A bare `waitForSelector` on those two testids cannot
 * distinguish the only two things that make it time out:
 *
 *   1. the backend is unreachable or restarting — the page loads, the app shell
 *      renders nothing, and the barrier burns its whole budget;
 *   2. the entry point genuinely regressed — the backend answers and the UI
 *      still does not render the observable.
 *
 * Both produce the same line, which is the most common failure string in
 * `reports/daily-history.jsonl`:
 *
 *   TimeoutError: page.waitForSelector: Timeout 30000ms exceeded.
 *     - waiting for locator('[data-testid="mainpage_title"]') to be visible
 *
 * That ambiguity has already cost a wrong triage. On the 2026-08-04 daily
 * (run 30901311395, shard 4) gunicorn logged `WORKER TIMEOUT (pid:37)` at
 * 10:46:42, SIGKILLed the worker, and the backend was restarting through
 * 10:47:01→10:48:33; two retries of `language-model-regression.spec.ts` ran
 * inside that window, reported the line above, and the test was filed as an
 * entry-point failure (#1262) instead of as collateral of the wedge — while its
 * own first attempt had failed on the provider's build. The same string on
 * 2026-07-09/07-14/07-15 was a third observable entirely (`text=built
 * successfully`), which is how "recurrent 3×, same signature" survived review.
 *
 * So the barrier probes `/api/v1/version` on timeout and says which state it
 * observed. Three rules the unit tests pin:
 *
 *  - an unreachable or non-2xx backend gets `INFRA_PREFIX`, the marker meaning
 *    "the harness could not talk to Langflow" — the same claim
 *    `scripts/lib/infra-signatures.ts` requires before it will exempt a failure
 *    from `@stable` auto-removal;
 *  - a HEALTHY probe deliberately does NOT get that prefix: that failure is the
 *    UI's, and mislabelling it would turn a real entry-point regression into an
 *    unquarantined "outage";
 *  - a probe that could not run is reported as UNKNOWN, never as healthy
 *    (#1012 — an unevaluated check is not a clean one).
 *
 * The original Playwright error is always appended, so the trace, screenshot and
 * call log stay readable against it.
 *
 * WHY IT IS NOT ONLY THE HOME PAGE (#1265)
 *
 * The same ambiguity exists one navigation later, and it cost the same mis-triage.
 * `modelInputComponent.spec.ts` waited 30s for `sidebar-search-input` — the
 * component sidebar's search field on a freshly-opened flow — with a bare
 * `locator.waitFor`. On the 2026-08-04 daily (run 30901311395) that wait timed
 * out inside two measured shard-2 outages (76s and 92s, with gunicorn logging
 * `WORKER TIMEOUT (pid:37)` + SIGKILL at 10:46:30) and the failing attempt took
 * 287s against ~6s for its own file-siblings once the backend recovered. The
 * report showed only
 *
 *   TimeoutError: locator.waitFor: Timeout 30000ms exceeded.
 *     - waiting for getByTestId('sidebar-search-input') to be visible
 *
 * so the flake was filed as test-local and an otherwise healthy `@stable` test
 * was quarantined for a cycle. `locator.waitFor: Timeout` cannot be added to
 * `scripts/lib/infra-signatures.ts` — a genuine UI regression produces it too —
 * so that message is unclassifiable by construction. The attributed one is not,
 * and NOT only because of `INFRA_PREFIX`: it embeds the probe's own transport
 * error, so a wedge (accepted-and-never-answered ⇒ `apiRequestContext.get:
 * Timeout`) already matches the existing `api-request-timeout` signature with no
 * new entry added anywhere, while the healthy-probe message stays unclassified.
 * Both halves of that are pinned in `page-entry-barrier.test.ts` against the real
 * classifier. So the barrier is generic in the observable and carries a `surface`
 * label naming which entry point failed.
 *
 * KNOWN LIMITATION, stated rather than papered over: the probe runs AFTER the
 * wait's budget is spent, so it reports the backend's state then — not during.
 * #1265's outages were 76s and 92s, comfortably longer than the 30s wait, but a
 * shorter wedge that clears inside the budget reads `healthy` and the message
 * then blames the UI. That asymmetry is deliberate and inherited from #1262:
 * over-claiming an outage would let a real entry-point regression through
 * unquarantined, which costs more than a wedge that has to be recognised by hand.
 */

/**
 * Marker for a failure the harness proved it could not attribute to the page.
 * Kept in one place so a future `infra-signatures.ts` entry and this message
 * cannot drift apart.
 */
export const INFRA_PREFIX = "[backend-unreachable]";

/** Endpoint used as the liveness probe — unauthenticated and cheap. */
export const PROBE_PATH = "/api/v1/version";

export type ProbeState = "healthy" | "http_error" | "unreachable" | "unknown";

export interface BackendProbe {
  state: ProbeState;
  /** Wall-clock the probe took, in ms. */
  ms: number;
  /**
   * The absolute URL the probe actually called. Reported rather than rebuilt
   * from the environment: `PLAYWRIGHT_BASE_URL` and the browser context's own
   * baseURL can disagree, and a message that names an origin nobody called is
   * how a reader concludes the wrong backend was healthy.
   */
  url: string;
  /** Set when the backend answered. */
  status?: number;
  /** Transport error, or why the probe itself could not run. */
  detail?: string;
}

/**
 * Default `surface` label — the home page this barrier was built for (#1262).
 * Kept as the default so every existing caller, and every history entry already
 * written against that wording, keeps reading the same.
 */
export const PAGE_ENTRY_SURFACE = "page-entry";

export interface EntryBarrierContext {
  selector: string;
  timeoutMs: number;
  probe: BackendProbe;
  /** The original Playwright error text. */
  cause: string;
  /**
   * Which entry point this barrier guards, e.g. `page-entry` or
   * `component-sidebar`. Named in the message so a reader knows WHICH surface
   * failed without decoding the selector — #1265's flake was triaged as a model
   * selector problem because the message named neither (default:
   * `PAGE_ENTRY_SURFACE`).
   */
  surface?: string;
}

/**
 * Build the attributed failure message. Pure — the unit tests drive it directly
 * with each probe state.
 */
export function entryBarrierMessage(ctx: EntryBarrierContext): string {
  const { selector, timeoutMs, probe, cause } = ctx;
  const surface = ctx.surface?.trim() || PAGE_ENTRY_SURFACE;
  const barrier = `${surface} barrier "${selector}" did not render within ${timeoutMs}ms`;
  const url = probe.url;

  let head: string;
  switch (probe.state) {
    case "unreachable":
      head =
        `${INFRA_PREFIX} ${barrier} — and the backend did not answer GET ` +
        `${PROBE_PATH} within ${probe.ms}ms (${url}): ${probe.detail}. ` +
        `Langflow was unreachable or restarting, so this is NOT an entry-point ` +
        `regression in the app.`;
      break;
    case "http_error":
      head =
        `${INFRA_PREFIX} ${barrier} — the backend answered GET ${PROBE_PATH} ` +
        `with HTTP ${probe.status} in ${probe.ms}ms (${url}). Langflow is up but ` +
        `failing to serve, so this is NOT an entry-point regression in the app.`;
      break;
    case "healthy":
      head =
        `${barrier} — the backend answered GET ${PROBE_PATH} with HTTP ` +
        `${probe.status} in ${probe.ms}ms (${url}), so the backend was reachable ` +
        `and this IS a product/UI failure at the ${surface} entry point.`;
      break;
    default:
      head =
        `${barrier} — backend liveness could not be probed ` +
        `(${probe.detail}), so whether Langflow was reachable is UNKNOWN. ` +
        `Do not read this as a healthy backend.`;
  }

  return `${head}\n\nOriginal error:\n${cause}`;
}

/**
 * Origin to probe: the page's own, when it is on one — that is by definition the
 * Langflow the spec is driving. `baseURL` exists for the force-fail harness and
 * for a page parked on `about:blank`.
 */
export function resolveProbeUrl(page: Page, baseURL?: string): string {
  const explicit = baseURL ?? undefined;
  const pageUrl = page.url();
  const origin =
    explicit ??
    (/^https?:/i.test(pageUrl) ? new URL(pageUrl).origin : undefined) ??
    process.env.PLAYWRIGHT_BASE_URL ??
    "http://localhost:7860";
  return new URL(PROBE_PATH, origin).toString();
}

/** Probe Langflow's liveness through the page's own request context. */
export async function probeBackend(
  page: Page,
  options?: { baseURL?: string; timeoutMs?: number },
): Promise<BackendProbe> {
  const timeoutMs = options?.timeoutMs ?? 5000;
  const url = resolveProbeUrl(page, options?.baseURL);
  const started = Date.now();
  try {
    const res = await page.request.get(url, { timeout: timeoutMs });
    const ms = Date.now() - started;
    return res.ok()
      ? { state: "healthy", ms, status: res.status(), url }
      : { state: "http_error", ms, status: res.status(), url };
  } catch (error: any) {
    const ms = Date.now() - started;
    const detail = String(error?.message ?? error).split("\n")[0];
    // A transport error IS the answer here (refused / timed out / DNS), which is
    // different from the probe being unable to run at all — the latter only
    // happens when the page or its context is already gone.
    const unusable = /Target page|context or browser has been closed|browser has been closed/i.test(
      detail,
    );
    return unusable
      ? { state: "unknown", ms, url, detail: `probe could not run: ${detail}` }
      : { state: "unreachable", ms, url, detail };
  }
}

/**
 * `waitForSelector` for ANY entry observable, with the timeout attributed.
 *
 * Drop-in for `await page.waitForSelector(selector, { timeout })`. Behaviour on
 * success is identical (same selector, same budget) — only the failure path
 * changes, and it never loosens the budget: a barrier that masked a slow surface
 * would defeat the point of measuring it (#1265).
 *
 * `surface` names the entry point in the message. Pass it whenever the barrier is
 * not the home page, so the failure says which one broke.
 */
export async function waitForAttributedSelector(
  page: Page,
  selector: string,
  timeoutMs: number,
  options?: { baseURL?: string; surface?: string },
): Promise<void> {
  try {
    await page.waitForSelector(selector, { timeout: timeoutMs });
  } catch (error: any) {
    const probe = await probeBackend(page, { baseURL: options?.baseURL });
    throw new Error(
      entryBarrierMessage({
        selector,
        timeoutMs,
        probe,
        surface: options?.surface,
        cause: String(error?.message ?? error),
      }),
    );
  }
}

/**
 * The home-page specialisation (#1262) — `waitForAttributedSelector` with the
 * `page-entry` surface. Kept as its own name because that is what every helper
 * landing on the home page calls, and what the messages in
 * `reports/daily-history.jsonl` were written against.
 */
export async function waitForPageEntry(
  page: Page,
  selector: string,
  timeoutMs: number,
  options?: { baseURL?: string },
): Promise<void> {
  await waitForAttributedSelector(page, selector, timeoutMs, {
    baseURL: options?.baseURL,
    surface: PAGE_ENTRY_SURFACE,
  });
}
