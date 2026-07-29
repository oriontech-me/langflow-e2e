import type { Page } from "@playwright/test";

const CONTROLS = "canvas_controls_dropdown";
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
 * one extra poll (~50 ms). The 500 ms cap keeps the worst case no slower than
 * the sleep it replaces, should a future build ever animate the transition.
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
 * Leaves the canvas-controls menu CLOSED — whoever opened it.
 *
 * The postcondition is what the callers need, and it is deliberately not
 * expressed as a toggle. An open canvas-controls menu is a documented click
 * interceptor for the next canvas action (#576), so "close it if it is open"
 * is correct on every path; "click the trigger again" is only correct while
 * the menu happens to be open, and silently *opens* one otherwise.
 *
 * Radix renders the trigger with `data-state="open" | "closed"` (verified on
 * Nightly 1.12.0.dev7), which answers the question directly. If that attribute
 * ever disappears we fall back to intent — close only what this call opened —
 * which is still safe: it can leave a pre-existing menu open, but it can never
 * open one.
 */
async function closeCanvasControls(
  page: Page,
  openedByThisCall: boolean,
): Promise<void> {
  const controls = page.getByTestId(CONTROLS);
  const state = await controls
    .getAttribute("data-state", { timeout: 1000 })
    .catch(() => null);
  const isOpen = state === null ? openedByThisCall : state === "open";

  if (isOpen) {
    await controls.click({ force: true, timeout: 1000 });
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
 * `closeCanvasControls` and issue #997.
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
  await page.waitForSelector(`[data-testid="${CONTROLS}"]`, {
    timeout: 30000,
  });

  // Tracked separately from the `fit_view` probe below: they coincide today,
  // but only because opening immediately follows the probe. `closeCanvasControls`
  // asks "did THIS call open the menu", and that question must keep its own
  // answer if anything is ever inserted between the two.
  let openedByThisCall = false;

  if ((await page.getByTestId(FIT_VIEW).count()) === 0) {
    await page.getByTestId(CONTROLS).click();
    openedByThisCall = true;
  }

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
        `"${CONTROLS}" menu, so this means "${FIT_VIEW}" was reachable with ` +
        `that menu closed — a Langflow layout change (#997). Zooming out needs ` +
        `the menu open; teach this helper how the new layout exposes the ` +
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

  await closeCanvasControls(page, openedByThisCall);
}
