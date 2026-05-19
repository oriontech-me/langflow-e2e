import type { Page } from "@playwright/test";

export async function clearApiKeyBadges(page: Page, maxIterations = 20) {
  let count = await page.getByTestId("remove-icon-badge").count();
  let iterations = 0;
  while (count > 0) {
    if (++iterations > maxIterations) {
      throw new Error(
        `remove-icon-badge count did not reach 0 after ${maxIterations} iterations (last count: ${count})`,
      );
    }
    await page.getByTestId("remove-icon-badge").first().click();
    count = await page.getByTestId("remove-icon-badge").count();
  }
}
