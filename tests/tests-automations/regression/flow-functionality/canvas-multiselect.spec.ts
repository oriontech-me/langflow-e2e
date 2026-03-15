import { expect, test } from "../../../fixtures/fixtures";
import { adjustScreenView } from "../../../helpers/ui/adjust-screen-view";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";
import { zoomOut } from "../../../helpers/ui/zoom-out";

test(
  "box selection (shift+drag) selects multiple components",
  { tag: ["@release", "@workspace", "@regression"] },
  async ({ page }) => {
    await awaitBootstrapTest(page);

    await page.waitForSelector('[data-testid="blank-flow"]', { timeout: 30000 });
    await page.getByTestId("blank-flow").click();

    // Add ChatOutput (first component via hover+click)
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

    await zoomOut(page, 2);

    // Add ChatInput (second component via dragTo)
    await page.getByTestId("sidebar-search-input").fill("chat input");
    await page.waitForSelector('[data-testid="input_outputChat Input"]', {
      timeout: 30000,
    });
    await page
      .getByTestId("input_outputChat Input")
      .dragTo(page.locator('//*[@id="react-flow-id"]'), {
        targetPosition: { x: 100, y: 100 },
      });

    await adjustScreenView(page);
    await expect(page.locator(".react-flow__node")).toHaveCount(2, {
      timeout: 10000,
    });

    // Get bounding boxes of both nodes
    const nodes = page.locator(".react-flow__node");
    const firstBox = await nodes.first().boundingBox();
    const secondBox = await nodes.nth(1).boundingBox();

    if (firstBox && secondBox) {
      // Calculate selection rectangle that encompasses both nodes
      const startX = Math.min(firstBox.x, secondBox.x) - 30;
      const startY = Math.min(firstBox.y, secondBox.y) - 30;
      const endX =
        Math.max(
          firstBox.x + firstBox.width,
          secondBox.x + secondBox.width,
        ) + 30;
      const endY =
        Math.max(
          firstBox.y + firstBox.height,
          secondBox.y + secondBox.height,
        ) + 30;

      // Box selection via Shift+drag on the canvas
      await page.keyboard.down("Shift");
      await page.mouse.move(startX, startY);
      await page.mouse.down();
      await page.mouse.move(endX, endY, { steps: 10 });
      await page.mouse.up();
      await page.keyboard.up("Shift");
      await page.waitForTimeout(500);
    }

    // Both nodes should be selected (selection box visible or nodes have selected state)
    // Verify by checking that Ctrl+C copies both nodes (lastCopiedSelection has 2 nodes)
    await page.keyboard.press("Control+c");
    await page.waitForTimeout(300);

    // Click empty canvas area for paste
    await page.locator('//*[@id="react-flow-id"]').click({
      position: { x: 50, y: 400 },
    });
    await page.waitForTimeout(300);

    await page.keyboard.press("Control+v");
    await page.waitForTimeout(1500);

    // After pasting the multi-selection, should have exactly 4 nodes (2 original + 2 pasted)
    await expect(page.locator(".react-flow__node")).toHaveCount(4, {
      timeout: 5000,
    });
  },
);

test(
  "box-selecting all nodes and deleting clears the canvas",
  { tag: ["@release", "@workspace", "@regression"] },
  async ({ page }) => {
    await awaitBootstrapTest(page);

    await page.waitForSelector('[data-testid="blank-flow"]', { timeout: 30000 });
    await page.getByTestId("blank-flow").click();

    // Add two components
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

    await zoomOut(page, 2);

    await page.getByTestId("sidebar-search-input").fill("chat input");
    await page.waitForSelector('[data-testid="input_outputChat Input"]', {
      timeout: 30000,
    });
    await page
      .getByTestId("input_outputChat Input")
      .dragTo(page.locator('//*[@id="react-flow-id"]'), {
        targetPosition: { x: 100, y: 100 },
      });

    await adjustScreenView(page);
    await expect(page.locator(".react-flow__node")).toHaveCount(2, {
      timeout: 10000,
    });

    // Box-select all nodes via Shift+drag from corner to corner
    const nodes = page.locator(".react-flow__node");
    const firstBox = await nodes.first().boundingBox();
    const secondBox = await nodes.nth(1).boundingBox();

    if (firstBox && secondBox) {
      const startX = Math.min(firstBox.x, secondBox.x) - 30;
      const startY = Math.min(firstBox.y, secondBox.y) - 30;
      const endX =
        Math.max(firstBox.x + firstBox.width, secondBox.x + secondBox.width) +
        30;
      const endY =
        Math.max(
          firstBox.y + firstBox.height,
          secondBox.y + secondBox.height,
        ) + 30;

      await page.keyboard.down("Shift");
      await page.mouse.move(startX, startY);
      await page.mouse.down();
      await page.mouse.move(endX, endY, { steps: 10 });
      await page.mouse.up();
      await page.keyboard.up("Shift");
      await page.waitForTimeout(500);
    }

    // Delete selected nodes
    await page.keyboard.press("Delete");
    await page.waitForTimeout(1000);

    // Canvas must be completely empty after deleting all selected nodes
    await expect(page.locator(".react-flow__node")).toHaveCount(0, {
      timeout: 5000,
    });
  },
);
