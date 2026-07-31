// A simulated canvas-controls widget, shared by the unit tests of every helper
// that drives it: `canvas-controls`, `adjust-screen-view` and `zoom-out`.
//
// NOT a test file — it defines no `test()`. `npm run test:units` collects
// `*.test.ts` only and Playwright's `testMatch` is `*.spec.ts`, so this file is
// imported by tests and never executed as one.
//
// Why the widget is simulated at all: the branch that was wrong in all four call
// sites (#997, #1053) is one the CURRENT UI cannot produce. On Nightly
// 1.12.0.dev7 every canvas control (`fit_view`, `zoom_out`, ...) is rendered
// inside the dropdown's menu content, so a control is present if and only if the
// menu is open — which is exactly why the bug was dormant. No E2E spec can reach
// the failing path until Langflow surfaces those controls directly on the canvas,
// at which point every dependent spec would start leaving an open
// canvas-controls menu behind: a documented click interceptor for the next canvas
// action (#576), arriving as a suite-wide break with a confusing signature.
//
// So a toggling trigger plus a switchable layout is modelled here, which lets
// both today's DOM and the hypothetical one be asserted. The simulated contract
// was verified live against Nightly 1.12.0.dev7:
//   - `canvas_controls_dropdown` carries Radix's data-state="open"|"closed";
//   - `fit_view` count is 0 with the menu closed, 1 with it open;
//   - clicking `fit_view` leaves the menu open (the zoom-out loop needs that);
//   - `fitView()` is not animated — the viewport transform settles in a frame.
import type { Page } from "@playwright/test";

export type Layout =
  /** Today's build: every canvas control lives inside the dropdown menu. */
  | "in-dropdown"
  /** Hypothetical build: every canvas control sits directly on the canvas. */
  | "on-canvas"
  /** Hypothetical build, partial migration: only fit-view moved out. */
  | "fit-view-on-canvas";

export interface FakeOptions {
  layout?: Layout;
  menuOpen?: boolean;
  /** Set false to simulate a build whose trigger has no `data-state`. */
  exposesDataState?: boolean;
  zoomOutDisabled?: boolean;
  /**
   * Controls that are never rendered, whatever the layout or menu state —
   * a renamed or removed testid. Models the one case where opening the menu
   * does not make the requested control reachable.
   */
  missingControls?: string[];
  /**
   * Successive `.react-flow__viewport` style reads. The last entry repeats
   * forever, so a single-element array models an already-settled viewport.
   */
  viewportStyles?: string[];
}

export interface FakeCanvas {
  page: Page;
  readonly menuOpen: boolean;
  readonly triggerClicks: number;
  readonly fitViewClicks: number;
  readonly zoomOutClicks: number;
  readonly viewportReads: number;
}

export function fakeCanvas({
  layout = "in-dropdown",
  menuOpen = false,
  exposesDataState = true,
  zoomOutDisabled = false,
  missingControls = [],
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

  const controlCount = (testId: string) => {
    if (missingControls.includes(testId)) return 0;
    return testId === "canvas_controls_dropdown" ||
      onCanvas(testId) ||
      state.menuOpen
      ? 1
      : 0;
  };

  // Playwright's locator methods do not resolve against a missing element: they
  // reject once the timeout expires. Modelling that is what keeps the fake from
  // flattering the helpers — an `isDisabled` that quietly answers for an element
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
    // Resolves for a rendered element, rejects otherwise — same shape as the real
    // `waitFor`, whose rejection is what `openCanvasControls` converts into an
    // attributed error.
    waitFor: async () => {
      requireRendered(testId, "waitFor");
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
    // The selector is CHECKED, not ignored. A fake that answers for any argument
    // would pass every test here with a typo in `.react-flow__viewport`, while in
    // production every read rejects and the settle loop silently burns its whole
    // budget — i.e. the 500 ms sleep the helper replaced, at full price. Same
    // class as `requireRendered` above: the fake must not flatter the helper.
    locator: (selector: string) => ({
      getAttribute: async () => {
        if (selector !== ".react-flow__viewport") {
          throw new Error(
            `locator.getAttribute: Timeout 200ms exceeded — no element matches ${selector}`,
          );
        }
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

/**
 * Runs `fn` with `console.warn` captured, returning what it emitted.
 *
 * The `data-state` fallback is the one branch whose CORRECTNESS cannot be
 * asserted — it is the behaviour #997 rejected, kept only because it can never
 * open a menu. So what gets pinned instead is that it announces itself: the
 * warning is the only signal that a helper stopped reading the real open/closed
 * state.
 */
export async function captureWarnings(
  fn: () => Promise<void>,
): Promise<string[]> {
  const original = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    await fn();
  } finally {
    console.warn = original;
  }
  return warnings;
}
