// Unit tests for the canvas bottom-overlay clearing helper (issue #1643).
// Run with: npm run test:units
//
// The helper's whole job is to survive a HANDOVER: Langflow's build-status bar and
// its "Flow needs review" banner render into the same fixed container, the banner
// is hidden while the bar is up, and it takes the slot back the moment the bar
// auto-dismisses. A spec that waits for "built successfully" and clicks lands in
// the gap — which is how #1643 burned the full 20 s `locator.click` budget on two
// specs, three attempts each. The simulated slot and its live-verified contract are
// documented in `./clear-canvas-bottom-overlay.fake`.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BUILD_BAR,
  UPDATE_BANNER,
  fakeOverlay,
} from "./clear-canvas-bottom-overlay.fake";
import { clearCanvasBottomOverlay } from "./clear-canvas-bottom-overlay";

test("an already-free slot returns without dismissing anything", async () => {
  const overlay = fakeOverlay({ timeline: [null] });

  await clearCanvasBottomOverlay(overlay.page, { timeout: 5000 });

  assert.equal(overlay.dismissClicks, 0);
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

test("the one empty tick of the bar to banner handover is not read as clear", async () => {
  // THE load-bearing case. With a single-read "is it empty?" the helper returns
  // right here, and the caller's click meets the banner that mounts on the next
  // tick — exactly the 2026-08-31 failure. Two consecutive empty reads are what
  // make the difference, so the banner must still be seen and dismissed.
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
