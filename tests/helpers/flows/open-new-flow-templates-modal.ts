import type { Page } from "@playwright/test";

const WELCOME_PANEL = '[data-testid="flow-builder-welcome-panel"]';
const MODAL_TITLE = '[data-testid="modal-title"]';

/**
 * After an action that should open the templates modal (the header "New Flow"
 * button or the empty-page CTA), reconcile the Langflow 1.10.0
 * `FlowBuilderWelcome` overlay: those entry points may navigate to a
 * freshly-created flow and surface the welcome overlay instead of the modal.
 *
 * Race the overlay against the modal; if the overlay surfaces, dismiss it via
 * "Browse more templates", then wait for the modal. When the modal opens
 * directly (older builds, or the empty-page CTA) the overlay branch is skipped
 * — so this is backward-compatible. Shared between the two entry points so the
 * selector/timeout logic can't drift.
 */
export const dismissWelcomeOverlayAndWaitForModal = async (page: Page) => {
  await Promise.race([
    page.waitForSelector(WELCOME_PANEL, { timeout: 30000 }),
    page.waitForSelector(MODAL_TITLE, { timeout: 30000 }),
  ]);

  if ((await page.locator(WELCOME_PANEL).count()) > 0) {
    await page.getByTestId("flow-builder-welcome-browse-more").click();
  }

  await page.waitForSelector(MODAL_TITLE, { timeout: 30000 });
};

/**
 * Clicks the header "New Flow" button (`new-project-btn`) and lands on the
 * templates modal, handling the 1.10.0 welcome overlay (see
 * `dismissWelcomeOverlayAndWaitForModal`).
 *
 * Single source of truth for the "New Flow → templates modal" flow, used by
 * `awaitBootstrapTest` and any spec that opens the modal mid-test.
 */
export const openNewFlowTemplatesModal = async (page: Page) => {
  await page.getByTestId("new-project-btn").click();
  await dismissWelcomeOverlayAndWaitForModal(page);
};
