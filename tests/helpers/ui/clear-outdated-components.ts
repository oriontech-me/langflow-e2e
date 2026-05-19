import type { Page } from "@playwright/test";

export async function clearOutdatedComponents(page: Page, maxIterations = 20) {
  let count = await page.getByTestId("update-button").count();
  let iterations = 0;
  while (count > 0) {
    if (++iterations > maxIterations) {
      throw new Error(
        `update-button count did not reach 0 after ${maxIterations} iterations (last count: ${count})`,
      );
    }
    await page.getByTestId("update-button").first().click();
    count = await page.getByTestId("update-button").count();
  }
}
