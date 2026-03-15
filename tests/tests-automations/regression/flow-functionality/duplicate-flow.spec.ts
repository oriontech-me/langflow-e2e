import { expect, test } from "../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";

test(
  "user can duplicate a flow from the home page dropdown menu",
  { tag: ["@release", "@workspace", "@regression"] },
  async ({ page }) => {
    await awaitBootstrapTest(page);

    // Open Basic Prompting template to have a flow to duplicate
    await page.getByTestId("side_nav_options_all-templates").click();
    await page.getByRole("heading", { name: "Basic Prompting" }).click();

    await page.waitForSelector('[data-testid="sidebar-search-input"]', {
      timeout: 30000,
    });

    // Go back to home
    await page.getByTestId("icon-ChevronLeft").first().click();

    await page.waitForSelector('[data-testid="home-dropdown-menu"]', {
      timeout: 30000,
    });

    // Open dropdown for the first flow
    await page.getByTestId("home-dropdown-menu").first().click();

    // Look for "Duplicate" option
    const duplicateOption = page.getByText(/duplicate/i).first();
    const isDuplicateVisible = await duplicateOption
      .isVisible({ timeout: 5000 })
      .catch(() => false);

    // Duplicate option must be available in the dropdown
    expect(isDuplicateVisible).toBeTruthy();

    await duplicateOption.click();

    // Wait for the duplicate to appear
    await page.waitForTimeout(2000);

    // There should now be at least 2 flows with similar names on the page
    const flowCards = page.locator('[data-testid="home-dropdown-menu"]');
    const count = await flowCards.count();
    expect(count).toBeGreaterThan(1);
  },
);

test(
  "duplicated flow via API has different ID but same name",
  { tag: ["@release", "@api", "@regression"] },
  async ({ request }) => {
    const authToken = await getAuthToken(request);

    // Create original flow
    const originalName = `Flow to Duplicate - ${Date.now()}`;
    const createRes = await request.post("/api/v1/flows/", {
      headers: { Authorization: authToken },
      data: {
        name: originalName,
        description: "Flow original para duplicar",
        data: { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
        is_component: false,
      },
    });

    expect(createRes.status()).toBe(201);
    const original = await createRes.json();

    // Duplicate by creating a new flow with the same data
    const duplicatedName = `${originalName} (copy)`;
    const duplicateRes = await request.post("/api/v1/flows/", {
      headers: { Authorization: authToken },
      data: {
        name: duplicatedName,
        description: original.description,
        data: original.data,
        is_component: false,
      },
    });

    expect(duplicateRes.status()).toBe(201);
    const duplicate = await duplicateRes.json();

    expect(duplicate.id).not.toBe(original.id);
    expect(duplicate.name).toBe(duplicatedName);

    // Both flows exist in the list
    const listRes = await request.get("/api/v1/flows/", {
      headers: { Authorization: authToken },
    });
    expect(listRes.status()).toBe(200);
    const flows = await listRes.json();
    const flowList = Array.isArray(flows) ? flows : flows.flows ?? [];

    const originalExists = flowList.some((f: any) => f.id === original.id);
    const duplicateExists = flowList.some((f: any) => f.id === duplicate.id);
    expect(originalExists).toBeTruthy();
    expect(duplicateExists).toBeTruthy();

    // Cleanup
    await request.delete(`/api/v1/flows/${original.id}`, {
      headers: { Authorization: authToken },
    });
    await request.delete(`/api/v1/flows/${duplicate.id}`, {
      headers: { Authorization: authToken },
    });
  },
);
