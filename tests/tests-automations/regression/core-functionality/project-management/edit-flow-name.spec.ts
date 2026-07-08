import { expect, test } from "../../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../../helpers/other/await-bootstrap-test";
import { renameFlow } from "../../../../helpers/flows/rename-flow";

test(
  "user should be able to edit flow name and see it reflected in the main page listing",
  { tag: ["@release", "@workspace", "@regression", "@stable"] },
  async ({ page }) => {
    await awaitBootstrapTest(page);

    await page.getByRole("heading", { name: "Basic Prompting" }).click();

    const names = [
      Math.random().toString(36).substring(2, 15),
      Math.random().toString(36).substring(2, 15),
    ];

    for (const targetName of names) {
      await renameFlow(page, { flowName: targetName });

      const { flowName } = await renameFlow(page);
      expect(flowName).toBe(targetName);

      await page.getByTestId("icon-ChevronLeft").first().click();

      await page.waitForSelector('[data-testid="home-dropdown-menu"]', {
        timeout: 5000,
      });

      await page.waitForSelector(`text=${targetName}`, {
        timeout: 3000,
        state: "visible",
      });

      await expect(page.getByText(targetName)).toHaveCount(1);

      // Re-open the flow by clicking its name in the listing — required so the next
      // iteration starts inside the editor with renameFlow() targeting the flow header.
      // The /flows a11y refactor (Langflow #13891) makes the card content
      // pointer-events-none; open the flow via the card's overlay button.
      await page
        .getByTestId("list-card")
        .filter({
          has: page.getByTestId("flow-name-div").filter({ hasText: targetName }),
        })
        .getByTestId("list-card-open-button")
        .first()
        .click();
    }
  },
);
