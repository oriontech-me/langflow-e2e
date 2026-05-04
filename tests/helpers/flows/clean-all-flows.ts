import { Page } from "@playwright/test";

export const cleanAllFlows = async (page: Page) => {
  const emptyPageDescription = page.getByTestId("empty_page_description");
  while (true) {
    await page.waitForSelector(
      '[data-testid="empty_page_description"], [data-testid="home-dropdown-menu"]',
      { timeout: 20000 },
    );
    if ((await emptyPageDescription.count()) > 0) break;
    await page.getByTestId("home-dropdown-menu").first().click();
    await page
      .getByTestId("btn_delete_dropdown_menu")
      .first()
      .click({ timeout: 8000 });
    await page
      .getByTestId("btn_delete_delete_confirmation_modal")
      .first()
      .click();
  }
};
