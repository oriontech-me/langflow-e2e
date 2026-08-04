import { type Page, expect } from "@playwright/test";
import { assertAssistantOnboardingSeeded } from "./assistant-onboarding";

// Expand the currently focused node from minimized to full view. Chat Input,
// Chat Output and If-Else all default to `minimized = True` (see their component
// Python sources); while minimized, the run button and the body-rendered input
// handles are not present in the DOM. Idempotent: if the node is already expanded
// (no `hide-node-content` in the DOM) this is a no-op, which future-proofs callers
// against an upstream change to the `minimized` default.
//
// The `more-options-modal` (⋮) menu that hosts the expand action lives in a
// floating ReactFlow NodeToolbar and only mounts for the SELECTED node. On 1.12 a
// REAL coordinate click on that ⋮ button is hit-tested by the ReactFlow pane and
// DESELECTS the node — which unmounts the toolbar and destroys the Radix menu as
// it opens, so the expand item never appears (issue #867: reproduced at
// `--workers=1` with no backend load — a UI-interaction defect, not the earlier
// backend-saturation theory of #816/#817; deselection confirmed via
// instrumentation). The fix dispatches the pointer events directly on the ⋮
// element (see the retry below) so the pane never sees a coordinate hit.
export async function expandFocusedNode(page: Page): Promise<void> {
  // The assistant onboarding tooltip overlays the canvas-controls region and can
  // eat a hit-tested click, so a caller of this helper must have suppressed it —
  // which only a PRE-LOAD seed can do (upstream snapshots the flag at mount, so
  // there is nothing this helper could write here that would take effect).
  //
  // This used to be `dismissOnboardingIfPresent(page)`, on this line and again
  // inside the retry below. #1220 measured both on 1.12.0.dev15: 39 executions
  // each, firing 0.92–3.70 s after the canvas-controls bar mounted, against a
  // tooltip that cannot appear before mount + 10 000 ms — so 0 of 78 ever saw
  // anything, and the comment they carried claimed a protection that had never
  // once been performed. Asserting the seed instead is deterministic: it reads the
  // flag, needs no waiting, and names the fix when a spec forgets.
  await assertAssistantOnboardingSeeded(page, "expandFocusedNode");

  if ((await page.getByTestId("hide-node-content").count()) === 0) return;

  const minimizedNode = page
    .locator('.react-flow__node:has([data-testid="hide-node-content"])')
    .first();
  const moreOptions = page.getByTestId("more-options-modal");
  const expandButton = page.getByTestId("expand-button-modal");

  // Drive re-select → open-menu → expand → settle as ONE retried unit. `toPass`
  // re-runs the body until the node has actually left the minimized state,
  // replacing the manual attempt loop + fixed `waitForTimeout` (Playwright
  // anti-patterns) with a web-first assertion.
  await expect(async () => {
    // A prior retry may already have expanded the node — nothing minimized left.
    if ((await minimizedNode.count()) === 0) return;
    // The ⋮ toolbar mounts only for the selected node; re-select it (a real click
    // on the node BODY, which lives in the pane, selects correctly) if the toolbar
    // is gone. This is the recovery for a selection genuinely lost before entry.
    if ((await moreOptions.count()) === 0) {
      await minimizedNode.click();
    }
    // Open the ⋮ menu by DISPATCHING the pointer events on the trigger element
    // rather than issuing a real coordinate click — a real click deselects the
    // node via the ReactFlow pane and destroys the menu (see the header comment,
    // issue #867). Dispatching directly opens the Radix menu with selection intact.
    await moreOptions.dispatchEvent("pointerdown");
    await moreOptions.dispatchEvent("pointerup");
    await moreOptions.dispatchEvent("click");
    await expandButton.click({ timeout: 5000 });
    await expect(page.getByTestId("hide-node-content")).toHaveCount(0, {
      timeout: 5000,
    });
  }).toPass({ timeout: 30000 });
}
