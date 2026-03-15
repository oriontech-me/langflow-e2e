import { expect, test } from "../../../fixtures/fixtures";
import { adjustScreenView } from "../../../helpers/ui/adjust-screen-view";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";

test(
  "component added to canvas appears with its node header visible",
  { tag: ["@release", "@workspace", "@regression"] },
  async ({ page }) => {
    await awaitBootstrapTest(page);

    await page.waitForSelector('[data-testid="blank-flow"]', { timeout: 30000 });
    await page.getByTestId("blank-flow").click();

    // Add Chat Input component
    await page.getByTestId("sidebar-search-input").fill("chat input");
    await page.waitForSelector('[data-testid="input_outputChat Input"]', {
      timeout: 30000,
    });
    await page.getByTestId("input_outputChat Input").hover();
    await page.getByTestId("add-component-button-chat-input").click();

    await adjustScreenView(page);

    // Component must appear on canvas
    await expect(page.locator(".react-flow__node")).toHaveCount(1, {
      timeout: 10000,
    });

    // Node must show its type name (component title in the header)
    await expect(
      page.locator(".react-flow__node").getByText("Chat Input"),
    ).toBeVisible({ timeout: 5000 });
  },
);

test(
  "component added via double-click appears on canvas",
  { tag: ["@release", "@workspace", "@regression"] },
  async ({ page }) => {
    await awaitBootstrapTest(page);

    await page.waitForSelector('[data-testid="blank-flow"]', { timeout: 30000 });
    await page.getByTestId("blank-flow").click();

    // Double-click on sidebar item adds component directly
    await page.getByTestId("sidebar-search-input").fill("chat output");
    await page.waitForSelector('[data-testid="input_outputChat Output"]', {
      timeout: 30000,
    });
    await page.getByTestId("input_outputChat Output").dblclick();

    await adjustScreenView(page);

    await expect(page.locator(".react-flow__node")).toHaveCount(1, {
      timeout: 10000,
    });

    await expect(
      page.locator(".react-flow__node").getByText("Chat Output"),
    ).toBeVisible({ timeout: 5000 });
  },
);

test(
  "adding two components results in two distinct nodes on canvas",
  { tag: ["@release", "@workspace", "@regression"] },
  async ({ page }) => {
    await awaitBootstrapTest(page);

    await page.waitForSelector('[data-testid="blank-flow"]', { timeout: 30000 });
    await page.getByTestId("blank-flow").click();

    // Add first component
    await page.getByTestId("sidebar-search-input").fill("chat input");
    await page.waitForSelector('[data-testid="input_outputChat Input"]', {
      timeout: 30000,
    });
    await page.getByTestId("input_outputChat Input").hover();
    await page.getByTestId("add-component-button-chat-input").click();

    await adjustScreenView(page);
    await expect(page.locator(".react-flow__node")).toHaveCount(1, {
      timeout: 10000,
    });

    // Add second component via drag to avoid overlap
    await page.getByTestId("sidebar-search-input").clear();
    await page.getByTestId("sidebar-search-input").fill("chat output");
    await page.waitForSelector('[data-testid="input_outputChat Output"]', {
      timeout: 30000,
    });
    await page
      .getByTestId("input_outputChat Output")
      .dragTo(page.locator('//*[@id="react-flow-id"]'), {
        targetPosition: { x: 600, y: 200 },
      });

    await adjustScreenView(page);

    // Both nodes must be present
    await expect(page.locator(".react-flow__node")).toHaveCount(2, {
      timeout: 10000,
    });

    // Both component titles must be visible
    await expect(
      page.locator(".react-flow__node").getByText("Chat Input"),
    ).toBeVisible({ timeout: 5000 });
    await expect(
      page.locator(".react-flow__node").getByText("Chat Output"),
    ).toBeVisible({ timeout: 5000 });
  },
);
