import { expect, test } from "../../../fixtures/fixtures";
import { adjustScreenView } from "../../../helpers/ui/adjust-screen-view";
import { setupBlankFlow } from "../../../helpers/flows/setup-blank-flow";

test.describe("Canvas copy / paste", () => {
  let createdFlowId: string | null = null;

  test.afterEach(async ({ page }) => {
    if (createdFlowId) {
      await page.request.delete(`/api/v1/flows/${createdFlowId}`);
      createdFlowId = null;
    }
  });

  test(
    "copy and paste ChatOutput component via Ctrl+C / Ctrl+V",
    { tag: ["@stable", "@release", "@regression", "@workspace"] },
    async ({ page }) => {
      createdFlowId = await setupBlankFlow(page);

      await page.getByTestId("sidebar-search-input").click();
      await page.getByTestId("sidebar-search-input").fill("chat output");
      await expect(page.getByTestId("input_outputChat Output")).toBeVisible({
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

      // Select the node, copy, click empty canvas, paste — Ctrl+C/Ctrl+V is the
      // project's canonical duplication shortcut (Ctrl+D is browser-intercepted on macOS).
      await page.locator(".react-flow__node").first().click();
      await page.keyboard.press("Control+c");
      await page.locator('//*[@id="react-flow-id"]').click({
        position: { x: 400, y: 300 },
      });
      await page.keyboard.press("Control+v");

      await expect(page.locator(".react-flow__node")).toHaveCount(2, {
        timeout: 8000,
      });
    },
  );

  test(
    "copy and paste Prompt Template (component with dynamic ports) via Ctrl+C / Ctrl+V",
    { tag: ["@stable", "@release", "@regression", "@workspace"] },
    async ({ page }) => {
      createdFlowId = await setupBlankFlow(page);

      await page.getByTestId("sidebar-search-input").click();
      await page.getByTestId("sidebar-search-input").fill("prompt");
      await expect(
        page.getByTestId("add-component-button-prompt-template"),
      ).toBeVisible({ timeout: 30000 });
      await page.getByTestId("add-component-button-prompt-template").click();

      await adjustScreenView(page);

      await expect(page.locator(".react-flow__node")).toHaveCount(1, {
        timeout: 10000,
      });

      await page.locator(".react-flow__node").first().click();
      await page.keyboard.press("Control+c");
      await page.locator('//*[@id="react-flow-id"]').click({
        position: { x: 400, y: 300 },
      });
      await page.keyboard.press("Control+v");

      await expect(page.locator(".react-flow__node")).toHaveCount(2, {
        timeout: 8000,
      });
    },
  );
});
