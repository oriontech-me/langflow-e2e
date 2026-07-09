import { expect, type Page } from "@playwright/test";

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
  // expect.poll instead of Promise.race(waitForSelector×2): the race's losing
  // wait survives as a spurious red ✗ step in every trace that goes through
  // the overlay branch, reading like a recurring failure (#599). Not
  // locator.or().first() either — .first() picks by DOM order, so an
  // attached-but-hidden welcome panel sitting before the modal in the DOM
  // pins the visibility wait to the full timeout.
  const welcomePanel = page.locator(WELCOME_PANEL);
  const modalTitle = page.locator(MODAL_TITLE);
  await expect
    .poll(
      async () =>
        (await modalTitle.isVisible().catch(() => false)) ||
        (await welcomePanel.isVisible().catch(() => false)),
      { timeout: 30000 },
    )
    .toBe(true);

  // isVisible, not count() — an attached-but-hidden panel must not trigger a
  // click on the (equally hidden) "Browse more templates" button.
  if (await welcomePanel.isVisible().catch(() => false)) {
    await page.getByTestId("flow-builder-welcome-browse-more").click();
  }

  await page.waitForSelector(MODAL_TITLE, { timeout: 30000 });
};

/**
 * Clicks whichever "New Flow" entry point the home page exposes and lands on
 * the templates modal, handling the 1.10.0 welcome overlay (see
 * `dismissWelcomeOverlayAndWaitForModal`).
 *
 * Both the header button (`new-project-btn`, present when flows exist) and the
 * empty-page CTA (`new_project_btn_empty_page`, shown on a flowless home) open
 * the same modal — `.or().first()` picks whichever is in the DOM (the header is
 * DOM-first when both render, which is harmless since both trigger the same
 * action). The auto-waiting click also absorbs the brief window where a
 * just-closed confirmation modal's backdrop is still fading.
 *
 * Single source of truth for the "New Flow → templates modal" flow, used by
 * `awaitBootstrapTest`, `loadTemplateByName`, and any spec that opens the modal
 * mid-test.
 */
export const openNewFlowTemplatesModal = async (page: Page) => {
  const newProjectBtn = page.getByTestId("new-project-btn");
  const emptyBtn = page.getByTestId("new_project_btn_empty_page");
  await newProjectBtn.or(emptyBtn).first().click({ timeout: 15000 });
  await dismissWelcomeOverlayAndWaitForModal(page);
};
