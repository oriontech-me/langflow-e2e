import { expect, test } from "../../../fixtures/fixtures";
import { adjustScreenView } from "../../../helpers/ui/adjust-screen-view";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";
import { zoomOut } from "../../../helpers/ui/zoom-out";

test.describe("Canvas Edge Reconnect", () => {
  test(
    "delete edge via context menu removes it from canvas",
    { tag: ["@release", "@workspace", "@regression"] },
    async ({ page }) => {
      await awaitBootstrapTest(page);

      await page.waitForSelector('[data-testid="blank-flow"]', {
        timeout: 30000,
      });
      await page.getByTestId("blank-flow").click();

      // Add ChatOutput first via hover-click
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

      await zoomOut(page, 2);

      // Add ChatInput via drag to different position
      await page.getByTestId("sidebar-search-input").click();
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

      // Connect: click source handle of ChatInput, then target handle of ChatOutput
      await page
        .getByTestId("handle-chatinput-noshownode-chat message-source")
        .click();
      await page
        .getByTestId("handle-chatoutput-noshownode-inputs-target")
        .click();

      // One edge must appear
      await expect(page.locator(".react-flow__edge")).toHaveCount(1, {
        timeout: 8000,
      });

      // Delete edge via context menu (right-click on edge context menu trigger)
      await page
        .getByTestId("edge-context-menu-trigger")
        .click({ button: "right" });
      await page.getByTestId("context-menu-item-destructive").click();

      // Edge should be gone
      const edgeTrigger = page.getByTestId("edge-context-menu-trigger");
      await expect(edgeTrigger).toHaveCount(0, { timeout: 5000 });
    },
  );

  test(
    "reconnect edge after deletion restores connection",
    { tag: ["@release", "@workspace", "@regression"] },
    async ({ page }) => {
      await awaitBootstrapTest(page);

      await page.waitForSelector('[data-testid="blank-flow"]', {
        timeout: 30000,
      });
      await page.getByTestId("blank-flow").click();

      // Add ChatOutput first via hover-click
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

      await zoomOut(page, 2);

      // Add ChatInput via drag to different position
      await page.getByTestId("sidebar-search-input").click();
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

      // Step 1: Connect ChatInput → ChatOutput
      await page
        .getByTestId("handle-chatinput-noshownode-chat message-source")
        .click();
      await page
        .getByTestId("handle-chatoutput-noshownode-inputs-target")
        .click();

      await expect(page.locator(".react-flow__edge")).toHaveCount(1, {
        timeout: 8000,
      });

      // Step 2: Delete the edge via context menu
      await page
        .getByTestId("edge-context-menu-trigger")
        .click({ button: "right" });
      await page.getByTestId("context-menu-item-destructive").click();

      // Edge should be gone
      await expect(
        page.getByTestId("edge-context-menu-trigger"),
      ).toHaveCount(0, { timeout: 5000 });

      // Step 3: Reconnect them
      await page
        .getByTestId("handle-chatinput-noshownode-chat message-source")
        .click();
      await page
        .getByTestId("handle-chatoutput-noshownode-inputs-target")
        .click();

      // Edge should be back
      await expect(page.locator(".react-flow__edge")).toHaveCount(1, {
        timeout: 8000,
      });
    },
  );

  test(
    "edge between ChatInput and ChatOutput is deletable and reconnectable multiple times",
    { tag: ["@release", "@workspace", "@regression"] },
    async ({ page }) => {
      await awaitBootstrapTest(page);

      await page.waitForSelector('[data-testid="blank-flow"]', {
        timeout: 30000,
      });
      await page.getByTestId("blank-flow").click();

      // Add both components
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

      await zoomOut(page, 2);

      await page.getByTestId("sidebar-search-input").click();
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

      // Connect - delete - reconnect cycle
      for (let i = 0; i < 2; i++) {
        // Connect
        await page
          .getByTestId("handle-chatinput-noshownode-chat message-source")
          .click();
        await page
          .getByTestId("handle-chatoutput-noshownode-inputs-target")
          .click();

        await expect(page.locator(".react-flow__edge")).toHaveCount(1, {
          timeout: 8000,
        });

        // Delete
        await page
          .getByTestId("edge-context-menu-trigger")
          .click({ button: "right" });
        await page.getByTestId("context-menu-item-destructive").click();

        await expect(
          page.getByTestId("edge-context-menu-trigger"),
        ).toHaveCount(0, { timeout: 5000 });
      }

      // Final reconnect - edge should be there
      await page
        .getByTestId("handle-chatinput-noshownode-chat message-source")
        .click();
      await page
        .getByTestId("handle-chatoutput-noshownode-inputs-target")
        .click();

      await expect(page.locator(".react-flow__edge")).toHaveCount(1, {
        timeout: 8000,
      });
    },
  );
});
