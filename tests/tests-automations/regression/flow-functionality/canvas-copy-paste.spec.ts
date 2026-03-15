import { expect, test } from "../../../fixtures/fixtures";
import { adjustScreenView } from "../../../helpers/ui/adjust-screen-view";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";

test(
  "copy and paste ChatOutput component via Ctrl+C / Ctrl+V",
  { tag: ["@release", "@workspace", "@regression"] },
  async ({ page }) => {
    await awaitBootstrapTest(page);

    await page.waitForSelector('[data-testid="blank-flow"]', { timeout: 30000 });
    await page.getByTestId("blank-flow").click();

    // Add a ChatOutput component
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

    // Click on the node to select it
    await page.locator(".react-flow__node").first().click();
    await page.waitForTimeout(300);

    // Copy with Ctrl+C
    await page.keyboard.press("Control+c");
    await page.waitForTimeout(300);

    // Click canvas to ensure focus, then paste
    await page.locator('//*[@id="react-flow-id"]').click({
      position: { x: 400, y: 300 },
    });
    await page.waitForTimeout(200);

    // Paste with Ctrl+V
    await page.keyboard.press("Control+v");
    await page.waitForTimeout(1500);

    // Should have 2 nodes now
    await expect(page.locator(".react-flow__node")).toHaveCount(2, {
      timeout: 8000,
    });
  },
);

test(
  "copy and paste component via Ctrl+C / Ctrl+V keyboard shortcuts",
  { tag: ["@release", "@workspace", "@regression"] },
  async ({ page }) => {
    await awaitBootstrapTest(page);

    await page.waitForSelector('[data-testid="blank-flow"]', { timeout: 30000 });
    await page.getByTestId("blank-flow").click();

    // Add a Prompt Template component
    await page.getByTestId("sidebar-search-input").click();
    await page.getByTestId("sidebar-search-input").fill("prompt");
    await page.waitForSelector(
      '[data-testid="add-component-button-prompt-template"]',
      { timeout: 30000 },
    );
    await page.getByTestId("add-component-button-prompt-template").click();

    await adjustScreenView(page);

    await expect(page.locator(".react-flow__node")).toHaveCount(1, {
      timeout: 10000,
    });

    // Click on the node to select it
    await page.locator(".react-flow__node").first().click();
    await page.waitForTimeout(300);

    // Copy with Ctrl+C
    await page.keyboard.press("Control+c");
    await page.waitForTimeout(300);

    // Click canvas to ensure focus, then paste
    await page.locator('//*[@id="react-flow-id"]').click({
      position: { x: 400, y: 300 },
    });
    await page.waitForTimeout(200);

    // Paste with Ctrl+V
    await page.keyboard.press("Control+v");
    await page.waitForTimeout(1500);

    // Should have 2 nodes now
    await expect(page.locator(".react-flow__node")).toHaveCount(2, {
      timeout: 8000,
    });
  },
);

test(
  "duplicate component via Ctrl+D keyboard shortcut creates a copy on canvas",
  { tag: ["@release", "@workspace", "@regression"] },
  async ({ page }) => {
    await awaitBootstrapTest(page);

    await page.waitForSelector('[data-testid="blank-flow"]', { timeout: 30000 });
    await page.getByTestId("blank-flow").click();

    // Add a ChatOutput component
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

    // Select the node
    await page.locator(".react-flow__node").first().click();
    await page.waitForTimeout(300);

    // Duplicate via keyboard shortcut (mod+d = Ctrl+D on Linux/Windows)
    await page.keyboard.press("Control+d");
    await page.waitForTimeout(800);

    // Must have 2 nodes — no fallback, no masking
    await expect(page.locator(".react-flow__node")).toHaveCount(2, {
      timeout: 8000,
    });
  },
);
