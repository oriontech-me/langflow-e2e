// Unit tests for adjustScreenView (issue #997).
// Run with: npm run test:units
//
// Why this helper is unit-tested at all: 61 spec files call it directly and
// another 47 reach it through `setupPlayground`, `initialGPTsetup`,
// `prompt-template` and `SimpleAgentTemplatePage` — 108 in total, most of the
// indirect half in `llm-agents/` and `playground/`, where a canvas interceptor
// reads as an agent or provider failure. And the branch that used to be wrong is
// one the CURRENT UI cannot produce. On Nightly
// 1.12.0.dev7 every canvas control (`fit_view`, `zoom_out`, ...) is rendered
// inside the dropdown's menu content, so `fit_view` is present if and only if
// the menu is open — which is exactly why the pre-#997 bug was dormant. No E2E
// spec can reach the failing path until Langflow surfaces the fit-view control
// directly on the canvas, at which point every dependent spec would start
// leaving an open canvas-controls menu behind: a documented click interceptor
// for the next canvas action (#576), arriving as a suite-wide break with a
// confusing signature.
//
// So the widget is simulated here instead: a toggling trigger plus a switchable
// layout, which lets both today's DOM and the hypothetical one be asserted.
// The simulated contract was verified live against Nightly 1.12.0.dev7:
//   - `canvas_controls_dropdown` carries Radix's data-state="open"|"closed";
//   - `fit_view` count is 0 with the menu closed, 1 with it open;
//   - clicking `fit_view` leaves the menu open (the zoom-out loop needs that);
//   - `fitView()` is not animated — the viewport transform settles in a frame.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Page } from "@playwright/test";
import { adjustScreenView } from "./adjust-screen-view";

type Layout =
  /** Today's build: every canvas control lives inside the dropdown menu. */
  | "in-dropdown"
  /** Hypothetical build: every canvas control sits directly on the canvas. */
  | "on-canvas"
  /** Hypothetical build, partial migration: only fit-view moved out. */
  | "fit-view-on-canvas";

interface FakeOptions {
  layout?: Layout;
  menuOpen?: boolean;
  /** Set false to simulate a build whose trigger has no `data-state`. */
  exposesDataState?: boolean;
  zoomOutDisabled?: boolean;
  /**
   * Successive `.react-flow__viewport` style reads. The last entry repeats
   * forever, so a single-element array models an already-settled viewport.
   */
  viewportStyles?: string[];
}

interface FakeCanvas {
  page: Page;
  readonly menuOpen: boolean;
  readonly triggerClicks: number;
  readonly fitViewClicks: number;
  readonly zoomOutClicks: number;
  readonly viewportReads: number;
}

function fakeCanvas({
  layout = "in-dropdown",
  menuOpen = false,
  exposesDataState = true,
  zoomOutDisabled = false,
  viewportStyles = ["transform: scale(1);"],
}: FakeOptions = {}): FakeCanvas {
  const state = {
    menuOpen,
    triggerClicks: 0,
    fitViewClicks: 0,
    zoomOutClicks: 0,
    viewportReads: 0,
  };

  // A control is reachable while the menu is open, or once its own build has
  // moved it onto the canvas.
  const onCanvas = (testId: string) =>
    layout === "on-canvas" ||
    (layout === "fit-view-on-canvas" && testId === "fit_view");

  const controlCount = (testId: string) =>
    testId === "canvas_controls_dropdown" ||
    onCanvas(testId) ||
    state.menuOpen
      ? 1
      : 0;

  // Playwright's locator methods do not resolve against a missing element: they
  // reject once the timeout expires. Modelling that is what keeps the fake from
  // flattering the helper — an `isDisabled` that quietly answers for an element
  // that is not there would hide the partial-migration case entirely.
  const requireRendered = (testId: string, method: string) => {
    if (controlCount(testId) === 0) {
      throw new Error(
        `locator.${method}: Timeout 1000ms exceeded — ${testId} is not rendered`,
      );
    }
  };

  const locator = (testId: string) => ({
    count: async () => controlCount(testId),
    click: async () => {
      if (testId === "canvas_controls_dropdown") {
        state.triggerClicks += 1;
        state.menuOpen = !state.menuOpen;
        return;
      }
      // Clicking a control must not dismiss the menu — these are plain buttons,
      // not Radix menu items (verified against the running nightly).
      requireRendered(testId, "click");
      if (testId === "fit_view") state.fitViewClicks += 1;
      if (testId === "zoom_out") state.zoomOutClicks += 1;
    },
    getAttribute: async (name: string) => {
      if (testId !== "canvas_controls_dropdown" || name !== "data-state") {
        return null;
      }
      if (!exposesDataState) return null;
      return state.menuOpen ? "open" : "closed";
    },
    isDisabled: async () => {
      requireRendered(testId, "isDisabled");
      return zoomOutDisabled;
    },
  });

  const page = {
    waitForSelector: async () => undefined,
    waitForTimeout: async () => undefined,
    getByTestId: (testId: string) => locator(testId),
    locator: () => ({
      getAttribute: async () => {
        const style =
          viewportStyles[
            Math.min(state.viewportReads, viewportStyles.length - 1)
          ];
        state.viewportReads += 1;
        return style;
      },
    }),
  } as unknown as Page;

  return {
    page,
    get menuOpen() {
      return state.menuOpen;
    },
    get triggerClicks() {
      return state.triggerClicks;
    },
    get fitViewClicks() {
      return state.fitViewClicks;
    },
    get zoomOutClicks() {
      return state.zoomOutClicks;
    },
    get viewportReads() {
      return state.viewportReads;
    },
  };
}

test("opens the menu when the controls are hidden, and closes it again", async () => {
  const canvas = fakeCanvas({ layout: "in-dropdown", menuOpen: false });

  await adjustScreenView(canvas.page);

  assert.equal(canvas.fitViewClicks, 1);
  assert.equal(canvas.triggerClicks, 2, "one click to open, one to close");
  assert.equal(canvas.menuOpen, false, "the menu must not be left open");
});

test("leaves a menu that was ALREADY open closed, without reopening it", async () => {
  // The regression guard for the obvious fix. Capturing "did I open it?" and
  // closing only in that case reads as correct, but on today's build a caller
  // can reach this helper with the menu already open (#576's leftover
  // interceptor). Closing only what we opened would hand that interceptor
  // straight to the next canvas click.
  const canvas = fakeCanvas({ layout: "in-dropdown", menuOpen: true });

  await adjustScreenView(canvas.page);

  assert.equal(canvas.fitViewClicks, 1);
  assert.equal(canvas.triggerClicks, 1, "no reopen — only the closing click");
  assert.equal(canvas.menuOpen, false);
});

test("never opens the menu when fit-view is reachable on the canvas", async () => {
  // The #997 bug. Pre-fix, `fitViewButton` was reassigned inside the `if`, so
  // the trailing guard was true on both paths and this call ended with an open
  // canvas-controls menu — for all 108 dependent specs at once.
  const canvas = fakeCanvas({ layout: "on-canvas", menuOpen: false });

  await adjustScreenView(canvas.page);

  assert.equal(canvas.fitViewClicks, 1);
  assert.equal(canvas.triggerClicks, 0, "the menu was never needed");
  assert.equal(canvas.menuOpen, false);
});

test("falls back to intent when the trigger exposes no data-state", async () => {
  const opened = fakeCanvas({
    layout: "in-dropdown",
    menuOpen: false,
    exposesDataState: false,
  });
  await adjustScreenView(opened.page);
  assert.equal(opened.triggerClicks, 2, "closes what it opened");
  assert.equal(opened.menuOpen, false);

  const untouched = fakeCanvas({
    layout: "on-canvas",
    menuOpen: false,
    exposesDataState: false,
  });
  await adjustScreenView(untouched.page);
  assert.equal(
    untouched.triggerClicks,
    0,
    "without a state signal it must still never OPEN a menu",
  );
  assert.equal(untouched.menuOpen, false);
});

test("throws, naming the cause, on a partial layout migration", async () => {
  // fit-view moved onto the canvas, zoom-out left inside the menu. The helper
  // has no reason to open a menu, so zoom-out is unreachable. It must NOT guess
  // at the new layout, and it must not fall back to a blind toggle — it fails
  // with a message that names the control and points at #997.
  const canvas = fakeCanvas({ layout: "fit-view-on-canvas", menuOpen: false });

  await assert.rejects(
    () => adjustScreenView(canvas.page),
    (err: Error) => {
      assert.match(err.message, /adjustScreenView/);
      assert.match(err.message, /zoom_out/);
      assert.match(err.message, /#997/);
      return true;
    },
  );

  assert.equal(canvas.triggerClicks, 0, "it must not open a menu to recover");
  assert.equal(canvas.menuOpen, false);
});

test("skips the zoom-out reachability check when no zoom-out was asked for", async () => {
  const canvas = fakeCanvas({
    layout: "fit-view-on-canvas",
    menuOpen: false,
  });

  await adjustScreenView(canvas.page, { numberOfZoomOut: 0 });

  assert.equal(canvas.fitViewClicks, 1);
  assert.equal(canvas.zoomOutClicks, 0);
  assert.equal(canvas.triggerClicks, 0);
});

test("keeps polling the viewport until the transform stops changing", async () => {
  // Guards the settle loop itself: a poll that returned on its first read would
  // pass every other test here, because they all model an already-stable
  // viewport. Two moving reads, then a repeat — the earliest it may return is
  // the read that matches its predecessor.
  const canvas = fakeCanvas({
    viewportStyles: [
      "transform: translate(0px, 0px) scale(1);",
      "transform: translate(-97px, -120px) scale(1.17);",
      "transform: translate(-97px, -120px) scale(1.17);",
    ],
  });

  await adjustScreenView(canvas.page, { numberOfZoomOut: 0 });

  assert.equal(
    canvas.viewportReads,
    3,
    "must not settle before two consecutive reads agree",
  );
});

test("zooms out the requested number of times", async () => {
  const canvas = fakeCanvas();

  await adjustScreenView(canvas.page, { numberOfZoomOut: 3 });

  assert.equal(canvas.zoomOutClicks, 3);
  assert.equal(canvas.menuOpen, false);
});

test("stops zooming out when the control reports disabled", async () => {
  const canvas = fakeCanvas({ zoomOutDisabled: true });

  await adjustScreenView(canvas.page, { numberOfZoomOut: 3 });

  assert.equal(canvas.zoomOutClicks, 0);
  assert.equal(canvas.menuOpen, false);
});
