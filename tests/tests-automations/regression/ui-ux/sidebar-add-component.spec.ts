import { expect, test } from "../../../fixtures/fixtures";
import { adjustScreenView } from "../../../helpers/ui/adjust-screen-view";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";

test(
  "double-click on sidebar component adds it to canvas",
  { tag: ["@release", "@workspace", "@regression"] },
  async ({ page }) => {
    await awaitBootstrapTest(page);

    await page.waitForSelector('[data-testid="blank-flow"]', { timeout: 30000 });
    await page.getByTestId("blank-flow").click();

    await page.getByTestId("sidebar-search-input").click();
    await page.getByTestId("sidebar-search-input").fill("chat input");
    await page.waitForSelector('[data-testid="input_outputChat Input"]', {
      timeout: 30000,
    });

    // Double-click the sidebar item — should add component to canvas
    await page.getByTestId("input_outputChat Input").dblclick();

    await adjustScreenView(page);

    await expect(page.locator(".react-flow__node")).toHaveCount(1, {
      timeout: 10000,
    });
  },
);

test(
  "double-click adds second component without clearing the first",
  { tag: ["@release", "@workspace", "@regression"] },
  async ({ page }) => {
    await awaitBootstrapTest(page);

    await page.waitForSelector('[data-testid="blank-flow"]', { timeout: 30000 });
    await page.getByTestId("blank-flow").click();

    await page.getByTestId("sidebar-search-input").click();
    await page.getByTestId("sidebar-search-input").fill("chat output");
    await page.waitForSelector('[data-testid="input_outputChat Output"]', {
      timeout: 30000,
    });

    // Add first component via double-click
    await page.getByTestId("input_outputChat Output").dblclick();
    await page.waitForTimeout(500);
    await expect(page.locator(".react-flow__node")).toHaveCount(1, {
      timeout: 8000,
    });

    // Add second component via double-click
    await page.getByTestId("sidebar-search-input").clear();
    await page.getByTestId("sidebar-search-input").fill("chat input");
    await page.waitForSelector('[data-testid="input_outputChat Input"]', {
      timeout: 30000,
    });
    await page.getByTestId("input_outputChat Input").dblclick();
    await page.waitForTimeout(500);

    await adjustScreenView(page);

    await expect(page.locator(".react-flow__node")).toHaveCount(2, {
      timeout: 10000,
    });
  },
);

test(
  "hover and click the add button adds component to canvas",
  { tag: ["@release", "@workspace", "@regression"] },
  async ({ page }) => {
    await awaitBootstrapTest(page);

    await page.waitForSelector('[data-testid="blank-flow"]', { timeout: 30000 });
    await page.getByTestId("blank-flow").click();

    await page.getByTestId("sidebar-search-input").click();
    await page.getByTestId("sidebar-search-input").fill("prompt");
    await page.waitForSelector(
      '[data-testid="add-component-button-prompt-template"]',
      { timeout: 30000 },
    );

    // Hover the component card to reveal add button, then click it
    const addBtn = page.getByTestId("add-component-button-prompt-template");
    await addBtn.locator("xpath=../..").hover();
    await addBtn.click();

    await adjustScreenView(page);

    await expect(page.locator(".react-flow__node")).toHaveCount(1, {
      timeout: 10000,
    });
  },
);
