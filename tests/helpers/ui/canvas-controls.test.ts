// Unit tests for the shared canvas-controls mechanism (issue #1053).
// Run with: npm run test:units
//
// This module is the single implementation of "reach a canvas control, then leave
// the menu closed" for `adjustScreenView`, `zoomOut` and `uploadFile`. Four call
// sites hand-rolled it before #1053 and all four got the same branch wrong — the
// branch the CURRENT UI cannot produce, so no E2E spec can reach it. That is what
// these tests exist for; the simulated widget and its live-verified contract are
// documented in `./canvas-controls.fake`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { captureWarnings, fakeCanvas } from "./canvas-controls.fake";
import { closeCanvasControls, openCanvasControls } from "./canvas-controls";

test("openCanvasControls opens the menu when the control is hidden", async () => {
  const canvas = fakeCanvas({ layout: "in-dropdown", menuOpen: false });

  const opened = await openCanvasControls(canvas.page, "fit_view");

  assert.equal(opened, true, "it had to open the menu, and must report that");
  assert.equal(canvas.triggerClicks, 1);
  assert.equal(canvas.menuOpen, true);
});

test("openCanvasControls does nothing when the control is already reachable", async () => {
  // Two ways to already be reachable, and both must be no-ops: the menu is open
  // (today's build, a sibling helper left it open), or the control has moved onto
  // the canvas (the hypothetical build that breaks a blind toggle).
  for (const options of [
    { layout: "in-dropdown" as const, menuOpen: true },
    { layout: "on-canvas" as const, menuOpen: false },
  ]) {
    const canvas = fakeCanvas(options);

    const opened = await openCanvasControls(canvas.page, "fit_view");

    assert.equal(opened, false, JSON.stringify(options));
    assert.equal(canvas.triggerClicks, 0, JSON.stringify(options));
    assert.equal(canvas.menuOpen, options.menuOpen, JSON.stringify(options));
  }
});

test("openCanvasControls probes the CONTROL, never the trigger", async () => {
  // The `FlowEditorPage.adjustView()` defect (#1053): the trigger is present
  // whenever the canvas is up, so guarding on ITS count is a condition that is
  // always true. Asking for the trigger itself must therefore be a no-op — if
  // this function ever probed the trigger, it would answer "already reachable"
  // for every control, and no menu would ever be opened again.
  const canvas = fakeCanvas({ layout: "in-dropdown", menuOpen: false });

  const opened = await openCanvasControls(
    canvas.page,
    "canvas_controls_dropdown",
  );

  assert.equal(opened, false);
  assert.equal(canvas.triggerClicks, 0);
});

test("openCanvasControls throws, attributed, when opening does not reveal the control", async () => {
  // A renamed or removed testid. Before this guard the caller died on a bare
  // click timeout naming only the locator, with nothing to say the menu had just
  // been opened for it — the failure mode `zoomOut` shipped with.
  const canvas = fakeCanvas({
    layout: "in-dropdown",
    menuOpen: false,
    missingControls: ["zoom_out"],
  });

  await assert.rejects(
    () => openCanvasControls(canvas.page, "zoom_out"),
    (err: Error) => {
      assert.match(err.message, /canvas-controls/);
      assert.match(err.message, /zoom_out/);
      assert.match(err.message, /#997/);
      return true;
    },
  );
});

test("closeCanvasControls closes a menu it did not open", async () => {
  // The defect class, stated positively. All four call sites expressed the close
  // as a toggle, which is correct only while the menu happens to be open.
  const canvas = fakeCanvas({ layout: "in-dropdown", menuOpen: true });

  await closeCanvasControls(canvas.page, false, "test");

  assert.equal(canvas.menuOpen, false);
  assert.equal(canvas.triggerClicks, 1);
});

test("closeCanvasControls leaves a closed menu alone, whatever the intent says", async () => {
  // The #997 failure. A caller that believes it opened the menu (because a
  // reassigned count told it so) must still not click a trigger whose state
  // reads `closed` — that click OPENS a menu, handing an interceptor (#576) to
  // the next canvas action.
  for (const openedByThisCall of [true, false]) {
    const canvas = fakeCanvas({ layout: "in-dropdown", menuOpen: false });

    await closeCanvasControls(canvas.page, openedByThisCall, "test");

    assert.equal(
      canvas.triggerClicks,
      0,
      `openedByThisCall=${openedByThisCall} must not produce a click`,
    );
    assert.equal(canvas.menuOpen, false);
  }
});

test("closeCanvasControls falls back to intent without data-state, and names the caller", async () => {
  const open = fakeCanvas({ menuOpen: true, exposesDataState: false });
  const warnings = await captureWarnings(() =>
    closeCanvasControls(open.page, true, "zoomOut"),
  );
  assert.equal(open.menuOpen, false, "intent said it opened it — close it");
  assert.equal(open.triggerClicks, 1);

  // The fallback IS #997's rejected behaviour, kept only because it can never
  // open a menu. It is acceptable only while it announces itself, and the
  // caller's name is what makes it actionable across four sharing helpers.
  assert.equal(warnings.length, 1, JSON.stringify(warnings));
  assert.match(warnings[0], /\[zoomOut\]/);
  assert.match(warnings[0], /data-state/);
  assert.match(warnings[0], /#997/);

  // Same missing attribute, opposite intent: it must never open a menu.
  const closed = fakeCanvas({ menuOpen: false, exposesDataState: false });
  await captureWarnings(() =>
    closeCanvasControls(closed.page, false, "uploadFile"),
  );
  assert.equal(closed.triggerClicks, 0);
  assert.equal(closed.menuOpen, false);
});

test("closeCanvasControls warns about nothing on the normal path", async () => {
  // The warning is read by whoever debugs a suite-wide canvas break. It is worth
  // nothing if it fires on every one of the ~140 dependent specs.
  const canvas = fakeCanvas({ menuOpen: true });
  const warnings = await captureWarnings(() =>
    closeCanvasControls(canvas.page, true, "adjustScreenView"),
  );
  assert.deepEqual(warnings, []);
});
