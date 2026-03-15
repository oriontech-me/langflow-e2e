import { expect, test } from "../../../fixtures/fixtures";
import { adjustScreenView } from "../../../helpers/ui/adjust-screen-view";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";

test(
  "clicking empty canvas area deselects a selected node",
  { tag: ["@release", "@workspace", "@regression"] },
  async ({ page }) => {
    await awaitBootstrapTest(page);

    await page.waitForSelector('[data-testid="blank-flow"]', { timeout: 30000 });
    await page.getByTestId("blank-flow").click();

    // Add a component to the canvas
    await page.getByTestId("sidebar-search-input").fill("chat input");
    await page.waitForSelector('[data-testid="input_outputChat Input"]', {
      timeout: 30000,
    });
    await page
      .getByTestId("input_outputChat Input")
      .hover()
      .then(async () => {
        await page.getByTestId("add-component-button-chat-input").click();
      });

    await adjustScreenView(page);
    await expect(page.locator(".react-flow__node")).toHaveCount(1, {
      timeout: 10000,
    });

    // Click the node to select it
    await page.locator(".react-flow__node").first().click();
    await page.waitForTimeout(300);

    // Node must be in selected state
    await expect(page.locator(".react-flow__node.selected")).toHaveCount(1, {
      timeout: 3000,
    });

    // Click an empty area of the canvas to deselect
    await page.locator('//*[@id="react-flow-id"]').click({
      position: { x: 50, y: 450 },
    });
    await page.waitForTimeout(300);

    // Node must no longer be selected
    await expect(page.locator(".react-flow__node.selected")).toHaveCount(0, {
      timeout: 3000,
    });
  },
);

test(
  "pressing Escape deselects a selected node",
  { tag: ["@release", "@workspace", "@regression"] },
  async ({ page }) => {
    await awaitBootstrapTest(page);

    await page.waitForSelector('[data-testid="blank-flow"]', { timeout: 30000 });
    await page.getByTestId("blank-flow").click();

    // Add a component
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

    // Select the node
    await page.locator(".react-flow__node").first().click();
    await page.waitForTimeout(300);
    await expect(page.locator(".react-flow__node.selected")).toHaveCount(1, {
      timeout: 3000,
    });

    // Press Escape to deselect
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    // Node must no longer be selected
    await expect(page.locator(".react-flow__node.selected")).toHaveCount(0, {
      timeout: 3000,
    });
  },
);
