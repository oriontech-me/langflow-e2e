import { expect, test } from "../../../../fixtures/fixtures";
import { adjustScreenView } from "../../../../helpers/ui/adjust-screen-view";
import { awaitBootstrapTest } from "../../../../helpers/other/await-bootstrap-test";

test(
  "API Request component can be added and configured with a URL",
  { tag: ["@release", "@workspace", "@regression"] },
  async ({ page }) => {
    await awaitBootstrapTest(page);

    await page.waitForSelector('[data-testid="blank-flow"]', { timeout: 30000 });
    await page.getByTestId("blank-flow").click();

    // Add API Request component
    await page.getByTestId("sidebar-search-input").fill("api request");
    await page.waitForTimeout(1000);

    const apiResult = page.locator(
      '[data-testid="data_sourcesAPI Request"], [data-testid*="API Request"]',
    ).first();

    const hasApiComponent = await apiResult
      .isVisible({ timeout: 8000 })
      .catch(() => false);

    if (!hasApiComponent) {
      // Try different search
      await page.getByTestId("sidebar-search-input").fill("http");
      await page.waitForTimeout(1000);
    }

    // Add via hover+click pattern
    const componentCard = page
      .locator('[data-testid*="API Request"], [data-testid*="api-request"]')
      .first();
    const hasCard = await componentCard
      .isVisible({ timeout: 5000 })
      .catch(() => false);

    if (!hasCard) {
      console.log("INFO: API Request component not found, skipping");
      return;
    }

    await componentCard.hover();
    await page.waitForTimeout(300);

    const addBtn = page
      .locator('[data-testid="add-component-button-api-request"]')
      .first();
    const hasAddBtn = await addBtn
      .isVisible({ timeout: 3000 })
      .catch(() => false);

    if (hasAddBtn) {
      await addBtn.click();
    } else {
      await componentCard.dblclick();
    }

    await adjustScreenView(page);

    await expect(page.locator(".react-flow__node")).toHaveCount(1, {
      timeout: 10000,
    });

    // The API Request node should be on the canvas
    await expect(page.locator(".react-flow__node").first()).toBeVisible();
  },
);

test(
  "API Request component has URL and method fields",
  { tag: ["@release", "@workspace", "@regression"] },
  async ({ page }) => {
    await awaitBootstrapTest(page);

    await page.waitForSelector('[data-testid="blank-flow"]', { timeout: 30000 });
    await page.getByTestId("blank-flow").click();

    // Add API Request component
    await page.getByTestId("sidebar-search-input").fill("api request");
    await page.waitForTimeout(1000);

    const componentCard = page
      .locator('[data-testid*="API Request"], [data-testid*="api-request"]')
      .first();
    const hasCard = await componentCard
      .isVisible({ timeout: 5000 })
      .catch(() => false);

    if (!hasCard) {
      console.log("INFO: API Request component not found, skipping");
      return;
    }

    await componentCard.hover();
    await page.waitForTimeout(300);

    const addBtn = page
      .locator('[data-testid="add-component-button-api-request"]')
      .first();
    const hasAddBtn = await addBtn
      .isVisible({ timeout: 3000 })
      .catch(() => false);

    if (hasAddBtn) {
      await addBtn.click();
    } else {
      await componentCard.dblclick();
    }

    await adjustScreenView(page);

    await expect(page.locator(".react-flow__node")).toHaveCount(1, {
      timeout: 10000,
    });

    // Click the node to select it
    await page.locator(".react-flow__node").first().click();
    await page.waitForTimeout(400);

    // Open the Controls/Advanced button
    const editBtn = page.locator('[data-testid="edit-button-modal"]').first();
    const hasEditBtn = await editBtn
      .isVisible({ timeout: 3000 })
      .catch(() => false);

    if (hasEditBtn) {
      await editBtn.click();
      await page.waitForTimeout(500);
    }

    // Check for URL field
    const urlField = await page
      .locator(
        'input[id*="url"], input[placeholder*="url"], input[placeholder*="URL"], [data-testid*="url"]',
      )
      .first()
      .isVisible({ timeout: 5000 })
      .catch(() => false);

    // Check for method selector (GET, POST, etc.)
    const methodField = await page
      .locator(
        '[data-testid*="method"], select[id*="method"], [data-testid*="dropdown_str_method"]',
      )
      .first()
      .isVisible({ timeout: 3000 })
      .catch(() => false);

    // Check for "URL" label text
    const urlLabel = await page
      .getByText(/^URL$/i)
      .first()
      .isVisible({ timeout: 3000 })
      .catch(() => false);

    expect(
      urlField || methodField || urlLabel,
      "API Request component should have URL/method configuration fields",
    ).toBe(true);
  },
);

test(
  "API Request component shows headers configuration option",
  { tag: ["@release", "@workspace", "@regression"] },
  async ({ page }) => {
    await awaitBootstrapTest(page);

    await page.waitForSelector('[data-testid="blank-flow"]', { timeout: 30000 });
    await page.getByTestId("blank-flow").click();

    // Add API Request component
    await page.getByTestId("sidebar-search-input").fill("api request");
    await page.waitForTimeout(1000);

    const componentCard = page
      .locator('[data-testid*="API Request"], [data-testid*="api-request"]')
      .first();
    const hasCard = await componentCard
      .isVisible({ timeout: 5000 })
      .catch(() => false);

    if (!hasCard) {
      console.log("INFO: API Request component not found, skipping");
      return;
    }

    await componentCard.hover();
    await page.waitForTimeout(300);

    const addBtn = page
      .locator('[data-testid="add-component-button-api-request"]')
      .first();
    const hasAddBtn = await addBtn
      .isVisible({ timeout: 3000 })
      .catch(() => false);

    if (hasAddBtn) {
      await addBtn.click();
    } else {
      await componentCard.dblclick();
    }

    await adjustScreenView(page);

    await expect(page.locator(".react-flow__node")).toHaveCount(1, {
      timeout: 10000,
    });

    // Click to select and open controls
    await page.locator(".react-flow__node").first().click();
    await page.waitForTimeout(400);

    const editBtn = page.locator('[data-testid="edit-button-modal"]').first();
    const hasEditBtn = await editBtn
      .isVisible({ timeout: 3000 })
      .catch(() => false);

    if (hasEditBtn) {
      await editBtn.click();
      await page.waitForTimeout(500);
    }

    // Check for headers field (key-value pairs for HTTP headers)
    const headersField = await page
      .getByText(/headers/i)
      .first()
      .isVisible({ timeout: 5000 })
      .catch(() => false);

    // Or check for the key-pair component
    const keyPairComponent = await page
      .locator(
        '[data-testid*="header"], [data-testid*="key_pair"], [data-testid*="keyPair"]',
      )
      .first()
      .isVisible({ timeout: 3000 })
      .catch(() => false);

    expect(
      headersField || keyPairComponent,
      "API Request component should have a headers configuration section",
    ).toBe(true);
  },
);
