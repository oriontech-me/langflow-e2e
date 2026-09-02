// A simulated canvas bottom-centre overlay slot, for the unit tests of
// `clear-canvas-bottom-overlay`.
//
// NOT a test file — it defines no `test()`. `npm run test:units` collects
// `*.test.ts` only and Playwright's `testMatch` is `*.spec.ts`, so this file is
// imported by tests and never executed as one.
//
// Why simulate: the behaviour that matters is a HANDOVER between two components
// that own the same fixed container — the build-status bar unmounts, and the
// "Flow needs review" banner mounts into the slot it just left. A live spec cannot
// dwell on the one render tick where the slot is empty, and cannot reproduce a
// build that stops honouring Dismiss at all. The timeline below makes both states
// addressable.
//
// The simulated contract was verified live against nightly 1.12.0.dev39 (#1643):
//   - both components render into `absolute bottom-16 left-1/2 z-50 w-[530px]`;
//   - the build bar auto-dismisses ~2.5 s after "Flow built successfully" and
//     offers no Dismiss in that state;
//   - the update banner reads "Flow needs review / 1 component needs updates" and
//     offers "Dismiss" + "Update All", and never leaves on its own — a click under
//     it burns the full `locator.click` budget with "subtree intercepts pointer
//     events".
import type { Page } from "@playwright/test";

export interface Occupant {
  text: string;
  /** Renders a Dismiss button — i.e. it will not leave on its own. */
  dismissible: boolean;
  /**
   * Set true to model a build whose Dismiss no longer clears the overlay. The
   * helper must then fail attributed rather than loop until the caller's click
   * times out somewhere else.
   */
  ignoresDismiss?: boolean;
}

export const BUILD_BAR: Occupant = {
  text: "Flow built successfully\n0.2s",
  dismissible: false,
};

export const UPDATE_BANNER: Occupant = {
  text: "Flow needs review\n1 component needs updates\nDismiss\nUpdate All",
  dismissible: true,
};

export interface FakeOptions {
  /**
   * What occupies the slot, one entry per poll tick; `null` is an empty slot.
   * The last entry repeats forever, so `[null]` models an already-free slot and
   * `[BUILD_BAR, null, UPDATE_BANNER]` models the real handover, empty tick and
   * all.
   */
  timeline?: (Occupant | null)[];
}

export interface FakeOverlay {
  page: Page;
  readonly ticks: number;
  readonly dismissClicks: number;
  readonly countReads: number;
}

export function fakeOverlay({
  timeline = [null],
}: FakeOptions = {}): FakeOverlay {
  const state = { ticks: 0, dismissClicks: 0, countReads: 0, dismissed: false };

  const current = (): Occupant | null => {
    const entry = timeline[Math.min(state.ticks, timeline.length - 1)];
    if (!entry) return null;
    // Dismissing models Langflow's `dismissedNodes`: the banner stays gone for
    // the rest of the session, not just for one tick.
    if (state.dismissed && entry.dismissible && !entry.ignoresDismiss) {
      return null;
    }
    return entry;
  };

  const dismissLocator = () => ({
    count: async () => {
      const occupant = current();
      return occupant?.dismissible ? 1 : 0;
    },
    first: () => ({
      click: async () => {
        const occupant = current();
        if (!occupant?.dismissible) {
          throw new Error("locator.click: Timeout 5000ms exceeded");
        }
        state.dismissClicks += 1;
        state.dismissed = true;
      },
    }),
  });

  const occupantLocator = () => ({
    innerText: async () => {
      const occupant = current();
      if (!occupant) throw new Error("locator.innerText: element is not attached");
      return occupant.text;
    },
    // The name is CHECKED, not ignored: a fake that answered for any role/name
    // would let the helper find a Dismiss on the build bar, which is precisely
    // the distinction the helper's predicate rests on.
    getByRole: (role: string, options?: { name?: RegExp }) => {
      if (role !== "button" || !options?.name?.test("Dismiss")) {
        return { count: async () => 0, first: () => ({ click: async () => {} }) };
      }
      return dismissLocator();
    },
  });

  const page = {
    waitForTimeout: async () => {
      state.ticks += 1;
    },
    // The selector is CHECKED, not ignored — a typo in the slot selector would
    // otherwise pass every test here while matching nothing in production, where
    // the helper would return "clear" on an overlay that is fully present.
    locator: (selector: string) => {
      if (!selector.includes("bottom-16") || !selector.includes("w-[530px]")) {
        throw new Error(`unexpected selector: ${selector}`);
      }
      return {
        count: async () => {
          state.countReads += 1;
          return current() ? 1 : 0;
        },
        first: () => occupantLocator(),
      };
    },
  } as unknown as Page;

  return {
    page,
    get ticks() {
      return state.ticks;
    },
    get dismissClicks() {
      return state.dismissClicks;
    },
    get countReads() {
      return state.countReads;
    },
  };
}
