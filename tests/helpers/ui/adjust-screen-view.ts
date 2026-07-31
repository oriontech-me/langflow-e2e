import type { Page } from "@playwright/test";
import {
  CANVAS_CONTROLS,
  closeCanvasControls,
  openCanvasControls,
} from "./canvas-controls";

const FIT_VIEW = "fit_view";
const ZOOM_OUT = "zoom_out";
const VIEWPORT = ".react-flow__viewport";

/**
 * Waits for React Flow's viewport transform to stop changing.
 *
 * Replaces a fixed `waitForTimeout(500)`. Measured on Nightly 1.12.0.dev7:
 * `CanvasControlsDropdown` calls React Flow's `fitView()` with no `duration`,
 * so the new transform is applied in a single frame — the viewport's `style`
 * reached its final value between the 20 ms and 47 ms samples after the click
 * and never moved again. The sleep was therefore paying ~450 ms on every call,
 * on every one of this helper's dependent specs.
 *
 * Two consecutive identical reads count as settled, so the common case costs
 * one extra poll (~50 ms). The cap bounds the worst case at roughly the 500 ms
 * sleep this replaced — not exactly: a read that burns its 200 ms timeout just
 * before the deadline, plus the trailing 50 ms wait, overshoots to ~750 ms.
 *
 * THE TWO-EQUAL-READS RULE IS LOAD-BEARING ON `fitView()` BEING UNANIMATED.
 * With an instantaneous transform, two equal reads can only mean "already
 * final". Animate the transition and that stops being true — two 50 ms samples
 * can coincide mid-movement (a paused frame, an eased segment, a duration under
 * the sample interval) and the poll would return on a transform that is still
 * travelling. The 500 ms cap does NOT cover that: it bounds how long this waits,
 * not whether what it settled on is final. If a future build animates the
 * canvas controls, this function needs a different stop condition — poll for a
 * stable read over a minimum span, or wait on React Flow's own transition end.
 */
async function waitForViewportSettled(page: Page): Promise<void> {
  const viewport = page.locator(VIEWPORT);
  const deadline = Date.now() + 500;
  let previous: string | null = null;

  while (Date.now() < deadline) {
    // Short per-read timeout: the default actionTimeout (20 s) would turn a
    // missing viewport into a 20 s stall instead of a poll that just retries.
    // The catch covers an absent viewport AND a strict-mode violation (should a
    // build ever render two of them); either way the loop simply runs out its
    // budget and the helper degrades to the 500 ms sleep this replaced — never
    // worse than the previous behaviour, but silently so.
    const current = await viewport
      .getAttribute("style", { timeout: 200 })
      .catch(() => null);
    if (current !== null && current === previous) return;
    previous = current;
    await page.waitForTimeout(50);
  }
}

/**
 * Fits the canvas to the flow, optionally zooms out, and returns with the
 * canvas-controls menu closed.
 *
 * `fit_view` and `zoom_out` are rendered inside the dropdown's menu content
 * (`CanvasControlsDropdown.tsx`), so on today's build they exist only while the
 * menu is open — which is why this helper opens it first. They are plain
 * buttons rather than menu items, so clicking them does not dismiss the menu
 * and the zoom-out loop below still finds its target.
 *
 * That layout is a property of the current UI, not a contract: the day Langflow
 * surfaces the fit-view control directly on the canvas, `fit_view` is present
 * with the menu closed. This helper must not open a menu in that case — see
 * `./canvas-controls` and issue #997.
 *
 * What it deliberately does NOT do is survive a *partial* migration — fit-view
 * moved out, zoom-out left behind. Zooming out would then need a menu this call
 * had no reason to open, and guessing at a layout no build has shipped is how a
 * helper on 108 specs grows an untestable branch. It throws instead, naming the
 * cause: a loud, attributed failure is the whole point of #997, whose bug was
 * dormant precisely because it failed quietly.
 */
export async function adjustScreenView(
  page: Page,
  {
    numberOfZoomOut = 1,
  }: {
    numberOfZoomOut?: number;
  } = {},
) {
  await page.waitForSelector(`[data-testid="${CANVAS_CONTROLS}"]`, {
    timeout: 30000,
  });

  const openedByThisCall = await openCanvasControls(page, FIT_VIEW);

  await page.getByTestId(FIT_VIEW).click();
  await waitForViewportSettled(page);

  if (
    numberOfZoomOut > 0 &&
    (await page.getByTestId(ZOOM_OUT).count()) === 0
  ) {
    // Fail here rather than on a 1 s `isDisabled` timeout inside the loop, whose
    // message says nothing about why the control is missing.
    throw new Error(
      `[adjustScreenView] "${ZOOM_OUT}" is not rendered. On the build this ` +
        `helper was written against, the canvas controls live inside the ` +
        `"${CANVAS_CONTROLS}" menu, so this means "${FIT_VIEW}" was reachable ` +
        `with that menu closed — a Langflow layout change (#997). Zooming out ` +
        `needs the menu open; teach this helper how the new layout exposes the ` +
        `controls rather than reintroducing a blind toggle.`,
    );
  }

  for (let i = 0; i < numberOfZoomOut; i++) {
    const zoomOutButton = page.getByTestId(ZOOM_OUT);

    if (await zoomOutButton.isDisabled({ timeout: 1000 })) {
      break;
    } else {
      await zoomOutButton.click({ timeout: 1000 });
    }
  }

  await closeCanvasControls(page, openedByThisCall, "adjustScreenView");
}
