import type { Page } from "@playwright/test";

/**
 * Runs a flow by triggering a terminal node's run control, which builds the
 * whole upstream graph.
 *
 * Langflow (1.11) has no global "run flow" button — a flow is run from a
 * terminal node (`button_run_{node}`), and the build cascades to every upstream
 * dependency. This generalizes `run-chat-output.ts` to any terminal node.
 *
 * If the node is minimized (its run control is not in the DOM), the node is
 * expanded first, then the run control is clicked. Idempotent w.r.t. expansion:
 * a node that already exposes its run button is clicked directly.
 *
 * @param page          Playwright page positioned on the flow canvas.
 * @param terminalNode  Lowercased node display name, e.g. "chat output".
 */
export async function runFlow(page: Page, terminalNode = "chat output") {
  const runButton = page.getByTestId(`button_run_${terminalNode}`);
  // Expand only when the node is minimized (run control absent from the DOM) —
  // decided by presence, not by a click timeout. On a re-run the button is
  // present but briefly non-clickable while the prior build settles, so the
  // click below relies on Playwright's actionability auto-wait rather than a
  // tight timeout + (wrong) expand fallback.
  if ((await runButton.count()) === 0) {
    await page.getByTestId("generic-node-title-arrangement").last().click();
    await page.getByTestId("more-options-modal").last().click();
    await page.getByTestId("expand-button-modal").last().click();
  }
  await runButton.click({ timeout: 15000 });
}
