import { expect, test } from "../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";

test(
  "Show Beta Components toggle controls visibility of Beta components in the sidebar",
  { tag: ["@stable", "@regression", "@components"] },
  async ({ page }) => {
    await test.step("Open a blank flow", async () => {
        await awaitBootstrapTest(page);
        await page.getByTestId("blank-flow").click();
        await expect(page.getByTestId("sidebar-search-input")).toBeVisible({
            timeout: 10000,
            });
        });
    
    await test.step("Amazon Bedrock Converse is visible while the toggle is ON (baseline)", async () => {
        await page.getByTestId("sidebar-search-input").fill("Amazon Bedrock");
        await expect(
            page.getByTestId("amazonAmazon Bedrock Converse")
        ).toBeVisible();
    });

    await test.step("Amazon Bedrock Converse is hidden while the toggle is OFF", async () => {
        await page.getByTestId("sidebar-search-input").fill("");
        await page.getByTestId("sidebar-options-trigger").click();
        await page.getByTestId("sidebar-beta-switch").click();
        await expect(
            page.getByTestId("sidebar-beta-switch")
        ).not.toBeChecked();
        await page.getByTestId("sidebar-options-trigger").click();
        await page.getByTestId("sidebar-search-input").fill("Amazon Bedrock");
        await expect(
            page.getByTestId("amazonAmazon Bedrock Embeddings")
        ).toBeVisible();
        await expect(
            page.getByTestId("amazonAmazon Bedrock Converse")
        ).toHaveCount(0);
    });
    }  
);