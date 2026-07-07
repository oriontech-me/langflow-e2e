import { expect, test } from "../../../fixtures/fixtures";
import { setupBlankFlow } from "../../../helpers/flows/setup-blank-flow";
import { deleteFlow } from "../../../helpers/flows/delete-flow";

test.describe("Show Beta Components toggle", () => {
  let createdFlowId: string | null = null;

  test.beforeEach(async ({ page }) => {
    // setupBlankFlow creates the flow via API (avoids the UI-creation 500 race)
    // and returns its id so afterEach can clean it up.
    createdFlowId = await setupBlankFlow(page);
    await expect(page.getByTestId("sidebar-search-input")).toBeVisible({
      timeout: 10000,
    });
  });

  test.afterEach(async ({ page }) => {
    if (createdFlowId) {
      // Leave the editor first: staying on it while the flow is deleted makes
      // background polling 404, which the fixture's error monitor would flag.
      await page.goto("/").catch(() => {});
      await deleteFlow(page.request, createdFlowId);
      createdFlowId = null;
    }
  });

  test(
    "Show Beta Components toggle controls visibility of beta components in the sidebar",
    { tag: ["@stable", "@regression", "@components"] },
    async ({ page }) => {
      await test.step("Amazon Bedrock Converse is visible while the toggle is ON (baseline)", async () => {
        // The beta toggle defaults to ON (showBeta = true), so the beta
        // component is visible without any interaction. This is the baseline
        // the OFF state is compared against.
        await page.getByTestId("sidebar-search-input").fill("Amazon Bedrock");
        await expect(
          page.getByTestId("amazonAmazon Bedrock Converse"),
        ).toBeVisible();
      });

      await test.step("Disable the Show Beta Components toggle", async () => {
        // Clear the search first: an active search renders a second
        // 'sidebar-options-trigger', which would break Playwright strict mode.
        await page.getByTestId("sidebar-search-input").fill("");
        await page.getByTestId("sidebar-options-trigger").click();
        // Confirm the toggle is ON before flipping it — makes the baseline's
        // precondition explicit and gives a clear failure if the default changes.
        await expect(page.getByTestId("sidebar-beta-switch")).toBeChecked();
        await page.getByTestId("sidebar-beta-switch").click();
        await expect(page.getByTestId("sidebar-beta-switch")).not.toBeChecked();
        await page.getByTestId("sidebar-options-trigger").click();
      });

      await test.step("Amazon Bedrock Converse is hidden while the toggle is OFF", async () => {
        // Same search term as the baseline; only the toggle changed.
        await page.getByTestId("sidebar-search-input").fill("Amazon Bedrock");
        // Positive control: Amazon Bedrock Embeddings is neither beta nor legacy,
        // so it always matches this search. Asserting it first proves the list
        // rendered, so the toHaveCount(0) below means "filtered out by the
        // toggle", not "the list hadn't rendered yet".
        await expect(
          page.getByTestId("amazonAmazon Bedrock Embeddings"),
        ).toBeVisible();
        await expect(
          page.getByTestId("amazonAmazon Bedrock Converse"),
        ).toHaveCount(0);
      });
    },
  );
});
