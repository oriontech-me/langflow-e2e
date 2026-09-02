import type { Page } from "@playwright/test";

/**
 * Frees the canvas' bottom-centre overlay slot before a click that lands under it.
 *
 * Langflow renders TWO different components into one fixed container —
 * `absolute bottom-16 left-1/2 z-50 w-[530px] -translate-x-1/2` — sitting over the
 * canvas, and they hand the slot to each other:
 *
 * - `flowBuildingComponent` — the build-status bar ("Flow built successfully", the
 *   building progress, "Flow build failed"). **Transient on success only** (see
 *   `BANNER_UNHIDE_DELAY_MS`); in its error state it never leaves on its own.
 * - `UpdateAllComponents` — the "Flow needs review / N components need updates"
 *   banner. Its `shouldHide` includes `isBuilding || buildInfo?.error ||
 *   buildInfo?.success`, so it is **hidden while the build bar is up and takes the
 *   slot back the moment the bar's state is cleared** — and then stays there
 *   indefinitely.
 *
 * That handover is what makes a plain wait insufficient, and it is the mechanism
 * behind #1643: `agent-context-id-{isolation,continuity}` waited for "built
 * successfully" and clicked the memory node's `output-inspection-*` button
 * immediately. Measured on nightly 1.12.0.dev39 at the default 1280x720 viewport,
 * that button's box is y 585.6-601.0 (centre 593.3) while the build bar's top edge
 * is at y 598 — the click clears it by ~5 px — and the update banner is 12 px
 * taller, top edge y ~586, which is ABOVE the centre. So the same click passes or
 * is refused purely on which of the two owns the slot, and once the banner owns it
 * no amount of retrying helps: on 2026-08-31 both specs burned the full 20 s
 * `locator.click` budget against `<div class="flex items-center justify-between
 * gap-6 rounded-lg border bg-background px-4 py-3 text-sm shadow-md">`, which is
 * the banner's inner element.
 *
 * The banner is there because these specs seed their flow from
 * `tests/assets/flows/chat-io-ok-trace-fixture.json`, whose nodes carry
 * `lf_version: 1.7.0`; the 1.12 nightly reports one of them as outdated. Refreshing
 * that fixture would silence it only until the next upstream template bump, and the
 * build bar would still be a ~5 px coin flip — so the fix is to stop clicking into
 * an occupied slot at all, not to keep the slot lucky.
 *
 * **The predicate is "will this occupant leave on its own?", read off the DOM as
 * "does it offer a Dismiss button".** That is exactly right for the update banner.
 * It is ALSO true of the build bar's error state, which renders Retry + Dismiss and
 * has no timer — and there, dismissing would delete the only UI evidence of a
 * failed run. Since `flow-error-policy`'s v2 verdict is advisory on 1.12.x, that
 * could green a genuinely failed build, so the error bar is refused by name rather
 * than dismissed (`BUILD_FAILED_TEXT`).
 *
 * **THIS HELPER WRITES TO THE FLOW.** Dismissing the update banner runs
 * `handleDismissAllComponents`, which does not only record the dismissal in the
 * store: it calls `setNodes` marking each flagged node `edited: true`, and the
 * editor persists that with a `PATCH /api/v1/flows/{id}` (observed on the wire).
 * Harmless for a caller that seeds a throwaway flow and deletes it in teardown; NOT
 * harmless for one that asserts on the persisted graph, counts flow writes, or
 * cares about the `edited` flag. Check that before adding a call site.
 *
 * **Two call-site shapes, and they differ in what an empty slot means.**
 *
 * - *Post-build* (#1643's own callers): called between the run and a click that
 *   lands under the slot, right after `waitForSelector("text=built successfully")`.
 *   The build bar is on screen by construction, so an empty slot is a LOST
 *   SELECTOR and the default `allowAlreadyClear: false` is correct.
 * - *At flow open* (`rag-pipeline`, `vector-store-index-query`): called once after
 *   the flow's nodes render, to clear the update banner up front so it can never
 *   overlay any of the several node-output clicks that follow. There is no build
 *   bar yet and a refreshed fixture would legitimately raise no banner at all, so
 *   these pass `allowAlreadyClear: true`. Measured on nightly 1.13.0.dev0, the
 *   banner is in the slot within **1-3 ms** of the first node title becoming
 *   visible — three fixtures, three reads — so the quiet window below (800 ms)
 *   clears the mount by more than two orders of magnitude. That margin is what
 *   makes `allowAlreadyClear` safe HERE, and it only holds if the caller gates on
 *   a rendered node first; called before the canvas paints, the helper would read
 *   an empty slot the banner has not reached yet.
 *
 * **The Dismiss button's label is plural-conditional, and matching it exactly is
 * how a private copy of this silently stops working.** Measured on 1.13.0.dev0:
 * one outdated component renders `"Dismiss"`, several render `"Dismiss All"`
 * (`split-text-chunking`'s fixture reports 1, `vector-store-index-query`'s 3,
 * `rag-pipeline`'s 6). The two hand-rolled copies this helper replaced searched
 * the whole page for the exact name `"Dismiss All"`, so they would have no-opped
 * on any flow down to its last outdated component — silently, since they treated
 * "not found" as "nothing to do". The prefix match below covers both, and is
 * pinned by a unit test rather than by this comment.
 *
 * A single empty read is deliberately NOT enough (see `EMPTY_CONFIRMATIONS`), and
 * a slot that is empty for the helper's whole life is treated as a LOST SELECTOR
 * rather than as success — see `allowAlreadyClear`.
 *
 * On timeout it throws naming what is still in the slot, so a build that makes the
 * overlay non-dismissible fails attributed instead of as an unexplained
 * `locator.click` timeout at the call site (#997/#1012).
 *
 * Upstream sources this mirrors — declared in the dependent specs' docs so
 * `watch-upstream-areas.mjs --mode=check-docs` fails the PR that renames them:
 * `src/frontend/src/pages/FlowPage/components/flowBuildingComponent/index.tsx`,
 * `src/frontend/src/pages/FlowPage/components/UpdateAllComponents/index.tsx`.
 */
export const CANVAS_BOTTOM_OVERLAY_SLOT =
  'div[class*="bottom-16"][class*="z-50"][class*="w-[530px]"]';

/** `flowBuild.buildFailed` in `locales/en.json`. The one occupant never to dismiss. */
export const BUILD_FAILED_TEXT = "Flow build failed";

export const OVERLAY_CLEAR_TIMEOUT_MS = 20000;

const POLL_MS = 200;

/**
 * How long after a successful build the update banner is un-hidden.
 *
 * NOT the exit animation, and the difference is what sizes `EMPTY_CONFIRMATIONS`.
 * `handleDismiss` sets `dismissed = true` — the bar then leaves via a framer-motion
 * exit (`duration: 0.2, delay: 0.2`, ~340 ms measured) — and SEPARATELY schedules
 * `setBuildInfo(null)` at +500 ms, which is what clears `shouldHide` and lets the
 * banner mount. The slot is therefore empty for `500 ms - exitAnimation`, measured
 * at ~89 ms on nightly 1.12.0.dev39 with a 10 ms sampler. Shorten the exit upstream
 * and that gap walks toward the full 500 ms, so the quiet window below is sized
 * against THIS constant, not against what the gap happens to be today.
 */
export const BANNER_UNHIDE_DELAY_MS = 500;

/**
 * Consecutive empty reads required before the slot counts as free.
 *
 * They span `POLL_MS * (EMPTY_CONFIRMATIONS - 1)` of observed emptiness, which must
 * exceed `BANNER_UNHIDE_DELAY_MS` — otherwise the whole window can fit inside the
 * handover gap and the helper returns into the banner's mount, which is the very
 * failure it exists to prevent. The relationship is asserted in the unit tests,
 * because it is the constants that are load-bearing here, not the loop.
 */
export const EMPTY_CONFIRMATIONS = 5;

export interface ClearCanvasBottomOverlayOptions {
  timeout?: number;
  /**
   * Accept a slot that was empty for this helper's entire life.
   *
   * Defaults to FALSE, and that is a fail-closed choice. A post-build caller
   * reaches this immediately after `waitForSelector("text=built successfully")`,
   * which proves the build bar is on screen — so "nothing ever matched" cannot mean
   * "the slot is free", it means the selector no longer matches the container
   * (a Tailwind edit upstream: `w-[530px]` -> `w-[560px]`, `bottom-16` ->
   * `bottom-20`). Returning success there would report the overlay handled while it
   * is fully present, and #1643 would come back as the unattributed 20 s
   * `locator.click` timeout — with a helper call in the trace implying otherwise.
   * Set true only for a caller that genuinely may find the slot already free —
   * today, the at-flow-open callers described above, whose banner is raised by an
   * outdated fixture and would simply not exist once that fixture is refreshed.
   */
  allowAlreadyClear?: boolean;
}

export async function clearCanvasBottomOverlay(
  page: Page,
  {
    timeout = OVERLAY_CLEAR_TIMEOUT_MS,
    allowAlreadyClear = false,
  }: ClearCanvasBottomOverlayOptions = {},
): Promise<void> {
  const slot = page.locator(CANVAS_BOTTOM_OVERLAY_SLOT);
  const deadline = Date.now() + timeout;
  let consecutiveEmpties = 0;
  let sawOccupant = false;
  let lastOccupant = "";
  let dismissClicks = 0;

  while (Date.now() < deadline) {
    if ((await slot.count()) === 0) {
      if (++consecutiveEmpties >= EMPTY_CONFIRMATIONS) {
        if (sawOccupant || allowAlreadyClear) return;
        throw new Error(
          `The canvas bottom overlay selector (${CANVAS_BOTTOM_OVERLAY_SLOT}) matched ` +
            `NOTHING for ${EMPTY_CONFIRMATIONS} consecutive reads. Callers reach this ` +
            `right after the build bar rendered, so an empty slot here means the ` +
            `selector no longer matches the container, not that the overlay is gone ` +
            `(#1643). Check the Tailwind classes on flowBuildingComponent / ` +
            `UpdateAllComponents upstream, or pass { allowAlreadyClear: true } if this ` +
            `call site can legitimately start with a free slot.`,
        );
      }
      await page.waitForTimeout(POLL_MS);
      continue;
    }

    consecutiveEmpties = 0;
    sawOccupant = true;
    const occupant = slot.first();
    lastOccupant = ((await occupant.innerText().catch(() => "")) || "")
      .replace(/\s+/g, " ")
      .trim();

    // Refused, never dismissed: this bar IS the failed run's only UI evidence.
    if (lastOccupant.includes(BUILD_FAILED_TEXT)) {
      throw new Error(
        `The canvas bottom overlay is the FAILED-BUILD bar (${JSON.stringify(
          lastOccupant,
        )}), which this helper refuses to dismiss — doing so would erase the only ` +
          `UI evidence of a failed node run, and the v2 run-stream flow-error verdict ` +
          `is advisory on 1.12.x, so the spec could go green on a build that failed ` +
          `(#1643). The caller ran a flow that did not build.`,
      );
    }

    // Scoped to the slot so this can never reach a Dismiss elsewhere on the page.
    const dismiss = occupant.getByRole("button", { name: /^dismiss/i });
    if ((await dismiss.count()) > 0) {
      dismissClicks++;
      // A click that loses its target to the same handover this helper exists for
      // is not a failure — the next poll re-reads the slot.
      await dismiss
        .first()
        .click({ timeout: 5000 })
        .catch(() => {});
    }

    await page.waitForTimeout(POLL_MS);
  }

  throw new Error(
    `The canvas bottom overlay (${CANVAS_BOTTOM_OVERLAY_SLOT}) did not clear within ` +
      `${timeout}ms, so a click under it would be refused with "subtree intercepts ` +
      `pointer events" (#1643). Still in the slot: ${JSON.stringify(lastOccupant)}. ` +
      `Dismiss clicked ${dismissClicks} time(s) — if that is > 0 the overlay stopped ` +
      `honouring its own Dismiss; if it is 0 the occupant offers none and never ` +
      `auto-dismisses. Either way this is an overlay change, not a slow test.`,
  );
}
