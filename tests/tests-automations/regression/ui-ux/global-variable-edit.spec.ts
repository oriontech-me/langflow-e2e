import type { Page } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";

// Deletes a global variable by name via the REST API, so each test cleans up
// after itself even if a UI assertion fails mid-way. Listing + matching by
// name is robust to ag-grid re-renders and the `Date.now()`-based naming
// makes collisions across parallel runs impossible.
async function deleteVariableByName(page: Page, name: string): Promise<void> {
  const authToken = await getAuthToken(page.request);
  const list = await page.request.get("/api/v1/variables/", {
    headers: authToken ? { Authorization: authToken } : {},
  });
  if (list.status() !== 200) return;
  const items = (await list.json()) as Array<{ id: string; name: string }>;
  const target = items.find((v) => v.name === name);
  if (!target) return;
  await page.request.delete(`/api/v1/variables/${target.id}`, {
    headers: authToken ? { Authorization: authToken } : {},
  });
}

test.describe("Global Variable Edit (Settings page)", () => {
  let createdVarName: string | null = null;

  test.afterEach(async ({ page }) => {
    if (createdVarName) {
      await deleteVariableByName(page, createdVarName).catch(() => {});
      createdVarName = null;
    }
  });

  test(
    "create a Generic global variable from Settings page",
    { tag: ["@stable", "@release", "@workspace", "@regression"] },
    async ({ page }) => {
      createdVarName = `test_create_var_${Date.now()}`;

      await test.step("Navigate to /settings/global-variables", async () => {
        await awaitBootstrapTest(page, { skipModal: true });
        await page.goto("/settings/global-variables");
        await expect(page.getByTestId("settings_menu_header")).toBeVisible({
          timeout: 30000,
        });
      });

      await test.step("Open Add New modal on Generic tab", async () => {
        await page.getByTestId("api-key-button-store").click();
        await expect(page.getByTestId("generic-tab")).toBeVisible({
          timeout: 5000,
        });
        await page.getByTestId("generic-tab").click();
      });

      await test.step("Fill name and value and click Save", async () => {
        await page
          .getByPlaceholder("Enter a name for the variable...")
          .fill(createdVarName!);
        await page
          .getByPlaceholder("Enter a value for the variable...")
          .fill("original_value");
        await page.getByTestId("save-variable-btn").click();
      });

      await test.step("Variable appears in the ag-grid table", async () => {
        await expect(
          page
            .locator(".ag-cell-value")
            .getByText(createdVarName!, { exact: true }),
        ).toBeVisible({ timeout: 10000 });
      });
    },
  );

  test(
    "edit existing global variable by clicking its row",
    { tag: ["@stable", "@release", "@workspace", "@regression"] },
    async ({ page }) => {
      createdVarName = `test_edit_var_${Date.now()}`;

      await test.step("Navigate to /settings/global-variables and create a variable", async () => {
        await awaitBootstrapTest(page, { skipModal: true });
        await page.goto("/settings/global-variables");
        await expect(page.getByTestId("settings_menu_header")).toBeVisible({
          timeout: 30000,
        });

        await page.getByTestId("api-key-button-store").click();
        await expect(page.getByTestId("generic-tab")).toBeVisible({
          timeout: 5000,
        });
        await page.getByTestId("generic-tab").click();
        await page
          .getByPlaceholder("Enter a name for the variable...")
          .fill(createdVarName!);
        await page
          .getByPlaceholder("Enter a value for the variable...")
          .fill("original_value");
        await page.getByTestId("save-variable-btn").click();

        await expect(
          page
            .locator(".ag-cell-value")
            .getByText(createdVarName!, { exact: true }),
        ).toBeVisible({ timeout: 10000 });
      });

      await test.step("Click the variable row to open Update Variable modal", async () => {
        await page
          .locator(".ag-cell-value")
          .getByText(createdVarName!, { exact: true })
          .click();
        await expect(
          page.getByRole("heading", { name: "Update Variable" }),
        ).toBeVisible({ timeout: 5000 });
      });

      await test.step("Fill a new value and click Save", async () => {
        await page
          .getByPlaceholder("Enter a value for the variable...")
          .fill("updated_value");
        await page.getByTestId("save-variable-btn").click();
      });

      await test.step("Success toast confirms the update", async () => {
        await expect(page.getByText(/updated successfully/)).toBeVisible({
          timeout: 5000,
        });
      });
    },
  );
});
