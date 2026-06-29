import { type Page, expect } from "@playwright/test";

// Langflow 1.11.x (nightly) opens a right-side node Inspector Panel when a node
// is selected. The panel is a `react-flow__panel` overlay (`w-[320px]`,
// anchored `!top-[3rem] !-right-2`) that overlaps the node's `model_model`
// dropdown and intercepts the click ("subtree intercepts pointer events"),
// intermittently failing every helper that opens the model picker on the
// canvas. Neither Escape nor clicking the canvas pane closes it — only the
// canvas-control toggle does.
//
// The toggle (`canvas_controls_toggle_inspector`) reflects the panel's open
// state via `aria-pressed`, and the panel is conditionally rendered
// (`{inspectionPanelVisible && <InspectionPanel/>}`) with a zero-duration exit
// transition — so once `aria-pressed` flips to "false" the overlay is detached,
// not merely animating out. We drive and assert on that state (and on the
// overlay leaving the DOM) instead of the toggle's accessible name, so the wait
// is deterministic and tied to the element that actually intercepts the click.
//
// Robustness: we wait for the always-present canvas controls bar
// (`main_canvas_controls`) to mount rather than probing the toggle with a short
// timeout that silently skips the close under CPU contention (the parallel-run
// failure mode where the overlay stayed up and raced the `model_model` click —
// a 20s click timeout in CI). The long wait is spent on the bar — which renders
// on every build — so it absorbs that slowness without charging the timeout to
// builds that merely lack the feature. The toggle itself is gated by
// `ENABLE_INSPECTION_PANEL` and renders in the same component as the bar, so
// once the bar is mounted the toggle is either already present or absent for
// this build — a short probe tells them apart and the helper is a fast no-op
// when the panel feature is off.
export async function hideInspectorPanel(page: Page): Promise<void> {
  // Wait for the canvas controls bar to mount (absorbs CPU-contention slowness).
  const controlsReady = await page
    .getByTestId("main_canvas_controls")
    .waitFor({ state: "attached", timeout: 10000 })
    .then(() => true)
    .catch(() => false);
  if (!controlsReady) return; // no canvas controls at all — nothing to do

  // The toggle renders in the same commit as the bar, so a short probe is enough
  // to distinguish "feature off" from "still mounting" without a long no-op wait.
  const toggle = page.getByTestId("canvas_controls_toggle_inspector");
  const toggleAttached = await toggle
    .waitFor({ state: "attached", timeout: 1000 })
    .then(() => true)
    .catch(() => false);
  if (!toggleAttached) return; // build without the Inspector Panel — no-op

  // Already closed (no node selected, or previously hidden) — nothing to do.
  if ((await toggle.getAttribute("aria-pressed")) !== "true") return;

  await toggle.click();

  // Deterministic settle: the panel unmounts when the toggle state flips, so
  // wait for the state to flip AND the 320px overlay to leave the DOM before
  // the caller clicks `model_model`.
  await expect(toggle).toHaveAttribute("aria-pressed", "false", {
    timeout: 5000,
  });
  await page
    .locator(".react-flow__panel:has([data-testid='panel-name'])")
    .waitFor({ state: "detached", timeout: 5000 })
    .catch(() => {});
}
