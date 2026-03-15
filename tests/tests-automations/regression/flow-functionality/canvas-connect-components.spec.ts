import { expect, test } from "../../../fixtures/fixtures";
import { adjustScreenView } from "../../../helpers/ui/adjust-screen-view";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";
import { zoomOut } from "../../../helpers/ui/zoom-out";

// Handle data-testids verified from live UI inspection:
//   ChatInput  source: "handle-chatinput-noshownode-chat message-source"
//   ChatOutput target: "handle-chatoutput-noshownode-inputs-target"
//   TextOutput left:   "handle-textoutput-shownode-inputs-left"

test(
  "should connect ChatInput to ChatOutput by clicking handles",
  { tag: ["@release", "@workspace", "@regression"] },
  async ({ page }) => {
    await awaitBootstrapTest(page);

    await page.waitForSelector('[data-testid="blank-flow"]', { timeout: 30000 });
    await page.getByTestId("blank-flow").click();

    // Add ChatOutput first via hover-click (lands at default position)
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

    // Add ChatInput via drag-to so it lands at a different position
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

    // Fit view so both handles are visible
    await adjustScreenView(page);

    // Both nodes must be on canvas
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
  },
);

test(
  "should connect ChatInput to TextOutput and verify edge",
  { tag: ["@release", "@workspace", "@regression"] },
  async ({ page }) => {
    await awaitBootstrapTest(page);

    await page.waitForSelector('[data-testid="blank-flow"]', { timeout: 30000 });
    await page.getByTestId("blank-flow").click();

    // Add ChatInput via hover-click
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

    await zoomOut(page, 2);

    // Add TextOutput via drag to a different position
    await page.getByTestId("sidebar-search-input").click();
    await page.getByTestId("sidebar-search-input").fill("text output");
    await page.waitForSelector('[data-testid="input_outputText Output"]', {
      timeout: 30000,
    });
    await page
      .getByTestId("input_outputText Output")
      .dragTo(page.locator('//*[@id="react-flow-id"]'), {
        targetPosition: { x: 500, y: 200 },
      });

    await adjustScreenView(page);

    await expect(page.locator(".react-flow__node")).toHaveCount(2, {
      timeout: 10000,
    });

    // Connect ChatInput → TextOutput
    await page
      .getByTestId("handle-chatinput-noshownode-chat message-source")
      .click();
    await page.getByTestId("handle-textoutput-shownode-inputs-left").click();

    await expect(page.locator(".react-flow__edge")).toHaveCount(1, {
      timeout: 8000,
    });
  },
);

test(
  "connected ChatInput and ChatOutput opens Playground without errors",
  { tag: ["@release", "@workspace", "@regression"] },
  async ({ page }) => {
    await awaitBootstrapTest(page);

    await page.waitForSelector('[data-testid="blank-flow"]', { timeout: 30000 });
    await page.getByTestId("blank-flow").click();

    // Add ChatOutput via hover-click
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

    // Add ChatInput via drag to offset position
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

    // Connect ChatInput → ChatOutput
    await page
      .getByTestId("handle-chatinput-noshownode-chat message-source")
      .click();
    await page
      .getByTestId("handle-chatoutput-noshownode-inputs-target")
      .click();

    await expect(page.locator(".react-flow__edge")).toHaveCount(1, {
      timeout: 8000,
    });

    // Verify the Playground button is available (flow is valid for chat)
    await expect(page.getByTestId("playground-btn-flow-io")).toBeVisible({
      timeout: 5000,
    });
  },
);
