import { expect, test } from "../../../../fixtures/fixtures";
import { adjustScreenView } from "../../../../helpers/ui/adjust-screen-view";
import { awaitBootstrapTest } from "../../../../helpers/other/await-bootstrap-test";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";

test(
  "user should be able to select flows with different methods and perform bulk actions",
  { tag: ["@stable", "@release", "@workspace", "@mainpage", "@regression"] },
  async ({ page, request }) => {
    await awaitBootstrapTest(page);

    // Track the IDs of the 3 flows we create so cleanup can delete ONLY
    // those via the API, not sibling specs' flows. Bulk-delete via UI on
    // first→last list-card would nuke any flow created by another worker
    // under `fullyParallel`.
    const createdFlowIds: string[] = [];
    const captureFlowIdFromUrl = async () => {
      // `waitForURL` enforces the URL matches the regex — once it returns,
      // the subsequent `match()` is guaranteed to succeed, so the non-null
      // assertion is safe and lets the rule against test-side conditionals
      // stay clean.
      await page.waitForURL(/\/flow\/[0-9a-f-]+/i, { timeout: 15000 });
      const id = page.url().match(/\/flow\/([0-9a-f-]+)/i)![1];
      createdFlowIds.push(id);
    };

    try {
      // Add some flows to test with
      await page.getByTestId("side_nav_options_all-templates").click();
      await page.getByRole("heading", { name: "Basic Prompting" }).click();
      await captureFlowIdFromUrl();
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
      await captureFlowIdFromUrl();
      await page.waitForSelector('[data-testid="sidebar-search-input"]', {
        timeout: 30000,
      });
      await page.getByTestId("icon-ChevronLeft").first().click();

      await expect(page.getByText("Projects").first()).toBeVisible({ timeout: 10000 });
      await page.getByTestId("new-project-btn").click();
      await page.getByTestId("side_nav_options_all-templates").click();
      await page.getByRole("heading", { name: "Basic Prompting" }).click();
      await captureFlowIdFromUrl();
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

      // Verify all 3 flows are selected (shift-click range)
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

      // Verify all 3 flows are deselected
      await expect(firstCheckbox).not.toBeChecked();
      await expect(secondCheckbox).not.toBeChecked();
      await expect(thirdCheckbox).not.toBeChecked();

      // Test Ctrl/Cmd selection — clicks 1 and 3 only, so the 2nd should
      // remain unchecked (this is what proves Ctrl-click is per-item, not
      // range-based).
      await page.keyboard.down("ControlOrMeta");
      await page.getByTestId("list-card").first().click();
      await page.getByTestId("list-card").nth(2).click();
      await page.keyboard.up("ControlOrMeta");

      // Verify 1st and 3rd selected, 2nd skipped
      await expect(firstCheckbox).toBeChecked();
      await expect(secondCheckbox).not.toBeChecked();
      await expect(thirdCheckbox).toBeChecked();

      // Capture flow names from the list cards for the post-bulk-delete
      // hidden/visible assertions. Assert each span has non-empty text
      // BEFORE reading textContent — if the span hasn't rendered yet, the
      // captured name would be "" and `getByText("", { exact: true })` would
      // pass vacuously, letting a real regression slip through.
      const firstNameLoc = page
        .locator("[data-testid='flow-name-div']")
        .first()
        .locator("span");
      const secondNameLoc = page
        .locator("[data-testid='flow-name-div']")
        .nth(1)
        .locator("span");
      const thirdNameLoc = page
        .locator("[data-testid='flow-name-div']")
        .nth(2)
        .locator("span");
      await expect(firstNameLoc).toHaveText(/.+/);
      await expect(secondNameLoc).toHaveText(/.+/);
      await expect(thirdNameLoc).toHaveText(/.+/);
      const firstFlowName = (await firstNameLoc.textContent())!.trim();
      const secondFlowName = (await secondNameLoc.textContent())!.trim();
      const thirdFlowName = (await thirdNameLoc.textContent())!.trim();

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
      // API-based cleanup scoped to the IDs we captured during creation.
      // Parallelism-safe: a previous UI-driven cleanup did a Shift-click
      // first→last bulk-delete on the entire listing, which would nuke any
      // flow concurrently created by sibling specs under `fullyParallel`.
      // Iterating known IDs avoids that whole class of cross-worker damage.
      // 404s on IDs already deleted by the test (the 2 bulk-deleted flows
      // when the test reaches its happy path) are expected and ignored.
      try {
        const headers = { Authorization: await getAuthToken(request) };
        for (const id of createdFlowIds) {
          try {
            await request.delete(`/api/v1/flows/${id}`, { headers });
          } catch {
            // Best-effort per-flow — do not mask the original test failure.
          }
        }
      } catch {
        // Cleanup is best-effort — do not mask the original test failure.
      }
    }
  },
);
