// Unit tests for adjustScreenView (issue #997).
// Run with: npm run test:units
//
// Why this helper is unit-tested at all: it is called by ~65 spec files, and the
// branch that used to be wrong is one the CURRENT UI cannot produce. On Nightly
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
  /** Today's build: the canvas controls live inside the dropdown menu. */
  | "in-dropdown"
  /** Hypothetical build: the canvas controls sit directly on the canvas. */
  | "on-canvas";

interface FakeOptions {
  layout?: Layout;
  menuOpen?: boolean;
  /** Set false to simulate a build whose trigger has no `data-state`. */
  exposesDataState?: boolean;
  zoomOutDisabled?: boolean;
}

interface FakeCanvas {
  page: Page;
  readonly menuOpen: boolean;
  readonly triggerClicks: number;
  readonly fitViewClicks: number;
  readonly zoomOutClicks: number;
}

function fakeCanvas({
  layout = "in-dropdown",
  menuOpen = false,
  exposesDataState = true,
  zoomOutDisabled = false,
}: FakeOptions = {}): FakeCanvas {
  const state = {
    menuOpen,
    triggerClicks: 0,
    fitViewClicks: 0,
    zoomOutClicks: 0,
  };

  // A control is reachable while the menu is open — or always, once the
  // controls are rendered on the canvas itself.
  const controlCount = (testId: string) =>
    testId === "canvas_controls_dropdown" ||
    layout === "on-canvas" ||
    state.menuOpen
      ? 1
      : 0;

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
      if (controlCount(testId) === 0) {
        throw new Error(`clicked ${testId} while it was not rendered`);
      }
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
    isDisabled: async () => zoomOutDisabled,
  });

  const page = {
    waitForSelector: async () => undefined,
    waitForTimeout: async () => undefined,
    getByTestId: (testId: string) => locator(testId),
    // The viewport-settle poll reads a stable value, so it returns on its
    // second read — the shape the live measurement showed.
    locator: () => ({ getAttribute: async () => "transform: scale(1);" }),
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
  // canvas-controls menu — for all ~65 dependent specs at once.
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
