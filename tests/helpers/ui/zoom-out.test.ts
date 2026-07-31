// Unit tests for zoomOut (issue #1053).
// Run with: npm run test:units
//
// 18 spec files import this directly and `setup-playground` calls it too, which
// another 24 specs go through — ~38 in total. The branch that was wrong here is
// the one the current UI cannot produce, so the coverage has to be a unit test;
// see `./canvas-controls.fake` for the simulated widget and why.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeCanvas } from "./canvas-controls.fake";
import { zoomOut } from "./zoom-out";

test("opens the menu when zoom-out is hidden, and closes it again", async () => {
  const canvas = fakeCanvas({ layout: "in-dropdown", menuOpen: false });

  await zoomOut(canvas.page, 2);

  assert.equal(canvas.zoomOutClicks, 2);
  assert.equal(canvas.triggerClicks, 2, "one click to open, one to close");
  assert.equal(canvas.menuOpen, false, "the menu must not be left open");
});

test("leaves a menu that was ALREADY open closed, without reopening it", async () => {
  // Today's reachable hazard. `mcp-server.spec.ts` opens the menu itself and then
  // calls this helper, and any sibling helper can leave one open — so the
  // already-open path is not hypothetical, it is exercised in the suite today.
  const canvas = fakeCanvas({ layout: "in-dropdown", menuOpen: true });

  await zoomOut(canvas.page, 3);

  assert.equal(canvas.zoomOutClicks, 3);
  assert.equal(canvas.triggerClicks, 1, "no reopen — only the closing click");
  assert.equal(canvas.menuOpen, false);
});

test("never opens the menu when zoom-out is reachable on the canvas", async () => {
  // The #997 defect as it was reproduced in this helper: `zoomOutButton` was
  // recounted INSIDE the `if` after opening the menu, so the trailing guard
  // (`zoomOutButton > 0`) was true on both paths and the trigger was toggled
  // unconditionally. On a build with the controls on the canvas that toggle
  // OPENS a menu, leaving an interceptor (#576) for the next canvas click on all
  // ~38 dependent specs.
  const canvas = fakeCanvas({ layout: "on-canvas", menuOpen: false });

  await zoomOut(canvas.page, 2);

  assert.equal(canvas.zoomOutClicks, 2);
  assert.equal(canvas.triggerClicks, 0, "the menu was never needed");
  assert.equal(canvas.menuOpen, false);
});

test("clicks zoom-out exactly as many times as asked, and defaults to 2", async () => {
  const explicit = fakeCanvas();
  await zoomOut(explicit.page, 5);
  assert.equal(explicit.zoomOutClicks, 5);
  assert.equal(explicit.menuOpen, false);

  // The default is depended on by callers that pass no count.
  const defaulted = fakeCanvas();
  await zoomOut(defaulted.page);
  assert.equal(defaulted.zoomOutClicks, 2);
  assert.equal(defaulted.menuOpen, false);

  // Zero steps still has to honour the postcondition: it opened nothing, so
  // there is nothing to close.
  const none = fakeCanvas();
  await zoomOut(none.page, 0);
  assert.equal(none.zoomOutClicks, 0);
  assert.equal(none.menuOpen, false);
});

test("fails attributed when zoom-out is not rendered at all", async () => {
  // A renamed testid used to surface as a click timeout inside the loop, naming
  // only the locator. Now the reachability check in `openCanvasControls` speaks
  // first and says the menu was opened for it.
  const canvas = fakeCanvas({
    layout: "in-dropdown",
    menuOpen: false,
    missingControls: ["zoom_out"],
  });

  await assert.rejects(
    () => zoomOut(canvas.page, 2),
    (err: Error) => {
      assert.match(err.message, /canvas-controls/);
      assert.match(err.message, /zoom_out/);
      return true;
    },
  );

  assert.equal(canvas.zoomOutClicks, 0);
});
