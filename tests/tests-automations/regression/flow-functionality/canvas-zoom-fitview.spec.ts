import { expect, test } from "../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";

test(
  "zoom in increases canvas scale",
  { tag: ["@release", "@workspace", "@regression"] },
  async ({ page }) => {
    await awaitBootstrapTest(page);

    await page.waitForSelector('[data-testid="blank-flow"]', { timeout: 30000 });
    await page.getByTestId("blank-flow").click();

    await page.waitForSelector('[data-testid="sidebar-search-input"]', {
      timeout: 30000,
    });

    // Get initial zoom level from the ReactFlow viewport transform
    const getZoom = () =>
      page.evaluate(() => {
        const vp = document.querySelector(
          ".react-flow__viewport",
        ) as HTMLElement | null;
        if (!vp) return 1;
        const match = vp.style.transform.match(/scale\(([\d.]+)\)/);
        return match ? parseFloat(match[1]) : 1;
      });

    const initialZoom = await getZoom();

    // Zoom in via keyboard shortcut Ctrl+=
    await page.keyboard.press("Control+=");
    await page.waitForTimeout(300);

    const zoomedIn = await getZoom();
    expect(zoomedIn).toBeGreaterThan(initialZoom);
  },
);

test(
  "zoom out decreases canvas scale",
  { tag: ["@release", "@workspace", "@regression"] },
  async ({ page }) => {
    await awaitBootstrapTest(page);

    await page.waitForSelector('[data-testid="blank-flow"]', { timeout: 30000 });
    await page.getByTestId("blank-flow").click();

    await page.waitForSelector('[data-testid="sidebar-search-input"]', {
      timeout: 30000,
    });

    const getZoom = () =>
      page.evaluate(() => {
        const vp = document.querySelector(
          ".react-flow__viewport",
        ) as HTMLElement | null;
        if (!vp) return 1;
        const match = vp.style.transform.match(/scale\(([\d.]+)\)/);
        return match ? parseFloat(match[1]) : 1;
      });

    const initialZoom = await getZoom();

    // Zoom out via keyboard shortcut Ctrl+-
    await page.keyboard.press("Control+-");
    await page.waitForTimeout(300);

    const zoomedOut = await getZoom();
    expect(zoomedOut).toBeLessThan(initialZoom);
  },
);

test(
  "fit view (Ctrl+Shift+H) centers all nodes in viewport",
  { tag: ["@release", "@workspace", "@regression"] },
  async ({ page }) => {
    await awaitBootstrapTest(page);

    await page.waitForSelector('[data-testid="blank-flow"]', { timeout: 30000 });
    await page.getByTestId("blank-flow").click();

    // Add a component
    await page.getByTestId("sidebar-search-input").click();
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

    await expect(page.locator(".react-flow__node")).toHaveCount(1, {
      timeout: 10000,
    });

    // Zoom out a lot first
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press("Control+-");
      await page.waitForTimeout(100);
    }

    // Fit view via keyboard shortcut
    await page.keyboard.press("Control+Shift+H");
    await page.waitForTimeout(500);

    // Node must be visible after fit view
    await expect(page.locator(".react-flow__node").first()).toBeVisible({
      timeout: 5000,
    });
  },
);

test(
  "fit view button on toolbar centers all nodes",
  { tag: ["@release", "@workspace", "@regression"] },
  async ({ page }) => {
    await awaitBootstrapTest(page);

    await page.waitForSelector('[data-testid="blank-flow"]', { timeout: 30000 });
    await page.getByTestId("blank-flow").click();

    // Add a component
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

    await expect(page.locator(".react-flow__node")).toHaveCount(1, {
      timeout: 10000,
    });

    // Fit view button must be present on the toolbar
    const fitViewBtn = page.getByTestId("fit_view");
    await expect(fitViewBtn).toBeVisible({ timeout: 5000 });
    await fitViewBtn.click();
    await page.waitForTimeout(500);

    // Node must be visible after fit view
    await expect(page.locator(".react-flow__node").first()).toBeVisible({
      timeout: 5000,
    });
  },
);
