import { expect, test } from "../../../../fixtures/fixtures";
import { adjustScreenView } from "../../../../helpers/ui/adjust-screen-view";
import { awaitBootstrapTest } from "../../../../helpers/other/await-bootstrap-test";

test.describe("Flow Page tests", () => {
  test("save", { tag: ["@release"] }, async ({ page }) => {
    await awaitBootstrapTest(page);

    await page.getByTestId("blank-flow").click();

    await page.waitForSelector(
      '[data-testid="sidebar-custom-component-button"]',
      {
        timeout: 30000,
      },
    );

    await page.getByTestId("sidebar-custom-component-button").click();

    await adjustScreenView(page, { numberOfZoomOut: 3 });

    // Verify the Custom Component was added to the canvas
    await expect(page.locator(".react-flow__node")).toHaveCount(1, {
      timeout: 10000,
    });
    await expect(page.getByTestId("title-Custom Component")).toBeVisible({
      timeout: 5000,
    });
  });
});
