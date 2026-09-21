import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { createRunnableChatFlowViaApi } from "../../../helpers/flows/create-runnable-chat-flow-via-api";

// Canvas pan by dragging the empty pane — QA-CHECKLIST §15.4.
// Spec doc: docs/flow-functionality/canvas-pan-drag.md
//
// This is the surviving deliverable of the Wave 9 T2 triage of the canvas
// viewport cluster (#1910). It replaces the one test in the retired
// `canvas-scroll-navigation.spec.ts` that had no `@stable` replacement
// elsewhere. The other two tests there, and all four in the retired
// `canvas-zoom-fitview.spec.ts`, are covered by `ui-ux/canvas-zoom-navigation`.
//
// The retired test never tested what it was named: "panning canvas by dragging
// empty area" implemented Shift + vertical wheel, which on this build is not a
// pan at all (Shift+drag is React Flow's marquee — see
// `flow-functionality/canvas-multiselect.spec.ts`). It then asserted only that
// the transform string differed afterwards, which any viewport movement
// satisfies, including the zoom a wheel event actually produces.
//
// THE ASSERTION IS A DELTA, AND THAT IS WHAT KEEPS THIS SPEC SMALL. React Flow
// pans in *screen* space, so the viewport `translate` moves by exactly the
// cursor delta at any zoom — measured on 1.13.0.dev19 at `scale(0.578704)`, a
// (+120, +80) drag moved `translate(210.648px, 141.556px)` to
// `translate(330.648px, 221.556px)` with the scale byte-identical. So this spec
// never normalizes the viewport, never clicks `fit_view` and never opens the
// canvas-controls menu: it reads whatever the entry viewport is and asserts how
// it MOVED. That sidesteps #1645 — the entry state is a product decision no test
// may depend on, and it has already changed once under the sibling spec — by
// construction rather than by compensating for it.

/** Cursor delta of the drag, in screen pixels. Arbitrary, but off-axis on both. */
const DRAG_DX = 150;
const DRAG_DY = 116;

/**
 * Absorbs React Flow's sub-pixel rounding on the translate comparison.
 *
 * Both live measurements landed exactly on the cursor delta, so this is
 * headroom, not a measured need — kept small enough that a pan wired to the
 * wrong axis or scaled by the zoom still fails.
 */
const TRANSLATE_TOLERANCE_PX = 2;

/** Intermediate `pointermove` events per drag. */
const DRAG_STEPS = 12;

interface Viewport {
  x: number;
  y: number;
  scale: number;
  /** The raw `transform` string, for byte-identical comparisons. */
  transform: string;
}

const TRANSFORM_RE =
  /translate\(\s*(-?[\d.]+)px\s*,\s*(-?[\d.]+)px\s*\)\s*scale\(\s*([\d.]+)\s*\)/;

/**
 * Reads and parses the React Flow viewport transform.
 *
 * Deliberately local rather than extracted to `tests/helpers/ui/`. What this
 * spec needs is a strict subset of the reader `ui-ux/canvas-zoom-navigation`
 * carries locally, whose settle poll takes a predicate and an `UNREAD_TRANSFORM`
 * sentinel tuned to #1094; extracting that would mean editing a `@stable` spec
 * this issue does not own. Consolidating the three viewport readers in the repo
 * (here, that spec, and the private one in `helpers/ui/adjust-screen-view.ts`)
 * is a follow-up, not this issue's scope.
 */
async function readViewport(page: Page): Promise<Viewport> {
  const transform =
    (await page.locator(".react-flow__viewport").getAttribute("style")) ?? "";
  const match = TRANSFORM_RE.exec(transform);
  if (!match) {
    throw new Error(
      `[canvas-pan-drag] could not parse the React Flow viewport transform. ` +
        `Expected "translate(<x>px, <y>px) scale(<z>)", read: ${JSON.stringify(transform)}. ` +
        `A build that changes the transform's shape breaks every assertion here, ` +
        `so this fails naming the cause rather than reading a default.`,
    );
  }
  return {
    x: Number(match[1]),
    y: Number(match[2]),
    scale: Number(match[3]),
    transform,
  };
}

/**
 * Resolves once two consecutive reads of the transform agree.
 *
 * The entry transform is applied on hydration and is not animated on this path,
 * so two equal reads can only mean "already final" — the same rule
 * `helpers/ui/adjust-screen-view.ts` documents, and it is load-bearing for the
 * same reason: animate the canvas and two samples could coincide mid-movement.
 * Nothing here clicks a control, so the only motion to outlast is hydration.
 */
async function waitForViewportSettled(page: Page): Promise<Viewport> {
  let previous = "";
  let settled = "";
  await expect
    .poll(
      async () => {
        const current = (await readViewport(page)).transform;
        const stable = current !== "" && current === previous;
        previous = current;
        if (stable) settled = current;
        return stable;
      },
      {
        timeout: 15000,
        intervals: [150, 150, 150, 200],
        message: "the canvas viewport transform never settled",
      },
    )
    .toBe(true);
  expect(settled).not.toBe("");
  return readViewport(page);
}

/**
 * A point on genuinely empty canvas, verified rather than assumed.
 *
 * The gesture is only a pan when it starts on the pane itself: starting it on a
 * node drags the node (§15.4 `canvas-move-node.spec.ts`) and starting it on the
 * canvas-controls toolbar hits a control. `elementFromPoint` is the load-bearing
 * check — it covers the node boxes, the toolbar, and anything a future build
 * floats over the canvas, in one condition that cannot go stale the way a
 * hardcoded corner would.
 *
 * Throws naming the failure rather than falling back to an arbitrary point: a
 * viewport result about a gesture the test never performed is the silent false
 * negative this spec exists to avoid.
 */
async function findEmptyPanePoint(
  page: Page,
  dx: number,
  dy: number,
): Promise<{ x: number; y: number }> {
  const pane = page.locator(".react-flow__pane");
  const box = await pane.boundingBox();
  if (!box) {
    throw new Error(
      "[canvas-pan-drag] `.react-flow__pane` has no bounding box — the canvas " +
        "is not laid out, so no drag origin can be resolved.",
    );
  }

  // Candidates in the pane's interior, inset far enough that the drag's end
  // point (origin + delta) also stays inside the pane.
  const inset = 80;
  const candidates: Array<{ x: number; y: number }> = [];
  for (const fx of [0.5, 0.3, 0.7, 0.2, 0.8]) {
    for (const fy of [0.75, 0.5, 0.25]) {
      const x = box.x + box.width * fx;
      const y = box.y + box.height * fy;
      if (
        x >= box.x + inset &&
        y >= box.y + inset &&
        x + dx <= box.x + box.width - inset &&
        y + dy <= box.y + box.height - inset
      ) {
        candidates.push({ x, y });
      }
    }
  }

  for (const point of candidates) {
    const onPane = await page.evaluate(
      ({ x, y }) =>
        document.elementFromPoint(x, y)?.classList.contains("react-flow__pane") ??
        false,
      point,
    );
    if (onPane) return point;
  }

  throw new Error(
    `[canvas-pan-drag] no drag origin on empty canvas: none of the ` +
      `${candidates.length} candidate points inside the pane resolved to ` +
      `".react-flow__pane" via elementFromPoint. Something is covering the ` +
      `canvas (an overlay, a moved node, a relocated controls toolbar) — ` +
      `dragging anyway would report a viewport result about a gesture that was ` +
      `never a pan.`,
  );
}

/** Presses at `from`, moves to `from + delta` in steps, releases. */
async function dragPane(
  page: Page,
  from: { x: number; y: number },
  dx: number,
  dy: number,
): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  // Steps matter: React Flow's drag handler needs `pointermove` events between
  // press and release. A single jump can be delivered as one event and land as
  // a click, which moves nothing and would read as a failed pan.
  await page.mouse.move(from.x + dx, from.y + dy, { steps: DRAG_STEPS });
  await page.mouse.up();
}

test.describe("flow-functionality — canvas pan by dragging the pane", () => {
  let removeFlow: (reqOverride?: APIRequestContext) => Promise<void>;

  test.beforeEach(async ({ page, request }) => {
    const token = await getAuthToken(request);
    const flow = await createRunnableChatFlowViaApi(request, {
      Authorization: token,
    });
    removeFlow = flow.deleteFlow;

    await page.goto(`/flow/${flow.flowId}`);
    // Gate on the canvas, not on a sidebar element: the retired spec waited on
    // `sidebar-search-input`, which says nothing about whether React Flow has
    // mounted, and its `waitForSelector` timeouts came from that path.
    await expect(page.getByTestId("canvas_controls_dropdown")).toBeVisible({
      timeout: 30000,
    });
    await expect(page.getByTestId("title-Chat Input")).toBeVisible({
      timeout: 30000,
    });
  });

  test.afterEach(async ({ page, request }) => {
    // Unmount the editor before deleting: an editor left mounted over a deleted
    // flow 404s its `GET /flows/{id}/events` poll and the fixture logs each one
    // (#1288).
    await page.goto("/").catch(() => {});
    await removeFlow(request);
  });

  test(
    "dragging the empty pane pans the canvas without changing the zoom",
    { tag: ["@stable", "@workspace", "@ui-ux"] },
    async ({ page }) => {
      let baseline: Viewport;
      let origin: { x: number; y: number };

      await test.step("settle the entry viewport and read the baseline", async () => {
        baseline = await waitForViewportSettled(page);
        origin = await findEmptyPanePoint(page, DRAG_DX, DRAG_DY);
      });

      await test.step("negative control: the same drag with Shift does not pan", async () => {
        // Shift+drag is the marquee gesture. Its job here is not to test the
        // marquee — it is to give the pan assertion bite: a test that passed on
        // "the mouse moved across the pane" would pass here too. It runs first,
        // so it compares against the untouched entry viewport.
        await page.keyboard.down("Shift");
        try {
          await dragPane(page, origin, DRAG_DX, DRAG_DY);
        } finally {
          await page.keyboard.up("Shift");
        }

        const afterShift = await readViewport(page);
        expect(
          afterShift.transform,
          "Shift+drag must not pan the canvas — it draws the selection marquee",
        ).toBe(baseline.transform);
      });

      await test.step("dragging the pane moves the viewport by the cursor delta", async () => {
        await dragPane(page, origin, DRAG_DX, DRAG_DY);

        const panned = await readViewport(page);

        expect(
          Math.abs(panned.x - baseline.x - DRAG_DX),
          `the viewport must translate horizontally by the drag's own delta ` +
            `(${DRAG_DX}px): baseline x=${baseline.x}, after x=${panned.x}`,
        ).toBeLessThanOrEqual(TRANSLATE_TOLERANCE_PX);
        expect(
          Math.abs(panned.y - baseline.y - DRAG_DY),
          `the viewport must translate vertically by the drag's own delta ` +
            `(${DRAG_DY}px): baseline y=${baseline.y}, after y=${panned.y}`,
        ).toBeLessThanOrEqual(TRANSLATE_TOLERANCE_PX);
      });

      await test.step("the pan leaves the zoom untouched", async () => {
        const panned = await readViewport(page);
        // Byte-identical, not a float comparison: React Flow pans in screen
        // space, so a correct pan cannot perturb the scale at all. This is what
        // separates a pan from the wheel gesture, which zooms.
        expect(
          panned.scale,
          "panning must not change the canvas zoom",
        ).toBe(baseline.scale);
      });
    },
  );
});
