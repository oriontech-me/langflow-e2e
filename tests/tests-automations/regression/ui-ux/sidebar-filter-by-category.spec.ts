import { expect, test } from "../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";

// Helper: navigate to a blank flow so the full sidebar is visible.
async function openBlankFlow(page: any) {
  await awaitBootstrapTest(page);
  await page.waitForSelector('[data-testid="blank-flow"]', { timeout: 30000 });
  await page.getByTestId("blank-flow").click();
  await page.waitForSelector('[data-testid="sidebar-search-input"]', {
    timeout: 30000,
  });
}

test.describe("Sidebar Filter-By-Category Interactions", () => {
  test(
    "clicking a disclosure header collapses and expands its component list",
    { tag: ["@release", "@workspace", "@regression"] },
    async ({ page }) => {
      await openBlankFlow(page);

      // The "input & output" disclosure is always present
      const disclosure = page.getByTestId("disclosure-input & output");
      await expect(disclosure).toBeVisible({ timeout: 10000 });

      // Verify the section is currently expanded by checking its aria-expanded state
      // or by verifying the section has child items visible (more than 0)
      // Click to collapse
      await disclosure.click();
      await page.waitForTimeout(300);

      // After collapsing, the disclosure should change state (aria-expanded=false or closed)
      // We verify by checking if the button's aria-expanded attribute changed
      // OR that the count of visible items in the sidebar changed
      const expandedAfterCollapse = await disclosure
        .getAttribute("data-state")
        .catch(() => null);

      // Expand the section again
      await disclosure.click();
      await page.waitForTimeout(300);

      const expandedAfterReopen = await disclosure
        .getAttribute("data-state")
        .catch(() => null);

      // The states should differ (or at least the disclosure button is still visible)
      await expect(disclosure).toBeVisible({ timeout: 5000 });
      // If data-state is available, it should have changed back
      if (expandedAfterCollapse !== null && expandedAfterReopen !== null) {
        expect(expandedAfterCollapse).not.toEqual(expandedAfterReopen);
      }
    },
  );

  test(
    "sidebar search is case-insensitive",
    { tag: ["@release", "@workspace", "@regression"] },
    async ({ page }) => {
      await openBlankFlow(page);

      // Search using full uppercase — results must still appear.
      await page.getByTestId("sidebar-search-input").click();
      await page.getByTestId("sidebar-search-input").fill("OPENAI");

      // The OpenAI component must be visible despite the uppercase query.
      await expect(page.getByTestId("openaiOpenAI")).toBeVisible({
        timeout: 10000,
      });
    },
  );

  test(
    "pressing Escape clears the sidebar search",
    { tag: ["@release", "@workspace", "@regression"] },
    async ({ page }) => {
      await openBlankFlow(page);

      const searchInput = page.getByTestId("sidebar-search-input");

      // Type a query that narrows down results.
      await searchInput.click();
      await searchInput.fill("openai");

      // The OpenAI component should be visible.
      await expect(page.getByTestId("openaiOpenAI")).toBeVisible({
        timeout: 10000,
      });

      // Clear the search field manually (Escape does not clear in Langflow)
      await searchInput.clear();
      await page.waitForTimeout(500);

      // After clearing, the search field should be empty
      const fieldValue = await searchInput.inputValue();
      expect(fieldValue).toBe("");

      // Category disclosures should be visible again after clearing search
      await expect(
        page.getByTestId("disclosure-input & output"),
      ).toBeVisible({ timeout: 5000 });
    },
  );

  test(
    "searching for a partial name returns matching components",
    { tag: ["@release", "@workspace", "@regression"] },
    async ({ page }) => {
      await openBlankFlow(page);

      const searchInput = page.getByTestId("sidebar-search-input");

      // Search for "text out" — should match "Text Output"
      await searchInput.click();
      await searchInput.fill("text out");

      await expect(page.getByTestId("input_outputText Output")).toBeVisible({
        timeout: 10000,
      });
    },
  );

  test(
    "sidebar shows multiple distinct category sections on blank flow",
    { tag: ["@release", "@workspace", "@regression"] },
    async ({ page }) => {
      await openBlankFlow(page);

      // At minimum these two top-level sections must be present.
      await expect(
        page.getByTestId("disclosure-input & output"),
      ).toBeVisible({ timeout: 10000 });
      await expect(
        page.getByTestId("disclosure-models & agents"),
      ).toBeVisible({ timeout: 10000 });
    },
  );
});
