import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { createRunnableChatFlowViaApi } from "../../../helpers/flows/create-runnable-chat-flow-via-api";

// Canvas viewport controls — QA-CHECKLIST §15.5 "Canvas Zoom and Navigation":
// zoom in / zoom out, Fit View centering, the Fit View toolbar entry, and wheel
// navigation. Spec doc: docs/ui-ux/canvas-zoom-navigation.md
//
// Every assertion reads the React Flow viewport transform
// (`.react-flow__viewport` -> `transform: translate(<x>px, <y>px) scale(<z>)`)
// and the on-screen geometry of the nodes against the pane. A control that
// renders, is enabled and is clickable but is no longer wired to the viewport
// passes a "button is visible" check and fails these.
//
// Not covered here (deliberately): pane drag/pan and node movement (§15.4), and
// the minimap (§15.5 `[~]`, feature-flag-gated — no minimap element is rendered
// on 1.12.0.dev6). `reset_zoom` has no §15.5 bullet; it is only asserted as one
// of the four controls the toolbar dropdown must expose.
//
// The flow is a repo-owned Chat Input -> Chat Output fixture created through the
// API: no starter template, no provider key, no LLM call and no flow build, so
// the spec is pure viewport geometry.

// React Flow bounds configured by Langflow. A silent change to either bound is a
// product change this spec is meant to catch.
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2;
// Zoom step applied per zoom_in / zoom_out click.
const ZOOM_STEP = 1.2;
// Bounded loops for "click until the button disables" — the range 0.25..2 at a
// 1.2 factor needs ~12 clicks, so these can only be reached if the button never
// disables (which is itself the failure).
const MAX_ZOOM_CLICKS = 30;
// Pixel tolerances. Fit View centering measured 1px / 0px live; the pointer
// anchor measured sub-pixel. Both are kept tight enough to fail a broken
// implementation and loose enough to absorb React Flow's float rounding.
const CENTERING_TOLERANCE_PX = 4;
const CONTAINMENT_TOLERANCE_PX = 1;
const ANCHOR_TOLERANCE_PX = 2;
// Wheel delta per scroll gesture (one notch is 100; 300 is a comfortable
// three-notch gesture that crosses at least one zoom step).
const WHEEL_DELTA = 300;

interface Viewport {
  x: number;
  y: number;
  scale: number;
}

interface Geometry {
  /** Distance between the nodes' union-box center and the pane center. */
  centerDeltaX: number;
  centerDeltaY: number;
  /** True when every node's box sits inside the pane rect. */
  contained: boolean;
  nodeCount: number;
}

/**
 * Reads the live React Flow viewport transform.
 *
 * The transform is the single source of truth for what the user sees: React Flow
 * writes `translate(<x>px, <y>px) scale(<z>)` on `.react-flow__viewport` and
 * everything on the canvas is positioned by it.
 */
async function readViewport(page: Page): Promise<Viewport> {
  const transform = await page
    .locator(".react-flow__viewport")
    .evaluate((el) => (el as HTMLElement).style.transform);

  const match = transform.match(
    /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)\s*scale\(([\d.]+)\)/,
  );
  expect(match, `unparsable viewport transform: "${transform}"`).not.toBeNull();

  return {
    x: Number(match![1]),
    y: Number(match![2]),
    scale: Number(match![3]),
  };
}

/** Raw transform string — used for the byte-identical idempotence assertion. */
async function readTransform(page: Page): Promise<string> {
  return page
    .locator(".react-flow__viewport")
    .evaluate((el) => (el as HTMLElement).style.transform);
}

/**
 * Measures the nodes' union bounding box against the canvas pane, in viewport
 * (screen) pixels — the geometry a user judges "everything is visible and
 * centered" by.
 */
async function measureGeometry(page: Page): Promise<Geometry> {
  return page.evaluate((tolerance) => {
    const nodes = Array.from(document.querySelectorAll(".react-flow__node"));
    const pane = document
      .querySelector(".react-flow__pane")!
      .getBoundingClientRect();
    const boxes = nodes.map((n) => n.getBoundingClientRect());

    const union = {
      left: Math.min(...boxes.map((b) => b.left)),
      right: Math.max(...boxes.map((b) => b.right)),
      top: Math.min(...boxes.map((b) => b.top)),
      bottom: Math.max(...boxes.map((b) => b.bottom)),
    };

    return {
      centerDeltaX: (union.left + union.right) / 2 - (pane.left + pane.right) / 2,
      centerDeltaY: (union.top + union.bottom) / 2 - (pane.top + pane.bottom) / 2,
      contained:
        union.left >= pane.left - tolerance &&
        union.right <= pane.right + tolerance &&
        union.top >= pane.top - tolerance &&
        union.bottom <= pane.bottom + tolerance,
      nodeCount: nodes.length,
    };
  }, CONTAINMENT_TOLERANCE_PX);
}

/** The canvas pane rect, for placing the mouse at known pane-relative points. */
async function paneBox(page: Page) {
  const box = await page.locator(".react-flow__pane").boundingBox();
  expect(box, "canvas pane has no bounding box").not.toBeNull();
  return box!;
}

/**
 * Expands the canvas-controls dropdown if it is collapsed.
 *
 * On 1.12 `zoom_in` / `zoom_out` / `reset_zoom` / `fit_view` are NOT in the DOM
 * until `canvas_controls_dropdown` is clicked, so every control interaction has
 * to go through here. Idempotent: a no-op when the controls are already out.
 *
 * Shares a NAME with `helpers/ui/canvas-controls.ts` but not a signature or a
 * job — see `closeCanvasControls` below for why this spec keeps its own pair.
 */
async function openCanvasControls(page: Page): Promise<void> {
  if ((await page.getByTestId("fit_view").count()) === 0) {
    await page.getByTestId("canvas_controls_dropdown").click();
    await expect(page.getByTestId("fit_view")).toBeVisible({ timeout: 15000 });
  }
}

/**
 * Brings the viewport to the canonical fitted state and collapses the controls.
 *
 * Needed because the editor does NOT open on the flow's persisted viewport: on
 * 1.12.0.dev6 it opens clamped at the maximum zoom (`scale(2)`, `zoom_in`
 * already disabled — reproducible across reloads). Without normalizing, "zoom in
 * raises the scale" is untestable, so each test that measures relative zoom
 * starts from the deterministic Fit View state instead.
 */
async function normalizeViewport(page: Page): Promise<Viewport> {
  await openCanvasControls(page);
  await page.getByTestId("fit_view").click();
  const fitted = await waitForViewportSettled(page);
  await closeCanvasControls(page);
  return fitted;
}

/**
 * Collapses the controls dropdown — its popover swallows wheel events.
 *
 * The click is forced: while the dropdown is open its Radix overlay covers the
 * trigger, so a normal click never passes Playwright's hit-test (same reason
 * `closeCanvasControls` forces this exact click in
 * `helpers/ui/canvas-controls.ts`).
 *
 * NOT that shared helper, despite the shared name. The shared one takes the
 * postcondition "leave the menu closed, whoever opened it" and reads it off the
 * trigger's `data-state`; this local probes `fit_view` in both directions and
 * asserts the transition, because observing expand/collapse is what this spec
 * exists to validate rather than something it reaches past (#1053).
 */
async function closeCanvasControls(page: Page): Promise<void> {
  if ((await page.getByTestId("fit_view").count()) > 0) {
    await page.getByTestId("canvas_controls_dropdown").click({ force: true });
    await expect(page.getByTestId("fit_view")).toHaveCount(0, { timeout: 15000 });
  }
}

/**
 * Clicks a zoom button until it disables, and returns how many clicks landed.
 * Bounded so a never-disabling button fails on the assertion, not on a hang.
 */
async function zoomUntilClamped(
  page: Page,
  testId: "zoom_in" | "zoom_out",
): Promise<number> {
  const button = page.getByTestId(testId);
  let clicks = 0;
  while (clicks < MAX_ZOOM_CLICKS && !(await button.isDisabled())) {
    await button.click();
    clicks += 1;
  }
  return clicks;
}

/**
 * Waits for the viewport transform to settle (React Flow animates zoom/fit
 * transitions), then returns the settled viewport. Polls the transform instead
 * of sleeping a fixed amount, so the wait tracks the real animation.
 */
async function waitForViewportSettled(page: Page): Promise<Viewport> {
  let previous = await readTransform(page);
  await expect
    .poll(
      async () => {
        const current = await readTransform(page);
        const stable = current === previous;
        previous = current;
        return stable;
      },
      { timeout: 15000, intervals: [150, 150, 150, 200] },
    )
    .toBe(true);
  return readViewport(page);
}

/** The flow-space point under a screen point, given the current viewport. */
function toFlowCoords(
  viewport: Viewport,
  screenX: number,
  screenY: number,
  pane: { x: number; y: number },
): { x: number; y: number } {
  // Screen -> pane-relative -> flow space (React Flow's own inverse transform).
  return {
    x: (screenX - pane.x - viewport.x) / viewport.scale,
    y: (screenY - pane.y - viewport.y) / viewport.scale,
  };
}

test.describe("ui-ux — canvas zoom and navigation", () => {
  let flowId: string;
  let removeFlow: (reqOverride?: APIRequestContext) => Promise<void>;

  test.beforeEach(async ({ page, request }) => {
    const token = await getAuthToken(request);
    const flow = await createRunnableChatFlowViaApi(request, {
      Authorization: token,
    });
    flowId = flow.flowId;
    removeFlow = flow.deleteFlow;

    await page.goto(`/flow/${flowId}`);
    // Gate on the editor itself, not just the route: the controls trigger is
    // the canvas-ready signal used across the suite.
    await expect(page.getByTestId("canvas_controls_dropdown")).toBeVisible({
      timeout: 30000,
    });
    await expect(page.getByTestId("title-Chat Input")).toBeVisible({
      timeout: 30000,
    });
    // The stored viewport is applied on hydration; start from a settled one.
    await waitForViewportSettled(page);
  });

  test.afterEach(async ({ page, request }) => {
    // Unmount the editor before deleting: the open editor polls
    // GET /flows/{id}/events and a mid-poll delete 404s into the fixture's
    // backend-error monitor.
    await page.goto("/").catch(() => {});
    await removeFlow(request);
  });

  test("zoom in and zoom out step the canvas scale and clamp at the React Flow bounds",
    { tag: ["@stable", "@workspace", "@ui-ux"] },
    async ({ page }) => {
      let baseline: Viewport;

      await test.step("start from the fitted viewport with the controls expanded", async () => {
        baseline = await normalizeViewport(page);
        await openCanvasControls(page);
        await expect(page.getByTestId("zoom_in")).toBeEnabled();
        await expect(page.getByTestId("zoom_out")).toBeEnabled();
      });

      await test.step("zoom in multiplies the scale by the zoom step", async () => {
        await page.getByTestId("zoom_in").click();
        const zoomedIn = await waitForViewportSettled(page);

        expect(zoomedIn.scale).toBeGreaterThan(baseline.scale);
        expect(zoomedIn.scale / baseline.scale).toBeCloseTo(ZOOM_STEP, 2);
      });

      await test.step("zoom out returns the scale to its previous value", async () => {
        await page.getByTestId("zoom_out").click();
        const zoomedOut = await waitForViewportSettled(page);

        expect(zoomedOut.scale).toBeCloseTo(baseline.scale, 3);
      });

      await test.step("zoom out clamps at the minimum zoom and disables the button", async () => {
        const clicks = await zoomUntilClamped(page, "zoom_out");
        expect(clicks).toBeLessThan(MAX_ZOOM_CLICKS);

        const clamped = await waitForViewportSettled(page);
        expect(clamped.scale).toBeCloseTo(MIN_ZOOM, 4);
        await expect(page.getByTestId("zoom_out")).toBeDisabled();
        // The opposite direction must stay available at the bound.
        await expect(page.getByTestId("zoom_in")).toBeEnabled();
      });

      await test.step("zoom in clamps at the maximum zoom and disables the button", async () => {
        const clicks = await zoomUntilClamped(page, "zoom_in");
        expect(clicks).toBeLessThan(MAX_ZOOM_CLICKS);

        const clamped = await waitForViewportSettled(page);
        expect(clamped.scale).toBeCloseTo(MAX_ZOOM, 4);
        await expect(page.getByTestId("zoom_in")).toBeDisabled();
        await expect(page.getByTestId("zoom_out")).toBeEnabled();
      });
    });

  test("Fit View centers every node inside the canvas viewport",
    { tag: ["@stable", "@workspace", "@ui-ux"] },
    async ({ page }) => {
      await test.step("displace the viewport to the maximum zoom", async () => {
        // Zoom in from the fitted state, so the displacement is the test's own
        // doing rather than the editor's entry state.
        await normalizeViewport(page);
        await openCanvasControls(page);
        const clicks = await zoomUntilClamped(page, "zoom_in");
        expect(clicks).toBeGreaterThan(0);
        expect(clicks).toBeLessThan(MAX_ZOOM_CLICKS);
        const clamped = await waitForViewportSettled(page);
        expect(clamped.scale).toBeCloseTo(MAX_ZOOM, 4);
      });

      await test.step("the graph overflows the pane before Fit View", async () => {
        // Precondition with teeth: without it, a canvas that is already fitted
        // would let the assertions below pass on a dead Fit View button.
        const overflowing = await measureGeometry(page);
        expect(overflowing.nodeCount).toBeGreaterThan(0);
        expect(overflowing.contained).toBe(false);
      });

      let fittedTransform = "";

      await test.step("Fit View brings every node inside the pane, centered", async () => {
        await openCanvasControls(page);
        await page.getByTestId("fit_view").click();
        const fitted = await waitForViewportSettled(page);
        fittedTransform = await readTransform(page);

        expect(fitted.scale).toBeLessThan(MAX_ZOOM);

        const geometry = await measureGeometry(page);
        expect(geometry.contained).toBe(true);
        expect(Math.abs(geometry.centerDeltaX)).toBeLessThanOrEqual(
          CENTERING_TOLERANCE_PX,
        );
        expect(Math.abs(geometry.centerDeltaY)).toBeLessThanOrEqual(
          CENTERING_TOLERANCE_PX,
        );

        await expect(page.getByTestId("title-Chat Input")).toBeVisible();
        await expect(page.getByTestId("title-Chat Output")).toBeVisible();
      });

      await test.step("a second Fit View click is a no-op", async () => {
        // Idempotence is the contract the suite's adjustScreenView helper relies
        // on: fitting twice must not drift the viewport.
        await openCanvasControls(page);
        await page.getByTestId("fit_view").click();
        await waitForViewportSettled(page);

        expect(await readTransform(page)).toBe(fittedTransform);
      });
    });

  test("Fit View is reachable from the canvas controls toolbar",
    { tag: ["@stable", "@workspace", "@ui-ux"] },
    async ({ page }) => {
      const controlTestIds = ["fit_view", "zoom_in", "zoom_out", "reset_zoom"];

      await test.step("the toolbar renders with the zoom controls collapsed", async () => {
        await expect(page.getByTestId("main_canvas_controls")).toBeVisible();
        await expect(page.getByTestId("canvas_controls_dropdown")).toBeVisible();
        for (const testId of controlTestIds) {
          await expect(page.getByTestId(testId)).toHaveCount(0);
        }
      });

      await test.step("expanding the dropdown exposes all four controls", async () => {
        await page.getByTestId("canvas_controls_dropdown").click();
        for (const testId of controlTestIds) {
          await expect(page.getByTestId(testId)).toBeVisible({ timeout: 15000 });
        }
        // Only these two are asserted enabled here: the editor opens clamped at
        // the maximum zoom, so `zoom_in` is legitimately disabled until the
        // viewport moves (asserted below, right after Fit View).
        await expect(page.getByTestId("fit_view")).toBeEnabled();
        await expect(page.getByTestId("reset_zoom")).toBeEnabled();
      });

      await test.step("the toolbar Fit View acts on the displaced entry viewport", async () => {
        const displacedTransform = await readTransform(page);
        expect((await measureGeometry(page)).contained).toBe(false);

        await page.getByTestId("fit_view").click();
        await waitForViewportSettled(page);

        expect(await readTransform(page)).not.toBe(displacedTransform);
        expect((await measureGeometry(page)).contained).toBe(true);
        // Off the zoom bound, both zoom controls are live again.
        await expect(page.getByTestId("zoom_in")).toBeEnabled();
        await expect(page.getByTestId("zoom_out")).toBeEnabled();
      });

      await test.step("collapsing the dropdown removes the controls again", async () => {
        // Forced click: the open popover's overlay covers the trigger (see
        // closeCanvasControls).
        await page.getByTestId("canvas_controls_dropdown").click({ force: true });
        for (const testId of controlTestIds) {
          await expect(page.getByTestId(testId)).toHaveCount(0, {
            timeout: 15000,
          });
        }
      });

      await test.step("the dropdown can be expanded again", async () => {
        await page.getByTestId("canvas_controls_dropdown").click();
        for (const testId of controlTestIds) {
          await expect(page.getByTestId(testId)).toBeVisible({ timeout: 15000 });
        }
      });
    });

  test("wheel scroll navigates the canvas anchored at the pointer",
    { tag: ["@stable", "@workspace", "@ui-ux"] },
    async ({ page }) => {
      // Start off the maximum-zoom entry clamp (a clamped viewport cannot zoom
      // in) and with the dropdown closed — its popover swallows wheel events.
      const baseline = await normalizeViewport(page);

      const pane = await paneBox(page);
      const pointP = {
        x: pane.x + pane.width / 3,
        y: pane.y + pane.height / 2,
      };
      const pointQ = {
        x: pane.x + (pane.width * 2) / 3,
        y: pane.y + pane.height / 3,
      };

      await test.step("scrolling down zooms out around the pointer", async () => {
        const anchorBefore = toFlowCoords(baseline, pointP.x, pointP.y, pane);

        await page.mouse.move(pointP.x, pointP.y);
        await page.mouse.wheel(0, WHEEL_DELTA);
        const scrolled = await waitForViewportSettled(page);

        expect(scrolled.scale).toBeLessThan(baseline.scale);

        const anchorAfter = toFlowCoords(scrolled, pointP.x, pointP.y, pane);
        expect(Math.abs(anchorAfter.x - anchorBefore.x)).toBeLessThanOrEqual(
          ANCHOR_TOLERANCE_PX,
        );
        expect(Math.abs(anchorAfter.y - anchorBefore.y)).toBeLessThanOrEqual(
          ANCHOR_TOLERANCE_PX,
        );
      });

      await test.step("scrolling up restores the previous zoom level", async () => {
        const before = await readViewport(page);
        const anchorBefore = toFlowCoords(before, pointP.x, pointP.y, pane);

        await page.mouse.wheel(0, -WHEEL_DELTA);
        const scrolled = await waitForViewportSettled(page);

        expect(scrolled.scale).toBeGreaterThan(before.scale);
        expect(scrolled.scale).toBeCloseTo(baseline.scale, 3);

        const anchorAfter = toFlowCoords(scrolled, pointP.x, pointP.y, pane);
        expect(Math.abs(anchorAfter.x - anchorBefore.x)).toBeLessThanOrEqual(
          ANCHOR_TOLERANCE_PX,
        );
        expect(Math.abs(anchorAfter.y - anchorBefore.y)).toBeLessThanOrEqual(
          ANCHOR_TOLERANCE_PX,
        );
      });

      await test.step("the anchor follows the pointer to a second position", async () => {
        // A zoom pinned to the pane center (instead of the cursor) passes the
        // steps above only by luck and fails here.
        const before = await readViewport(page);
        const anchorBefore = toFlowCoords(before, pointQ.x, pointQ.y, pane);

        await page.mouse.move(pointQ.x, pointQ.y);
        await page.mouse.wheel(0, WHEEL_DELTA);
        const scrolled = await waitForViewportSettled(page);

        expect(scrolled.scale).toBeLessThan(before.scale);

        const anchorAfter = toFlowCoords(scrolled, pointQ.x, pointQ.y, pane);
        expect(Math.abs(anchorAfter.x - anchorBefore.x)).toBeLessThanOrEqual(
          ANCHOR_TOLERANCE_PX,
        );
        expect(Math.abs(anchorAfter.y - anchorBefore.y)).toBeLessThanOrEqual(
          ANCHOR_TOLERANCE_PX,
        );
      });
    });
});
