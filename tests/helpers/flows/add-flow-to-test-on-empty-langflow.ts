import type { Page } from "@playwright/test";

export const addFlowToTestOnEmptyLangflow = async (page: Page) => {
  await page.getByTestId("new_project_btn_empty_page").click();

  // Langflow 1.10.0: the empty-page CTA usually opens the templates modal
  // directly, but a fresh instance can race the FlowBuilderWelcome overlay
  // instead. Wait for whichever mounts; if the overlay surfaces, dismiss it
  // via "Browse more templates" to reach the templates modal.
  const modalSelector = '[data-testid="modal-title"]';
  const welcomeSelector = '[data-testid="flow-builder-welcome-panel"]';
  await Promise.race([
    page.waitForSelector(modalSelector, { timeout: 30000 }),
    page.waitForSelector(welcomeSelector, { timeout: 30000 }),
  ]);
  if ((await page.locator(welcomeSelector).count()) > 0) {
    await page.getByTestId("flow-builder-welcome-browse-more").click();
    await page.waitForSelector(modalSelector, { timeout: 30000 });
  }

  await page.getByTestId("side_nav_options_all-templates").click();
  await page.getByRole("heading", { name: "Basic Prompting" }).click();
  await page.getByTestId("icon-ChevronLeft").click();
  // Wait for home page to finish loading before awaitBootstrapTest continues.
  // Without this, the subsequent new-project-btn click can fire before navigation
  // completes, leaving tests in an inconsistent state.
  await page.waitForSelector('[data-testid="mainpage_title"]', {
    timeout: 15000,
  });
};
