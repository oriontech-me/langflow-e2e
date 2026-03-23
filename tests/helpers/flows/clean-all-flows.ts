import { Page } from "@playwright/test";

export const cleanAllFlows = async (page: Page) => {
  await page.waitForSelector(
    '[data-testid="empty_page_description"], [data-testid="home-dropdown-menu"]',
    { timeout: 20000 },
  );
  let emptyPageDescription = page.getByTestId("empty_page_description");
  while ((await emptyPageDescription.count()) === 0) {
    await page.getByTestId("home-dropdown-menu").first().click();
    await page.getByTestId("btn_delete_dropdown_menu").first().click();
    await page
      .getByTestId("btn_delete_delete_confirmation_modal")
      .first()
      .click();
    await page.waitForTimeout(1000);
  }
};
