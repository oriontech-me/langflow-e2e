import { test } from "../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";

test.skip("should exists Store", { tag: ["@release"] }, async ({ page }) => {
  await awaitBootstrapTest(page, { skipModal: true });

  await page.getByTestId("button-store").isVisible();
  await page.getByTestId("button-store").isEnabled();
});

test.skip(
  "should not have an API key",
  { tag: ["@release"] },
  async ({ page }) => {
    await awaitBootstrapTest(page, { skipModal: true });

    await page.getByTestId("button-store").click();

    await page.getByText("API Key Error").isVisible();
  },
);
