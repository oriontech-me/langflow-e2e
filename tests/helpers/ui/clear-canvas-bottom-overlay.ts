import type { Page } from "@playwright/test";

/**
 * Frees the canvas' bottom-centre overlay slot before a click that lands under it.
 *
 * Langflow renders TWO different components into one fixed container —
 * `absolute bottom-16 left-1/2 z-50 w-[530px] -translate-x-1/2` — sitting over the
 * canvas, and they hand the slot to each other:
 *
 * - `flowBuildingComponent` — the build-status bar ("Flow built successfully", the
 *   building progress, "Build failed"). **Transient on success**: it auto-dismisses
 *   2 s after the run finishes, plus a 500 ms exit animation.
 * - `UpdateAllComponents` — the "Flow needs review / N components need updates"
 *   banner. Its `shouldHide` includes `isBuilding || buildInfo?.error ||
 *   buildInfo?.success`, so it is **hidden while the build bar is up and takes the
 *   slot back the moment the bar dismisses** — and then stays there indefinitely.
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
 * "does it offer a Dismiss button".** That is exactly right for both components: the
 * update banner always offers one until every component is dismissed, and the build
 * bar offers one only in its `buildInfo.error` state — the one state where it, too,
 * never leaves. Callers reach this helper after asserting the run succeeded, so the
 * error bar is not a state this can silence.
 *
 * A single empty read is deliberately NOT enough (see `EMPTY_CONFIRMATIONS`): the
 * slot is genuinely empty for a tick between the bar unmounting and the banner
 * mounting, and returning there would hand the caller a click that races the banner.
 *
 * On timeout it throws naming what is still in the slot, so a future build that
 * makes the overlay non-dismissible fails attributed instead of as an unexplained
 * `locator.click` timeout at the call site (#997/#1012).
 */
export const CANVAS_BOTTOM_OVERLAY_SLOT =
  'div[class*="bottom-16"][class*="z-50"][class*="w-[530px]"]';

/** Covers the build bar's 2 s auto-dismiss + 500 ms exit with a wide margin. */
export const OVERLAY_CLEAR_TIMEOUT_MS = 20000;

const POLL_MS = 200;

/**
 * Consecutive empty reads required before the slot counts as free.
 *
 * Two, because the bar → banner handover leaves the slot empty for one render
 * tick. One read would return exactly into the banner's mount.
 */
export const EMPTY_CONFIRMATIONS = 2;

export interface ClearCanvasBottomOverlayOptions {
  timeout?: number;
}

export async function clearCanvasBottomOverlay(
  page: Page,
  { timeout = OVERLAY_CLEAR_TIMEOUT_MS }: ClearCanvasBottomOverlayOptions = {},
): Promise<void> {
  const slot = page.locator(CANVAS_BOTTOM_OVERLAY_SLOT);
  const deadline = Date.now() + timeout;
  let consecutiveEmpties = 0;
  let lastOccupant = "";
  let dismissClicks = 0;

  while (Date.now() < deadline) {
    if ((await slot.count()) === 0) {
      if (++consecutiveEmpties >= EMPTY_CONFIRMATIONS) return;
      await page.waitForTimeout(POLL_MS);
      continue;
    }

    consecutiveEmpties = 0;
    const occupant = slot.first();
    lastOccupant = ((await occupant.innerText().catch(() => "")) || "")
      .replace(/\s+/g, " ")
      .trim();

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
