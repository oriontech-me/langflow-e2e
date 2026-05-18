import { expect, test } from "../../../../fixtures/fixtures";
import { adjustScreenView } from "../../../../helpers/ui/adjust-screen-view";
import { awaitBootstrapTest } from "../../../../helpers/other/await-bootstrap-test";

test(
  "user should be able to select flows with different methods and perform bulk actions",
  { tag: ["@stable", "@release", "@workspace", "@mainpage", "@regression"] },
  async ({ page }) => {
    await awaitBootstrapTest(page);

    try {
      // Add some flows to test with
      await page.getByTestId("side_nav_options_all-templates").click();
      await page.getByRole("heading", { name: "Basic Prompting" }).click();
      await adjustScreenView(page);

      // Go back to main page
      await page.waitForSelector('[data-testid="sidebar-search-input"]', {
        timeout: 30000,
      });
      await page.getByTestId("icon-ChevronLeft").first().click();

      await expect(page.getByText("Projects").first()).toBeVisible({ timeout: 10000 });
      await page.getByTestId("new-project-btn").click();
      await page.getByTestId("side_nav_options_all-templates").click();
      await page.getByRole("heading", { name: "Document Q&A" }).click();
      await page.waitForSelector('[data-testid="sidebar-search-input"]', {
        timeout: 30000,
      });
      await page.getByTestId("icon-ChevronLeft").first().click();

      await expect(page.getByText("Projects").first()).toBeVisible({ timeout: 10000 });
      await page.getByTestId("new-project-btn").click();
      await page.getByTestId("side_nav_options_all-templates").click();
      await page.getByRole("heading", { name: "Basic Prompting" }).click();
      await page.waitForSelector('[data-testid="sidebar-search-input"]', {
        timeout: 30000,
      });
      await page.getByTestId("icon-ChevronLeft").first().click();

      await expect(page.getByText("Projects").first()).toBeVisible({ timeout: 10000 });
      await page.waitForSelector('[data-testid="home-dropdown-menu"]', {
        timeout: 30000,
      });
      await expect(page.getByTestId("list-card").first()).toBeVisible({ timeout: 10000 });

      // Test shift selection
      await page.keyboard.down("Shift");
      await page.getByTestId("list-card").first().click();
      await page.getByTestId("list-card").nth(2).click();
      await page.keyboard.up("Shift");

      // Verify both flows are selected
      const firstCheckbox = page.getByTestId(/^checkbox-/).first();
      const secondCheckbox = page.getByTestId(/^checkbox-/).nth(1);
      const thirdCheckbox = page.getByTestId(/^checkbox-/).nth(2);
      await expect(firstCheckbox).toBeChecked();
      await expect(secondCheckbox).toBeChecked();
      await expect(thirdCheckbox).toBeChecked();
      // Test bulk download
      await page.getByTestId("download-bulk-btn").last().click();
      await expect(page.getByText(/.*downloaded successfully/)).toBeVisible({
        timeout: 10000,
      });

      // Deselect all
      await page.keyboard.down("Shift");
      await page.getByTestId("list-card").first().click();
      await page.keyboard.up("Shift");

      // Verify both flows are deselected
      await expect(firstCheckbox).not.toBeChecked();
      await expect(secondCheckbox).not.toBeChecked();
      await expect(thirdCheckbox).not.toBeChecked();

      // Test Ctrl/Cmd selection
      await page.keyboard.down("ControlOrMeta");
      await page.getByTestId("list-card").first().click();
      await page.getByTestId("list-card").nth(2).click();
      await page.keyboard.up("ControlOrMeta");

      // Verify both flows are selected again
      await expect(firstCheckbox).toBeChecked();
      await expect(secondCheckbox).not.toBeChecked();
      await expect(thirdCheckbox).toBeChecked();

      const firstFlowName =
        (await page
          .locator("[data-testid='flow-name-div']")
          .first()
          .locator("span")
          .textContent()) ?? "";
      const secondFlowName =
        (await page
          .locator("[data-testid='flow-name-div']")
          .nth(1)
          .locator("span")
          .textContent()) ?? "";
      const thirdFlowName =
        (await page
          .locator("[data-testid='flow-name-div']")
          .nth(2)
          .locator("span")
          .textContent()) ?? "";

      // Test bulk delete
      await page.getByTestId("delete-bulk-btn").first().click();
      await expect(page.getByText("This can't be undone.")).toBeVisible({ timeout: 5000 });
      await page.getByText("Delete").last().click();

      // Verify deletion success message
      await expect(page.getByText("Flows deleted successfully")).toBeVisible({
        timeout: 10000,
      });

      // Verify flows are deleted
      await expect(
        page.getByText(firstFlowName, { exact: true }),
      ).toBeHidden();
      await expect(page.getByText(secondFlowName, { exact: true })).toBeVisible();
      await expect(
        page.getByText(thirdFlowName, { exact: true }),
      ).toBeHidden();
    } finally {
      // Best-effort cleanup of any flows still on the listing.
      // Skipping on selector miss is acceptable — this is cleanup, not test logic.
      try {
        const homeBack = page.getByTestId("icon-ChevronLeft").first();
        if (await homeBack.isVisible({ timeout: 2000 })) {
          await homeBack.click();
          await page.waitForSelector('[data-testid="home-dropdown-menu"]', {
            timeout: 10000,
          });
        }
        const cardCount = await page.getByTestId(/^list-card/).count();
        if (cardCount > 0) {
          await page.keyboard.down("Shift");
          await page.getByTestId(/^list-card/).first().click();
          if (cardCount >= 2) {
            await page.getByTestId(/^list-card/).last().click();
          }
          await page.keyboard.up("Shift");
          const bulkBtn = page.getByTestId("delete-bulk-btn").first();
          if (await bulkBtn.isVisible({ timeout: 2000 })) {
            await bulkBtn.click();
            await page.getByText("Delete").last().click();
          }
        }
      } catch {
        // Cleanup is best-effort — do not mask the original test failure.
      }
    }
  },
);
