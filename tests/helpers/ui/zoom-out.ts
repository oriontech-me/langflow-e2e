import type { Page } from "@playwright/test";
import {
  CANVAS_CONTROLS,
  closeCanvasControls,
  openCanvasControls,
} from "./canvas-controls";

const ZOOM_OUT = "zoom_out";

/**
 * Zooms the canvas out `times` steps, returning with the canvas-controls menu
 * closed.
 *
 * Reach is wider than the 18 spec files that import this directly:
 * `setup-playground` calls it too, and 24 specs go through that. So the
 * postcondition below is load-bearing on roughly 38 specs — a leftover open menu
 * intercepts the next canvas click (#576) and surfaces as a playground or agent
 * failure, nowhere near this helper.
 *
 * Before #1053 the trailing close was a toggle guarded on a count that had been
 * REASSIGNED after opening the menu, so the guard was true on both paths — the
 * #997 defect verbatim. Dormant only because every canvas control currently
 * lives inside the menu; see `./canvas-controls`.
 */
export async function zoomOut(page: Page, times: number = 2) {
  await page.waitForSelector(`[data-testid="${CANVAS_CONTROLS}"]`, {
    timeout: 3000,
  });

  const openedByThisCall = await openCanvasControls(page, ZOOM_OUT);

  for (let i = 0; i < times; i++) {
    await page.getByTestId(ZOOM_OUT).click();
  }

  await closeCanvasControls(page, openedByThisCall, "zoomOut");
}
