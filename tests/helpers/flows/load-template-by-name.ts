import type { Page } from "@playwright/test";
import { cleanAllFlows } from "./clean-all-flows";
import { openNewFlowTemplatesModal } from "./open-new-flow-templates-modal";

/**
 * Canonical "load a starter template by name" flow, shared by every spec that
 * needs a template on the canvas.
 *
 * Steps: clear any user-created flows (so re-loading the same template can't
 * 400 on a duplicate name) → open the templates modal via whichever New Flow
 * entry point exists → switch to the All Templates tab → pick the template
 * whose heading matches `templateName`. Returns once the canvas controls are
 * visible; callers run their own post-load steps (provider setup, component
 * migration, assertions).
 *
 * Flow deletion uses the API (`cleanAllFlows`) rather than the home dropdown
 * menu: that Radix portal detaches from the DOM mid-click under re-renders, so
 * the old per-spec UI deletion loops were a recurring flake source.
 */
export const loadTemplateByName = async (
  page: Page,
  templateName: string,
): Promise<void> => {
  // Clear flows via the API first, then load home — so the page reflects the
  // real backend state (empty page vs. populated) when we pick an entry point.
  await cleanAllFlows(page);

  await page.goto("/");
  await page.waitForSelector('[data-testid="mainpage_title"]', {
    timeout: 30000,
  });

  await openNewFlowTemplatesModal(page);

  await page.getByTestId("side_nav_options_all-templates").click();
  await page.getByRole("heading", { name: templateName }).first().click();

  await page.waitForSelector('[data-testid="canvas_controls_dropdown"]', {
    timeout: 30000,
  });
};
