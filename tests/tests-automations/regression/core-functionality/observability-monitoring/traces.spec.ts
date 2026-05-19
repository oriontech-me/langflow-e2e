import { expect, test } from "../../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../../helpers/other/await-bootstrap-test";
import { clearApiKeyBadges } from "../../../../helpers/ui/clear-api-key-badges";
import { clearOutdatedComponents } from "../../../../helpers/ui/clear-outdated-components";

test(
  "should be able to see and interact with Traces",
  { tag: ["@stable", "@release", "@workspace", "@observability"] },

  async ({ page }) => {
    await awaitBootstrapTest(page);

    await page.getByTestId("side_nav_options_all-templates").click();
    await page.getByRole("heading", { name: "Basic Prompting" }).click();
    await expect(page.getByTestId(/.*rf__node.*/).first()).toBeVisible({
      timeout: 3000,
    });
    await clearOutdatedComponents(page);
    await clearApiKeyBadges(page);

    await page.getByRole("button", { name: "Traces" }).first().click();
    await expect(
      page.getByText("No Data Available", { exact: true }),
    ).toBeVisible();
  },
);

