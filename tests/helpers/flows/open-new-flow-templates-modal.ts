import type { Page } from "@playwright/test";

/**
 * Clicks the "New Flow" button (`new-project-btn`) and lands on the templates
 * modal.
 *
 * Langflow 1.10.0 changed this button: instead of opening the templates modal
 * directly, it creates a fresh empty flow and surfaces the FlowBuilderWelcome
 * overlay. Race the overlay against the modal; if the overlay surfaces, dismiss
 * it via "Browse more templates" to reach the templates modal. On older builds
 * (or the empty-page CTA path) the modal opens directly and the overlay branch
 * is skipped — so this is backward-compatible.
 *
 * Single source of truth for the "New Flow → templates modal" flow, used by
 * `awaitBootstrapTest` and any spec that opens the modal mid-test.
 */
export const openNewFlowTemplatesModal = async (page: Page) => {
  await page.getByTestId("new-project-btn").click();

  const welcomeSelector = '[data-testid="flow-builder-welcome-panel"]';
  await Promise.race([
    page.waitForSelector(welcomeSelector, { timeout: 30000 }),
    page.waitForSelector('[data-testid="modal-title"]', { timeout: 30000 }),
  ]);

  if ((await page.locator(welcomeSelector).count()) > 0) {
    await page.getByTestId("flow-builder-welcome-browse-more").click();
  }

  await page.waitForSelector('[data-testid="modal-title"]', { timeout: 30000 });
};
