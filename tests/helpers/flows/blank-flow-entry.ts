import type { Page } from "@playwright/test";
import {
  entryBarrierMessage,
  probeBackend,
  waitForAttributedSelector,
  type BackendProbe,
} from "../other/page-entry-barrier";

/**
 * The wait that turns a created flow into a usable canvas — with the
 * `201`-without-navigation stall of #1126 both ATTRIBUTED and REPAIRED.
 *
 * WHAT BREAKS (#1126)
 *
 * `POST /api/v1/flows/` answers `201`, the caller reads the authoritative id
 * from it, and the SPA then never routes to `/flow/<id>`. Three dailies lost the
 * same test to it — 2026-07-16 (run 29489622983), 2026-07-20 (29736388873) and
 * 2026-07-30 (30534416609) — and in all three the Playwright call log is exactly
 *
 *   TimeoutError: page.waitForURL: Timeout 30000ms exceeded.
 *   waiting for navigation until "load"
 *
 * with NO `navigated to "…"` line. That absence is the whole diagnosis, and it is
 * not a subtlety of reading: `waitForNavigation` logs `navigated to "<url>"` for
 * every main-frame navigation it observes BEFORE it tests the URL predicate
 * (`playwright-core/lib/client/frame.js` — the log is the line above the
 * `urlMatches` call). So the frame emitted no navigation at all for the full 30 s.
 * The state is TERMINAL, not slow, and a bigger budget cannot reach it.
 *
 * WHY THE BUDGET IS NOT THE PROBLEM
 *
 * Measured on nightly 1.12.0.dev39, 6 parallel lanes × 8 blank-flow creations:
 * 48/48 routed, min 39 ms, p50 269 ms, p95 337 ms, max 457 ms. The retired 30 s
 * wait was ~90× the p95, so the failures were never near the budget.
 *
 * WHERE IT COMES FROM, AND WHAT IS STILL UNKNOWN
 *
 * Upstream (`release-1.12.0`), `modals/templatesModal/index.tsx` navigates ONLY
 * from the `.then()` of `addFlow()`, and that chain has no `.catch`:
 *
 *   addFlow().then((id) => { dismissWelcomeForNavigation(); navigate(`/flow/${id}`) })
 *
 * `addFlow` (`hooks/flows/use-add-flow.ts`) resolves from react-query's
 * PER-MUTATE `onSuccess`. A creation whose per-mutate `onSuccess` never reaches
 * `resolve(createdFlow.id)` therefore leaves the promise pending forever and the
 * app parked on the flows list — exactly the observed state. WHY it fails to
 * resolve is NOT established, and this comment does not pretend otherwise: the
 * obvious candidate (the templates modal unmounts mid-flight, so react-query
 * drops the per-mutate callback) was tested by pressing Escape immediately after
 * the click on 1.12.0.dev39 and navigated 5 of 5. So the branch is refuted, not
 * confirmed, and the stall stays reproducible only in CI.
 *
 * WHY REPAIR RATHER THAN FAIL
 *
 * This is an ENTRY POINT. The specs behind it assert MCP behaviour, and a red
 * that names neither MCP nor the real cause is what got one of them quarantined
 * for a month while the two siblings after it in a `mode: "serial"` file were
 * skipped as collateral. The repair is deterministic and costs nothing that could
 * hide a product regression: the id from the `201` is authoritative, so loading
 * `/flow/<id>` directly reaches the SAME flow the caller already tracks for
 * cleanup — no second flow is created, unlike the re-click doctrine of #1468.
 * Measured on 1.12.0.dev39, that load reaches `canvas_controls_dropdown` in
 * 1.0–2.3 s, 5 of 5.
 *
 * It is never SILENT, which is the condition that makes repairing acceptable
 * (#1012): every repair prints `REPAIR_MARKER` on stdout, and Playwright's JSON
 * reporter stores test stdout under `results[].stdout` — the same artifact triage
 * already reads — so a future occurrence is greppable in the daily without a
 * trace, which is what expires first.
 *
 * AND IT NEVER SWALLOWS AN OUTAGE
 *
 * A wedged or restarting backend produces the identical timeout (#1262). So the
 * stall is probed before it is repaired, and a backend that is not healthy
 * FAILS through `entryBarrierMessage`, which embeds the probe's own transport
 * error — that embedded text is what `scripts/lib/infra-signatures.ts` matches,
 * so the wedge stays exempt from `@stable` auto-removal while the repaired,
 * healthy-backend case is not an error at all.
 */

/** Measured p95 of the SPA route, 1.12.0.dev39, 48/48 (see the header). */
export const MEASURED_ROUTE_P95_MS = 337;

/**
 * Budget for the SPA route. ~30× the measured p95 — generous enough that a
 * loaded CI backend cannot reach the repair path by being slow, small enough
 * that the terminal stall is not paid for at 30 s three times a month.
 */
export const FLOW_ROUTE_BUDGET_MS = 10000;

/** Named in every failure so a reader knows which entry point broke (#1265). */
export const BLANK_FLOW_ENTRY_SURFACE = "blank-flow-entry";

/** Surface label for the repair's own barrier, kept distinct from the wait's. */
export const BLANK_FLOW_REPAIR_SURFACE = "blank-flow-entry-repair";

/**
 * The canvas-mount barrier the repair waits on. The SPA route does not wait for
 * it — that path is unchanged and already proven — but a full document load
 * genuinely has a mount to finish, and returning before it would hand the caller
 * the same unattributed canvas race #1469 describes.
 */
export const CANVAS_BARRIER_SELECTOR = '[data-testid="canvas_controls_dropdown"]';

/** Budget for the barrier above. Measured 1.0–2.3 s on 1.12.0.dev39, 5/5. */
export const CANVAS_BARRIER_TIMEOUT_MS = 30000;

/**
 * Stable, greppable prefix of the repair notice. It is a CONTRACT: a daily's
 * `results[].stdout` is searched for this exact string to count occurrences of
 * #1126, so renaming it silently loses the history.
 */
export const REPAIR_MARKER = "📌 Blank-flow entry repaired (#1126)";

export type FlowRouteStallVerdict = "repair" | "abort";

/**
 * What to do about a route that did not happen. Pure so the decision is pinned
 * by a unit test rather than by reading the caller.
 *
 * Only a HEALTHY probe earns the repair. Everything else — unreachable,
 * non-2xx, or a probe that could not run at all — aborts, because repairing
 * against a backend we could not reach would turn an outage into a green test
 * (#1012: an unevaluated probe is unknown, never clean).
 */
export function flowRouteStallVerdict(probe: BackendProbe): FlowRouteStallVerdict {
  return probe.state === "healthy" ? "repair" : "abort";
}

/**
 * The line printed when the entry point is repaired. Carries everything a triage
 * needs to add the occurrence to #1126 without a trace: which flow, which
 * budget, and what the backend answered while the SPA sat still.
 */
export function repairedEntryNotice(detail: {
  flowId: string;
  budgetMs: number;
  probe: BackendProbe;
}): string {
  const { flowId, budgetMs, probe } = detail;
  return (
    `${REPAIR_MARKER}: the SPA did not route to /flow/${flowId} within ` +
    `${budgetMs}ms even though POST /api/v1/flows/ had already answered 201, ` +
    `while Langflow answered GET /api/v1/version with HTTP ${probe.status} in ` +
    `${probe.ms}ms (${probe.url}). Recovered by loading /flow/${flowId} ` +
    `directly — no second flow was created. This is a product-side stall in ` +
    `Langflow's post-create navigation, not a slow wait: the route's measured ` +
    `p95 is ${MEASURED_ROUTE_P95_MS}ms. Record this occurrence on issue #1126.`
  );
}

/**
 * Wait until the caller is on the canvas of the flow it just created, repairing
 * the #1126 stall if it happens. Returns which path was taken so a caller can
 * assert on it; the specs do not, they just proceed.
 *
 * `flowId` MUST be the id from the creation response, never the one in the
 * canvas URL — that one is a transient client-side handle on this version and
 * deleting it 404s while silently leaking the real flow.
 */
export async function enterCreatedFlow(
  page: Page,
  flowId: string,
  options?: { baseURL?: string; budgetMs?: number },
): Promise<"routed" | "repaired"> {
  const budgetMs = options?.budgetMs ?? FLOW_ROUTE_BUDGET_MS;

  try {
    await page.waitForURL(/\/flow\//, { timeout: budgetMs });
    return "routed";
  } catch (error: unknown) {
    const cause = String((error as Error)?.message ?? error);
    const probe = await probeBackend(page, { baseURL: options?.baseURL });

    if (flowRouteStallVerdict(probe) === "abort") {
      throw new Error(
        entryBarrierMessage({
          selector: `URL /flow/${flowId}`,
          timeoutMs: budgetMs,
          probe,
          surface: BLANK_FLOW_ENTRY_SURFACE,
          cause,
        }),
      );
    }

    await page.goto(`/flow/${flowId}`);
    await waitForAttributedSelector(
      page,
      CANVAS_BARRIER_SELECTOR,
      CANVAS_BARRIER_TIMEOUT_MS,
      { baseURL: options?.baseURL, surface: BLANK_FLOW_REPAIR_SURFACE },
    );
    // Announced only once the repair has actually landed: a notice printed
    // before the barrier would claim a recovery that then failed, and the
    // stdout line is the record a future triage counts occurrences from.
    console.warn(repairedEntryNotice({ flowId, budgetMs, probe }));
    return "repaired";
  }
}
