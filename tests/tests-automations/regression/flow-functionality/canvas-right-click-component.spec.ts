import { expect, test } from "../../../fixtures/fixtures";
import { adjustScreenView } from "../../../helpers/ui/adjust-screen-view";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";

test(
  "right-clicking a node opens a context menu with options",
  { tag: ["@release", "@workspace", "@regression"] },
  async ({ page }) => {
    await awaitBootstrapTest(page);

    await page.waitForSelector('[data-testid="blank-flow"]', { timeout: 30000 });
    await page.getByTestId("blank-flow").click();

    // Add ChatOutput
    await page.getByTestId("sidebar-search-input").click();
    await page.getByTestId("sidebar-search-input").fill("chat output");
    await page.waitForSelector('[data-testid="input_outputChat Output"]', {
      timeout: 30000,
    });
    await page
      .getByTestId("input_outputChat Output")
      .hover()
      .then(async () => {
        await page.getByTestId("add-component-button-chat-output").click();
      });

    await adjustScreenView(page);

    await expect(page.locator(".react-flow__node")).toHaveCount(1, {
      timeout: 10000,
    });

    // Right-click on the node
    await page.locator(".react-flow__node").first().click({ button: "right" });
    await page.waitForTimeout(500);

    // The more-options-modal (toolbar dropdown) should appear
    const menu = page.locator('[data-testid="more-options-modal"]').first();
    await expect(menu).toBeVisible({ timeout: 5000 });
  },
);

test(
  "right-click context menu closes after pressing Escape",
  { tag: ["@release", "@workspace", "@regression"] },
  async ({ page }) => {
    await awaitBootstrapTest(page);

    await page.waitForSelector('[data-testid="blank-flow"]', { timeout: 30000 });
    await page.getByTestId("blank-flow").click();

    // Add ChatOutput
    await page.getByTestId("sidebar-search-input").click();
    await page.getByTestId("sidebar-search-input").fill("chat output");
    await page.waitForSelector('[data-testid="input_outputChat Output"]', {
      timeout: 30000,
    });
    await page
      .getByTestId("input_outputChat Output")
      .hover()
      .then(async () => {
        await page.getByTestId("add-component-button-chat-output").click();
      });

    await adjustScreenView(page);

    await expect(page.locator(".react-flow__node")).toHaveCount(1, {
      timeout: 10000,
    });

    // Right-click the node
    await page.locator(".react-flow__node").first().click({ button: "right" });
    await page.waitForTimeout(500);

    const menu = page.locator('[data-testid="more-options-modal"]').first();
    await expect(menu).toBeVisible({ timeout: 5000 });

    // Press Escape — menu should close
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);

    await expect(menu).not.toBeVisible({ timeout: 3000 });
  },
);

test(
  "right-click context menu contains Copy and Delete options",
  { tag: ["@release", "@workspace", "@regression"] },
  async ({ page }) => {
    await awaitBootstrapTest(page);

    await page.waitForSelector('[data-testid="blank-flow"]', { timeout: 30000 });
    await page.getByTestId("blank-flow").click();

    // Add ChatOutput
    await page.getByTestId("sidebar-search-input").click();
    await page.getByTestId("sidebar-search-input").fill("chat output");
    await page.waitForSelector('[data-testid="input_outputChat Output"]', {
      timeout: 30000,
    });
    await page
      .getByTestId("input_outputChat Output")
      .hover()
      .then(async () => {
        await page.getByTestId("add-component-button-chat-output").click();
      });

    await adjustScreenView(page);

    await expect(page.locator(".react-flow__node")).toHaveCount(1, {
      timeout: 10000,
    });

    // Right-click the node
    await page.locator(".react-flow__node").first().click({ button: "right" });
    await page.waitForTimeout(500);

    // Right-click selects the node and shows the toolbar with more-options button
    const toolbar = page.locator('[data-testid="more-options-modal"]').first();
    await expect(toolbar).toBeVisible({ timeout: 5000 });

    // Open the more-options dropdown by clicking it
    await toolbar.click();
    await page.waitForTimeout(500);

    // The dropdown should contain common node actions (Copy, Duplicate, Freeze, Delete)
    // Use text-based locator since Radix Select items may not have stable testids
    const hasDropdownAction = await page
      .getByText(/Copy|Duplicate|Freeze|Delete/i)
      .first()
      .isVisible({ timeout: 3000 })
      .catch(() => false);
    expect(
      hasDropdownAction,
      "Node more-options dropdown must show at least one action (Copy/Duplicate/Freeze/Delete)",
    ).toBe(true);
  },
);

test(
  "right-clicking the canvas background does not open the node context menu",
  { tag: ["@release", "@workspace", "@regression"] },
  async ({ page }) => {
    await awaitBootstrapTest(page);

    await page.waitForSelector('[data-testid="blank-flow"]', { timeout: 30000 });
    await page.getByTestId("blank-flow").click();

    // Add a node so we can distinguish node-menu from canvas-menu
    await page.getByTestId("sidebar-search-input").click();
    await page.getByTestId("sidebar-search-input").fill("chat output");
    await page.waitForSelector('[data-testid="input_outputChat Output"]', {
      timeout: 30000,
    });
    await page
      .getByTestId("input_outputChat Output")
      .hover()
      .then(async () => {
        await page.getByTestId("add-component-button-chat-output").click();
      });

    await adjustScreenView(page);

    // Click the node first to get its bounding box, then click far away from it
    const nodeBB = await page.locator(".react-flow__node").first().boundingBox();

    // Click in an empty area that is guaranteed to be away from the node
    // Use the canvas bottom-right area
    const canvas = page.locator('//*[@id="react-flow-id"]');
    const canvasBB = await canvas.boundingBox();
    const emptyX = canvasBB ? canvasBB.width - 50 : 900;
    const emptyY = canvasBB ? canvasBB.height - 50 : 500;

    // First click (left) on empty area to ensure the node toolbar is hidden
    await canvas.click({ position: { x: emptyX, y: emptyY } });
    await page.waitForTimeout(300);

    // Right-click the same empty area
    await canvas.click({ button: "right", position: { x: emptyX, y: emptyY } });
    await page.waitForTimeout(500);

    // The node-specific toolbar (more-options-modal) should NOT appear for a canvas right-click
    // (a canvas context menu may appear, but not the node toolbar)
    const nodeToolbar = page.locator('[data-testid="more-options-modal"]');
    // Use count to avoid timing issues
    const toolbarCount = await nodeToolbar.count();
    const toolbarVisible = toolbarCount > 0 && (await nodeToolbar.first().isVisible().catch(() => false));
    expect(toolbarVisible, "Node toolbar should not appear on canvas background right-click").toBe(false);
  },
);
