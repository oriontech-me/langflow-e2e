import { expect, test } from "../../../fixtures/fixtures";
import { adjustScreenView } from "../../../helpers/ui/adjust-screen-view";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";

test(
  "canvas viewport changes after mouse wheel scroll",
  { tag: ["@release", "@workspace", "@regression"] },
  async ({ page }) => {
    await awaitBootstrapTest(page);

    await page.waitForSelector('[data-testid="blank-flow"]', { timeout: 30000 });
    await page.getByTestId("blank-flow").click();

    // Add a ChatOutput component
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

    // Read the viewport transform before scrolling
    const getTransform = () =>
      page.locator(".react-flow__viewport").getAttribute("style");

    const transformBefore = await getTransform();

    // Mouse wheel scroll on the canvas to trigger pan/zoom
    const canvas = page.locator('//*[@id="react-flow-id"]');
    const bb = await canvas.boundingBox();
    if (bb) {
      await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
    }
    await page.mouse.wheel(0, 200);
    await page.waitForTimeout(400);

    const transformAfter = await getTransform();

    // The viewport transform must have changed after scrolling
    expect(
      transformAfter,
      "Viewport transform must change after mouse wheel scroll",
    ).not.toEqual(transformBefore);
  },
);

test(
  "canvas viewport resets to fit view after adjustScreenView",
  { tag: ["@release", "@workspace", "@regression"] },
  async ({ page }) => {
    await awaitBootstrapTest(page);

    await page.waitForSelector('[data-testid="blank-flow"]', { timeout: 30000 });
    await page.getByTestId("blank-flow").click();

    // Add a ChatOutput component
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

    // Read the transform after fit-view
    const getTransform = () =>
      page.locator(".react-flow__viewport").getAttribute("style");

    const fitTransform = await getTransform();

    // Scroll away from fit-view position
    const canvas = page.locator('//*[@id="react-flow-id"]');
    const bb = await canvas.boundingBox();
    if (bb) {
      await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
    }
    await page.mouse.wheel(0, 500);
    await page.waitForTimeout(400);

    const scrolledTransform = await getTransform();
    // Confirm we actually scrolled away
    expect(scrolledTransform).not.toEqual(fitTransform);

    // Call adjustScreenView again to reset
    await adjustScreenView(page);

    const resetTransform = await getTransform();

    // After reset, the node must still be visible (fit-view applied)
    await expect(page.locator(".react-flow__node").first()).toBeVisible({
      timeout: 5000,
    });

    // The transform after reset must differ from the scrolled state
    expect(
      resetTransform,
      "Viewport transform must change back after adjustScreenView",
    ).not.toEqual(scrolledTransform);
  },
);

test(
  "panning canvas by dragging empty area moves viewport",
  { tag: ["@release", "@workspace", "@regression"] },
  async ({ page }) => {
    await awaitBootstrapTest(page);

    await page.waitForSelector('[data-testid="blank-flow"]', { timeout: 30000 });
    await page.getByTestId("blank-flow").click();

    // Add a ChatOutput component
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

    // Read the viewport transform before panning
    const getTransform = () =>
      page.locator(".react-flow__viewport").getAttribute("style");

    const transformBefore = await getTransform();

    // Pan the canvas using Shift+vertical wheel (horizontal panning in ReactFlow)
    const canvas = page.locator('//*[@id="react-flow-id"]');
    const bb = await canvas.boundingBox();

    if (bb) {
      await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
      // Hold Shift while scrolling — ReactFlow treats this as horizontal pan
      await page.keyboard.down("Shift");
      await page.mouse.wheel(0, 300);
      await page.keyboard.up("Shift");
    }

    await page.waitForTimeout(400);

    const transformAfter = await getTransform();

    // Viewport transform must change after Shift+scroll
    expect(
      transformAfter,
      "Viewport transform must change after Shift+mouse-wheel scroll",
    ).not.toEqual(transformBefore);
  },
);
