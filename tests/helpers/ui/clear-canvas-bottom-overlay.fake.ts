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
// dwell on the gap between the two (~89 ms measured, and upstream-controlled — see
// `BANNER_UNHIDE_DELAY_MS`), and cannot reproduce a build that stops honouring
// Dismiss at all. The timeline below makes both states addressable.
//
// The simulated contract was verified live against nightly 1.12.0.dev39 (#1643):
//   - both components render into `absolute bottom-16 left-1/2 z-50 w-[530px]`;
//   - the build bar auto-dismisses 2 s after "Flow built successfully" and offers
//     no Dismiss in that state — only Stop, and Retry + Dismiss when it errored;
//   - the update banner reads "Flow needs review / 1 component needs updates" and
//     offers "Dismiss" + "Update All", and never leaves on its own — a click under
//     it burns the full `locator.click` budget with "subtree intercepts pointer
//     events";
//   - that Dismiss is PLURAL-CONDITIONAL: one outdated component renders
//     "Dismiss", several render "Dismiss All" (re-measured on 1.13.0.dev0 across
//     three fixtures reporting 1, 3 and 6 — #1675). Both labels are modelled below
//     because an exact-name matcher passes against one and no-ops against the
//     other, which is the hole the two hand-rolled copies carried.
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
  /**
   * The button's visible label. Defaults to the singular "Dismiss"; the update
   * banner renders "Dismiss All" as soon as more than one component is outdated,
   * and the helper's matcher has to cover both (#1675).
   */
  dismissLabel?: string;
}

export const BUILD_BAR: Occupant = {
  text: "Flow built successfully\n0.2s",
  dismissible: false,
};

/**
 * The build bar's ERROR state: Retry + Dismiss, and no timer. It satisfies the
 * helper's "offers a Dismiss" predicate, which is why the helper has to refuse it
 * by name — dismissing it erases the only UI evidence of a failed run.
 */
export const BUILD_FAILED_BAR: Occupant = {
  text: "Flow build failed\nRetry\nDismiss",
  dismissible: true,
};

export const UPDATE_BANNER: Occupant = {
  text: "Flow needs review\n1 component needs updates\nDismiss\nUpdate All",
  dismissible: true,
};

/**
 * The same banner with MORE than one outdated component, which is the shape every
 * multi-node fixture raises — and the shape whose label an exact `"Dismiss All"`
 * matcher gets right while missing `UPDATE_BANNER` entirely, and vice versa.
 */
export const UPDATE_BANNER_PLURAL: Occupant = {
  text: "Flow needs review\n6 components need updates\nDismiss All\nUpdate All",
  dismissible: true,
  dismissLabel: "Dismiss All",
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
      // Matched against the occupant's OWN label, so a matcher that only covers
      // the singular "Dismiss" (or only the plural "Dismiss All") fails here
      // instead of passing on a hardcoded string neither banner renders.
      const label = current()?.dismissLabel ?? "Dismiss";
      if (role !== "button" || !options?.name?.test(label)) {
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
