// Unit tests for the canvas bottom-overlay clearing helper (issue #1643).
// Run with: npm run test:units
//
// The helper's whole job is to survive a HANDOVER: Langflow's build-status bar and
// its "Flow needs review" banner render into the same fixed container, the banner
// is hidden while the bar is up, and it takes the slot back the moment the bar's
// state is cleared. A spec that waits for "built successfully" and clicks lands in
// the gap — which is how #1643 burned the full 20 s `locator.click` budget on two
// specs, three attempts each. The simulated slot and its live-verified contract are
// documented in `./clear-canvas-bottom-overlay.fake`.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BUILD_BAR,
  BUILD_FAILED_BAR,
  UPDATE_BANNER,
  fakeOverlay,
} from "./clear-canvas-bottom-overlay.fake";
import {
  BANNER_UNHIDE_DELAY_MS,
  EMPTY_CONFIRMATIONS,
  clearCanvasBottomOverlay,
} from "./clear-canvas-bottom-overlay";

// The fake counts poll ticks and ignores their duration, so no behavioural test
// here can see POLL_MS. That is exactly why the timing relationship is asserted on
// the constants instead: it is upstream-controlled and load-bearing, and a
// `POLL_MS = 0` survived every behavioural test in this file.
test("the empty-slot quiet window outlasts the banner's un-hide delay", async () => {
  const POLL_MS = 200; // private to the helper; mirrored here on purpose
  const quietWindowMs = POLL_MS * (EMPTY_CONFIRMATIONS - 1);

  assert.ok(
    quietWindowMs > BANNER_UNHIDE_DELAY_MS,
    `the helper accepts an empty slot after ${quietWindowMs}ms of emptiness, but the ` +
      `banner is un-hidden ${BANNER_UNHIDE_DELAY_MS}ms after the bar dismisses — the ` +
      `whole window fits inside the handover gap, so the helper can return into the ` +
      `banner's mount`,
  );
});

test("the transient build bar is waited out, never dismissed", async () => {
  // The success bar offers no Dismiss — the helper must poll it away, not go
  // looking for a button that only its ERROR state renders.
  const overlay = fakeOverlay({
    timeline: [BUILD_BAR, BUILD_BAR, BUILD_BAR, null],
  });

  await clearCanvasBottomOverlay(overlay.page, { timeout: 5000 });

  assert.equal(overlay.dismissClicks, 0);
  assert.ok(overlay.ticks >= 3, `polled only ${overlay.ticks} times`);
});

test("the persistent update banner is dismissed", async () => {
  const overlay = fakeOverlay({ timeline: [UPDATE_BANNER] });

  await clearCanvasBottomOverlay(overlay.page, { timeout: 5000 });

  assert.equal(overlay.dismissClicks, 1);
});

test("the bar to banner handover gap is not read as clear", async () => {
  // THE load-bearing case. With a single-read "is it empty?" the helper returns
  // right here, and the caller's click meets the banner that mounts on the next
  // tick — exactly the 2026-08-31 failure. The quiet window is what makes the
  // difference, so the banner must still be seen and dismissed.
  const overlay = fakeOverlay({
    timeline: [BUILD_BAR, null, UPDATE_BANNER],
  });

  await clearCanvasBottomOverlay(overlay.page, { timeout: 5000 });

  assert.equal(
    overlay.dismissClicks,
    1,
    "returned during the handover gap instead of waiting for the banner",
  );
});

test("a slot that was NEVER occupied is a lost selector, not a free slot", async () => {
  // Fail-closed (#1012). Callers reach this right after the build bar rendered, so
  // "nothing ever matched" can only mean the selector stopped matching the
  // container — an upstream Tailwind edit. Returning success there would report the
  // overlay handled while it is fully present.
  const overlay = fakeOverlay({ timeline: [null] });

  await assert.rejects(
    () => clearCanvasBottomOverlay(overlay.page, { timeout: 5000 }),
    (error: Error) => {
      assert.match(error.message, /matched\s+NOTHING/);
      assert.match(error.message, /allowAlreadyClear/);
      return true;
    },
  );
  assert.equal(overlay.dismissClicks, 0);
});

test("allowAlreadyClear opts a caller out of the lost-selector guard", async () => {
  const overlay = fakeOverlay({ timeline: [null] });

  await clearCanvasBottomOverlay(overlay.page, {
    timeout: 5000,
    allowAlreadyClear: true,
  });

  assert.equal(overlay.dismissClicks, 0);
});

test("the FAILED-build bar is refused by name, never dismissed", async () => {
  // It offers Retry + Dismiss and has no timer, so it satisfies the "will not leave
  // on its own" predicate — but dismissing it erases the only UI evidence of a
  // failed run, and the v2 run-stream flow-error verdict is advisory on 1.12.x, so
  // the spec could go green on a build that failed.
  const overlay = fakeOverlay({ timeline: [BUILD_FAILED_BAR] });

  await assert.rejects(
    () => clearCanvasBottomOverlay(overlay.page, { timeout: 5000 }),
    (error: Error) => {
      assert.match(error.message, /FAILED-BUILD bar/);
      assert.match(error.message, /Flow build failed/);
      return true;
    },
  );
  assert.equal(
    overlay.dismissClicks,
    0,
    "dismissed the failed-build bar — that erases the failure's only UI evidence",
  );
});

test("an overlay that ignores its own Dismiss fails attributed, not silently", async () => {
  const stuck = { ...UPDATE_BANNER, ignoresDismiss: true };
  const overlay = fakeOverlay({ timeline: [stuck] });

  await assert.rejects(
    () => clearCanvasBottomOverlay(overlay.page, { timeout: 300 }),
    (error: Error) => {
      // The message has to name WHAT is stuck and that Dismiss was tried —
      // without both, this reads as an unexplained click timeout at the call
      // site, which is the misattribution #1643 cost a day of triage to.
      assert.match(error.message, /Flow needs review/);
      assert.match(error.message, /Dismiss clicked [1-9]/);
      assert.match(error.message, /#1643/);
      return true;
    },
  );
});

test("an occupant that offers no Dismiss and never leaves is reported as such", async () => {
  const overlay = fakeOverlay({ timeline: [BUILD_BAR] });

  await assert.rejects(
    () => clearCanvasBottomOverlay(overlay.page, { timeout: 300 }),
    (error: Error) => {
      assert.match(error.message, /Flow built successfully/);
      assert.match(error.message, /Dismiss clicked 0 time\(s\)/);
      return true;
    },
  );
});
