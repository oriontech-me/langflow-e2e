import { expect, test } from "../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";

async function navigateToGlobalVariables(page: any) {
  await page.getByTestId("user-profile-settings").click();
  await page.getByTestId("menu_settings_button").click();
  await page.waitForSelector('[data-testid="settings_menu_header"]', {
    timeout: 10000,
  });
  // Navigate to Global Variables specifically
  await page.goto("/settings/global-variables");
  await page.waitForSelector('[data-testid="settings_menu_header"]', {
    timeout: 10000,
  });
}

test.describe("Global Variable Edit", () => {
  test(
    "create a Generic global variable from Settings page",
    { tag: ["@release", "@workspace", "@regression"] },
    async ({ page }) => {
      await awaitBootstrapTest(page, { skipModal: true });

      await page.goto("/settings/global-variables");
      await page.waitForSelector('[data-testid="settings_menu_header"]', {
        timeout: 30000,
      });

      const varName = `test_edit_var_${Date.now()}`;

      // Click "Add New" button
      await page.getByTestId("api-key-button-store").click();
      await page.waitForTimeout(500);

      // Switch to Generic type
      await page.getByTestId("generic-tab").click();

      // Fill in variable name
      await page
        .getByPlaceholder("Enter a name for the variable...")
        .fill(varName);

      // Fill in variable value
      await page
        .getByPlaceholder("Enter a value for the variable...")
        .fill("original_value");

      // Save the variable
      await page.getByTestId("save-variable-btn").click();
      await page.waitForTimeout(1000);

      // Variable should be visible in the table (use ag-grid cell selector to be specific)
      await expect(
        page.locator(".ag-cell-value").getByText(varName, { exact: true }),
      ).toBeVisible({ timeout: 10000 });
    },
  );

  test(
    "edit existing global variable by clicking its row",
    { tag: ["@release", "@workspace", "@regression"] },
    async ({ page }) => {
      await awaitBootstrapTest(page, { skipModal: true });

      await page.goto("/settings/global-variables");
      await page.waitForSelector('[data-testid="settings_menu_header"]', {
        timeout: 30000,
      });

      const varName = `test_edit_var_${Date.now()}`;

      // Create a variable first
      await page.getByTestId("api-key-button-store").click();
      await page.waitForTimeout(500);

      await page.getByTestId("generic-tab").click();

      await page
        .getByPlaceholder("Enter a name for the variable...")
        .fill(varName);

      await page
        .getByPlaceholder("Enter a value for the variable...")
        .fill("original_value");

      await page.getByTestId("save-variable-btn").click();
      await page.waitForTimeout(1000);

      // Variable should be visible in the table (use ag-grid cell to avoid strict mode)
      const cellLocator = page
        .locator(".ag-cell-value")
        .getByText(varName, { exact: true });
      await expect(cellLocator).toBeVisible({ timeout: 10000 });

      // Click on the variable row to open the edit modal
      await cellLocator.click();
      await page.waitForTimeout(500);

      // Edit modal should open - it shows "Update Variable" heading
      await expect(
        page.getByRole("heading", { name: "Update Variable" }),
      ).toBeVisible({ timeout: 5000 });

      // Clear the value field and type new value
      const valueInput = page.getByPlaceholder(
        "Enter a value for the variable...",
      );
      await valueInput.fill("updated_value");

      // Save the updated variable
      await page.getByTestId("save-variable-btn").click();
      await page.waitForTimeout(1000);

      // Should show success message
      await expect(
        page.getByText(/updated successfully/),
      ).toBeVisible({ timeout: 5000 });
    },
  );

  test(
    "Global Variables settings page shows correct header",
    { tag: ["@release", "@workspace", "@regression"] },
    async ({ page }) => {
      await awaitBootstrapTest(page, { skipModal: true });

      await page.goto("/settings/global-variables");
      await page.waitForSelector('[data-testid="settings_menu_header"]', {
        timeout: 30000,
      });

      await expect(page.getByTestId("settings_menu_header")).toContainText(
        "Global Variables",
      );
    },
  );

  test(
    "Add New Variable button opens creation modal with type tabs",
    { tag: ["@release", "@workspace", "@regression"] },
    async ({ page }) => {
      await awaitBootstrapTest(page, { skipModal: true });

      await page.goto("/settings/global-variables");
      await page.waitForSelector('[data-testid="settings_menu_header"]', {
        timeout: 30000,
      });

      // Click the Add New button
      await page.getByTestId("api-key-button-store").click();
      await page.waitForTimeout(500);

      // Modal should show with Credential and Generic tabs
      await expect(page.getByTestId("credential-tab")).toBeVisible({
        timeout: 5000,
      });
      await expect(page.getByTestId("generic-tab")).toBeVisible({
        timeout: 5000,
      });

      // Modal header should say "Create Variable"
      await expect(
        page.getByText("Create Variable", { exact: true }),
      ).toBeVisible({ timeout: 5000 });
    },
  );
});
