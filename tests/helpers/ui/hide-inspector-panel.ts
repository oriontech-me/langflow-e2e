import type { Page } from "@playwright/test";

// Langflow 1.11.x (nightly) opens a right-side node Inspector Panel when a node
// is selected. The panel overlaps the node's `model_model` dropdown and
// intercepts the click ("subtree intercepts pointer events"), intermittently
// failing every helper that opens the model picker on the canvas. Neither
// Escape nor clicking the canvas pane closes it — only the canvas-control
// toggle does.
//
// Hiding is idempotent: the "Hide Inspector Panel" accessible name only matches
// when the panel is open, so this never re-opens a closed panel. It is a no-op
// on Langflow builds without the panel (the button is absent), so it is safe to
// call unconditionally before any `model_model` click.
export async function hideInspectorPanel(page: Page): Promise<void> {
  const hide = page.getByRole("button", { name: "Hide Inspector Panel" });
  if (await hide.isVisible({ timeout: 1000 }).catch(() => false)) {
    await hide.click();
    await hide.waitFor({ state: "hidden", timeout: 5000 }).catch(() => {});
  }
}
