import type { Page } from "@playwright/test";

export const addFlowToTestOnEmptyLangflow = async (page: Page) => {
  await page.getByTestId("new_project_btn_empty_page").click();
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
