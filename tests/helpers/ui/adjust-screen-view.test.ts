// Unit tests for adjustScreenView (issues #997, #1053).
// Run with: npm run test:units
//
// Why this helper is unit-tested at all: 61 spec files call it directly and
// another 47 reach it through `setupPlayground`, `initialGPTsetup`,
// `prompt-template` and `SimpleAgentTemplatePage` — 108 in total, most of the
// indirect half in `llm-agents/` and `playground/`, where a canvas interceptor
// reads as an agent or provider failure.
//
// The simulated widget, and why the failing branch is unreachable from any E2E
// spec, are documented in `./canvas-controls.fake`. The menu-open/close mechanism
// itself is covered in `./canvas-controls.test.ts`; what is asserted here is this
// helper's own behaviour on top of it — the fit-view step, the settle poll, the
// zoom-out loop, and the partial-migration refusal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { adjustScreenView } from "./adjust-screen-view";
import { captureWarnings, fakeCanvas } from "./canvas-controls.fake";

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

test("falls back to intent when the trigger exposes no data-state, and says so", async () => {
  const opened = fakeCanvas({
    layout: "in-dropdown",
    menuOpen: false,
    exposesDataState: false,
  });
  const warnings = await captureWarnings(() => adjustScreenView(opened.page));
  assert.equal(opened.triggerClicks, 2, "closes what it opened");
  assert.equal(opened.menuOpen, false);

  // Degrading into #997's boolean must never be silent: no other test can catch
  // it, because this very test asserts the fallback as acceptable behaviour.
  assert.equal(warnings.length, 1, JSON.stringify(warnings));
  assert.match(
    warnings[0],
    /adjustScreenView/,
    "the warning must name the caller — four helpers share this code (#1053)",
  );
  assert.match(warnings[0], /data-state/);
  assert.match(warnings[0], /#997/);

  const untouched = fakeCanvas({
    layout: "on-canvas",
    menuOpen: false,
    exposesDataState: false,
  });
  await captureWarnings(() => adjustScreenView(untouched.page));
  assert.equal(
    untouched.triggerClicks,
    0,
    "without a state signal it must still never OPEN a menu",
  );
  assert.equal(untouched.menuOpen, false);
});

test("the normal path warns about nothing", async () => {
  // The warning is only worth anything if it does not cry wolf on 108 specs.
  const canvas = fakeCanvas({ layout: "in-dropdown", menuOpen: false });
  const warnings = await captureWarnings(() => adjustScreenView(canvas.page));
  assert.deepEqual(warnings, []);
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
  // Also the shape `uploadFile` now calls (#1053): fit the view, zoom nothing,
  // leave the menu closed.
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
