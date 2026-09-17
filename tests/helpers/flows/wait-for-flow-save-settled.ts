import type { Page, Request } from "@playwright/test";
import { SAVE_COMPLETION_BUDGET_MS } from "./autosave-interval";

/** The cap a caller that passes no `quietMs` has always had. */
export const DEFAULT_DRAIN_CAP_MS = 10000;

/**
 * The safety cap for a given quiet window (#1902).
 *
 * The cap is not a deadline the caller chose, it is the escape hatch that stops
 * a never-quiet editor from hanging the run — so it has to leave room for the
 * whole thing it is capping: a save still to be ISSUED (`quietMs`) and then to
 * COMPLETE (`SAVE_COMPLETION_BUDGET_MS`, the budget `autosave-interval.ts`
 * already sizes for exactly that). A fixed 10 000 ms did not: with `quietMs`
 * raised from 700 to a derived ~3500 ms, the interval in which a late PATCH
 * could still be fully drained shrank from ~9.3 s to ~6.5 s, and past it the
 * helper returns with a request possibly still IN FLIGHT — the state #995 made
 * it request-aware to prevent. Found in review of #1902; the coupling was
 * already noted as a known gap in #1901 and is what makes a derived window
 * meaningful rather than approximately meaningful.
 *
 * `Math.max` with the historical floor, so a caller that passes no window keeps
 * a cap no shorter than the one it has always had.
 */
export function drainCapMs(quietMs: number): number {
  return Math.max(DEFAULT_DRAIN_CAP_MS, quietMs + SAVE_COMPLETION_BUDGET_MS);
}

/**
 * Block until the flow's debounced autosave has settled.
 *
 * Many editor actions mutate the flow and schedule a debounced
 * `PATCH /api/v1/flows/{id}` autosave (upstream `use-autosave-flow.ts`): adding
 * a node, editing a node field, connecting an edge.
 *
 * WHICH actions is a property of the build and has narrowed. This header used
 * to list "fitting/zooming the canvas viewport, or simply opening a flow (the
 * editor fits the view on mount)" as well; measured on `1.13.0.dev15` neither
 * does — opening a flow issued no PATCH at all (empty and 6-node alike,
 * `updated_at` unchanged after 8 s), and fit-view plus zoom-out moved the
 * viewport transform with zero PATCHes in 6 s, against a control node-field
 * edit that produced exactly one (#1743). Do not re-derive a quiescence
 * precondition from the old list.
 *
 * If such an autosave is still in flight when the next flow-mutating action
 * fires its own PATCH — e.g. saving the prompt modal, or saving the flow-settings modal — the
 * two requests race. The endpoint has no version check and the frontend applies
 * whichever response lands LAST (`use-save-flow.ts` → `setCurrentFlow(updatedFlow)`
 * in the mutation's `onSuccess`), so the loser silently overwrites the winner in
 * both the store and the database.
 *
 * This surfaces as cross-test flake: a spurious error toast (issue #358), a
 * detached `input-flow-name` / never-enabled `save-flow-settings` (issue #357),
 * or a rename that is reverted to the pre-rename name (issue #995).
 *
 * Resolves once **no flow-save PATCH is in flight** and none has completed for
 * `quietMs`, or after `timeout` as a safety cap so a quiet flow never hangs the
 * caller.
 *
 * ## What it does NOT do, and why the header used to imply otherwise (#1741)
 *
 * This is a DRAIN, not a proof that your edit was saved. The quiet window arms
 * immediately when nothing is in flight, so called right after an edit it
 * returns having tracked no request at all — the save is still only SCHEDULED.
 * The header used to justify `quietMs = 700` as "comfortably above the 300 ms
 * autosave debounce", and that is wrong twice over: `SAVE_DEBOUNCE_TIME = 300`
 * is used elsewhere and is not the store's pre-fetch default either — that is
 * `AUTOSAVE_DEBOUNCE_TIME = 2000` (`flowsManagerStore.ts:57`, checked against
 * `release-1.13.0` in #1902) — while the effective delay is
 * `GET /api/v1/config.auto_saving_interval` — measured
 * **1000** in `SimpleAgentTemplatePage.ts` and **2000** on `1.13.0.dev4`. Both
 * exceed the window, so the barrier expires first, by design of the numbers
 * rather than by accident of load.
 *
 * Measured 3/3 on `1.13.0.dev4`: called after two node-body fills it returned
 * ~1.0 s later with ZERO patches sent and the database still holding the
 * pre-edit value. Two other call sites had already measured the same gap
 * independently (`SimpleAgentTemplatePage.ts`, which rejected this helper as a
 * fix for exactly this reason, and `general-bugs-save-changes-on-node.spec.ts`,
 * which replaced it with a server-side gate).
 *
 * **If the next assertion depends on the edit having reached the server** — a
 * reload, a navigation away, an API read of the flow — use `watchFlowSave(page)`
 * instead: arm it before the edit and await it after, and it FAILS when no save
 * appears rather than reporting a silence it cannot interpret. This helper stays
 * the right tool for draining traffic you did not cause.
 *
 * Tracking requests — not just responses — is what makes this a barrier rather
 * than a silence probe (issue #995). The response-only version armed its quiet
 * timer immediately, so a PATCH that had already been *issued* but whose
 * response was slow under load (>`quietMs`) left the helper returning while the
 * autosave was still in flight — exactly the window in which the caller's own
 * PATCH races it.
 */
export async function waitForFlowSaveSettled(
  page: Page,
  {
    quietMs = 700,
    timeout = drainCapMs(quietMs),
  }: { quietMs?: number; timeout?: number } = {},
): Promise<void> {
  const isFlowSave = (req: Request) =>
    req.url().includes("/api/v1/flows/") && req.method() === "PATCH";

  await new Promise<void>((resolve) => {
    let quietTimer: ReturnType<typeof setTimeout> | undefined;
    let inFlight = 0;

    // The cap is the one exit that does NOT mean the editor went quiet, and it
    // used to resolve indistinguishably from one that did — a silence about a
    // silence (#1012). It cannot throw: this helper drains traffic the caller
    // did not cause, and failing here would redden a test over a busy editor.
    // It can say so, and a reader who sees it knows not to read the next
    // assertion as having run on a settled store.
    const finishOnCap = () => {
      console.warn(
        `[waitForFlowSaveSettled] gave up at the ${timeout}ms safety cap without ` +
          `${quietMs}ms of quiet — ${inFlight} flow-save PATCH(es) still in flight. ` +
          `Whatever runs next is NOT starting from a settled store (#995/#1902).`,
      );
      finish();
    };

    const finish = () => {
      clearTimeout(quietTimer);
      clearTimeout(cap);
      page.off("request", onRequest);
      page.off("requestfinished", onSettled);
      page.off("requestfailed", onSettled);
      resolve();
    };

    // Only start counting silence when nothing is in flight; a pending PATCH
    // keeps the barrier closed no matter how long its response takes.
    const arm = () => {
      clearTimeout(quietTimer);
      if (inFlight === 0) quietTimer = setTimeout(finish, quietMs);
    };

    const onRequest = (req: Request) => {
      if (!isFlowSave(req)) return;
      inFlight++;
      clearTimeout(quietTimer);
    };

    // A PATCH that was already in flight before this helper attached decrements
    // below zero; clamping keeps the counter honest and still re-arms the quiet
    // window, preserving the original response-driven behaviour for that case.
    const onSettled = (req: Request) => {
      if (!isFlowSave(req)) return;
      inFlight = Math.max(0, inFlight - 1);
      arm();
    };

    const cap = setTimeout(finishOnCap, timeout);
    page.on("request", onRequest);
    page.on("requestfinished", onSettled);
    page.on("requestfailed", onSettled);
    arm();
  });
}
