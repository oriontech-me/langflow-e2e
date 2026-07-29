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
//
// Every viewport read goes through `waitForViewportSettled`, whose contract is
// load-bearing rather than incidental: React Flow commits a viewport change in
// one frame, so a settle poll can hand back the PRE-action transform and redden
// an assertion about a control that worked. Read its comment before touching any
// wait in this file (#1094).

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

/**
 * A viewport plus the exact transform string it was parsed from.
 *
 * `waitForViewportSettled` returns this so a caller needing the raw string (the
 * byte-identical idempotence assertion) uses the one the wait verified instead of
 * reading the DOM again (#1099).
 */
interface SettledViewport extends Viewport {
  transform: string;
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
 * Parses a React Flow viewport transform string.
 *
 * The transform is the single source of truth for what the user sees: React Flow
 * writes `translate(<x>px, <y>px) scale(<z>)` on `.react-flow__viewport` and
 * everything on the canvas is positioned by it.
 *
 * Pure, and deliberately so (#1099): it lets a caller that has ALREADY read and
 * verified a transform turn that exact string into numbers, instead of going back
 * to the DOM for a fresh read whose value nothing has checked. See
 * `waitForViewportSettled`.
 */
function parseViewport(transform: string): Viewport {
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

/** Reads the live viewport transform and parses it. */
async function readViewport(page: Page): Promise<Viewport> {
  return parseViewport(await readTransform(page));
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
 *
 * The wait is on containment rather than on "the transform changed" (#1094): the
 * baseline this returns is the divisor of every relative zoom assertion, so it
 * must be the fitted viewport and not whatever the transform happened to hold on
 * the first read. Containment is the postcondition regardless of the entry state,
 * so this keeps working if the editor ever stops opening clamped.
 */
async function normalizeViewport(page: Page): Promise<Viewport> {
  await openCanvasControls(page);
  await page.getByTestId("fit_view").click();
  const fitted = await waitForViewportSettled(
    page,
    async () => (await measureGeometry(page)).contained,
  );
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

/** Sentinel no transform string can equal — see waitForViewportSettled. */
const UNREAD_TRANSFORM = "<unread>";

/**
 * Waits for the viewport transform to settle, then returns the settled viewport.
 *
 * `settledWhen` is the postcondition the caller actually depends on, and it is
 * mandatory reading rather than a nicety (#1094). React Flow commits a viewport
 * change in a single frame — measured: after the `fit_view` click the transform
 * still holds its pre-click value at `t+0` and carries the fitted one by
 * `t+100ms` — while `expect.poll` runs its callback immediately. Seeding
 * `previous` with a transform read BEFORE the poll therefore let the first tick
 * compare the pre-action value against itself, report "settled" and hand back the
 * STALE viewport: that is how this spec read `scale(2)` out of a Fit View that had
 * already fitted to `0.880331`. Whether the commit landed before that first read
 * came down to CDP round-trip timing, so the identical code passed in CI and
 * failed locally.
 *
 * Two guards, therefore:
 *  - `previous` starts on a sentinel, so the first tick can never resolve and the
 *    stability check always compares two reads at least one interval apart;
 *  - `settledWhen` lets a caller demand the state it is about to assert on — a
 *    transform different from the pre-action one, or the fitted geometry — so a
 *    viewport that never moved times out here, naming the wait, instead of
 *    reddening an unrelated assertion downstream.
 *
 * It defaults to "any stable transform", which is correct only where no change is
 * expected: editor hydration and the idempotent second `fit_view` click.
 *
 * What it returns is the transform the poll ACCEPTED, parsed — not a fresh read
 * (#1099). Re-reading the DOM after the poll would hand back a value nothing had
 * checked, which is the same shape of hazard as the stale read above: the guards
 * would prove one transform sound and the caller would assert on another.
 *
 * One exception, and it is the mirror image: a caller whose assertion would merely
 * RESTATE its own `settledWhen` should keep reading the DOM itself, or the
 * assertion becomes true by construction and cannot fail. See the toolbar Fit View
 * step — don't "tidy" it into `.transform`.
 */
async function waitForViewportSettled(
  page: Page,
  settledWhen: (transform: string) => boolean | Promise<boolean> = () => true,
): Promise<SettledViewport> {
  let previous = UNREAD_TRANSFORM;
  let settled = UNREAD_TRANSFORM;
  await expect
    .poll(
      async () => {
        const current = await readTransform(page);
        const stable = current !== UNREAD_TRANSFORM && current === previous;
        previous = current;
        if (!stable || !(await settledWhen(current))) return false;
        settled = current;
        return true;
      },
      {
        timeout: 15000,
        intervals: [150, 150, 150, 200],
        message: "the canvas viewport never reached the expected settled state",
      },
    )
    .toBe(true);
  return { ...parseViewport(settled), transform: settled };
}

/** `settledWhen` predicate: the viewport moved off `from` and then held. */
function movedFrom(from: string): (transform: string) => boolean {
  return (transform) => transform !== from;
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
        const before = await readTransform(page);
        await page.getByTestId("zoom_in").click();
        const zoomedIn = await waitForViewportSettled(page, movedFrom(before));

        expect(zoomedIn.scale).toBeGreaterThan(baseline.scale);
        expect(zoomedIn.scale / baseline.scale).toBeCloseTo(ZOOM_STEP, 2);
      });

      await test.step("zoom out returns the scale to its previous value", async () => {
        const before = await readTransform(page);
        await page.getByTestId("zoom_out").click();
        const zoomedOut = await waitForViewportSettled(page, movedFrom(before));

        expect(zoomedOut.scale).toBeCloseTo(baseline.scale, 3);
      });

      await test.step("zoom out clamps at the minimum zoom and disables the button", async () => {
        // `movedFrom` and not "scale is at the bound": predicating the wait on the
        // value under test would turn a wrong clamp into an opaque 15s timeout.
        // The bound itself is asserted below, off the settled read.
        const before = await readTransform(page);
        const clicks = await zoomUntilClamped(page, "zoom_out");
        // Zero clicks would mean the button was ALREADY disabled here, which the
        // `movedFrom` wait below can only report as an opaque timeout. State it as
        // a click count instead, so that failure names itself (#1099).
        expect(clicks).toBeGreaterThan(0);
        expect(clicks).toBeLessThan(MAX_ZOOM_CLICKS);

        const clamped = await waitForViewportSettled(page, movedFrom(before));
        expect(clamped.scale).toBeCloseTo(MIN_ZOOM, 4);
        await expect(page.getByTestId("zoom_out")).toBeDisabled();
        // The opposite direction must stay available at the bound.
        await expect(page.getByTestId("zoom_in")).toBeEnabled();
      });

      await test.step("zoom in clamps at the maximum zoom and disables the button", async () => {
        const before = await readTransform(page);
        const clicks = await zoomUntilClamped(page, "zoom_in");
        // Same reason as the step above (#1099).
        expect(clicks).toBeGreaterThan(0);
        expect(clicks).toBeLessThan(MAX_ZOOM_CLICKS);

        const clamped = await waitForViewportSettled(page, movedFrom(before));
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
        const before = await readTransform(page);
        const clicks = await zoomUntilClamped(page, "zoom_in");
        expect(clicks).toBeGreaterThan(0);
        expect(clicks).toBeLessThan(MAX_ZOOM_CLICKS);
        const clamped = await waitForViewportSettled(page, movedFrom(before));
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
        const displaced = await readTransform(page);
        await page.getByTestId("fit_view").click();
        const fitted = await waitForViewportSettled(page, movedFrom(displaced));
        // The transform the wait verified, not a fresh read: the step-5 assertion
        // below treats this string as canonical (#1099).
        fittedTransform = fitted.transform;

        // Sound for this fixture rather than a property of Fit View in general:
        // the two nodes span 1090 x 315 flow px against a 1000 x 672 pane, so the
        // unclamped fit is ~0.92 before fitView()'s padding, which brings it to
        // the measured 0.880331 — either way a factor of ~2.3 off the bound. A
        // fitted scale reading exactly `2` means the viewport never left the
        // max-zoom clamp, which is the failure this asserts (#1094).
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
        //
        // The one step that must NOT wait for a change — so it waits for two
        // identical reads at least one poll interval apart instead (#1094). A
        // no-op and a not-yet-committed fit are indistinguishable from the
        // transform alone; the interval is what separates them in practice, and
        // the previous step has already proven this same click does commit.
        await openCanvasControls(page);
        await page.getByTestId("fit_view").click();
        const refitted = await waitForViewportSettled(page);

        expect(refitted.transform).toBe(fittedTransform);
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
        await waitForViewportSettled(page, movedFrom(displacedTransform));

        // Deliberately a FRESH read, and the one place in this file where that is
        // the right call (#1099): asserting on the transform the wait returned
        // would restate `movedFrom`'s own precondition, so it could not fail —
        // a dead assertion. Reading again keeps it independent of the predicate,
        // so a viewport that snaps back after settling still reddens here.
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
        const before = await readTransform(page);

        await page.mouse.move(pointP.x, pointP.y);
        await page.mouse.wheel(0, WHEEL_DELTA);
        const scrolled = await waitForViewportSettled(page, movedFrom(before));

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
        const beforeTransform = await readTransform(page);

        await page.mouse.wheel(0, -WHEEL_DELTA);
        const scrolled = await waitForViewportSettled(
          page,
          movedFrom(beforeTransform),
        );

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
        const beforeTransform = await readTransform(page);

        await page.mouse.move(pointQ.x, pointQ.y);
        await page.mouse.wheel(0, WHEEL_DELTA);
        const scrolled = await waitForViewportSettled(
          page,
          movedFrom(beforeTransform),
        );

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
