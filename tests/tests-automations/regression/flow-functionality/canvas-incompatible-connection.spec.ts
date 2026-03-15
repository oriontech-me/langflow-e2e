import { expect, test } from "../../../fixtures/fixtures";
import { adjustScreenView } from "../../../helpers/ui/adjust-screen-view";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";
import { zoomOut } from "../../../helpers/ui/zoom-out";

test(
  "clicking a target handle twice (target-to-target) does not create an edge",
  { tag: ["@release", "@workspace", "@regression"] },
  async ({ page }) => {
    await awaitBootstrapTest(page);

    await page.waitForSelector('[data-testid="blank-flow"]', { timeout: 30000 });
    await page.getByTestId("blank-flow").click();

    // Add a single ChatOutput component
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

    // Click the target handle to start a connection, then click the same target handle again
    // A target-to-target connection is incompatible and should not produce an edge
    await page
      .getByTestId("handle-chatoutput-noshownode-inputs-target")
      .click();
    await page.waitForTimeout(300);
    await page
      .getByTestId("handle-chatoutput-noshownode-inputs-target")
      .click();
    await page.waitForTimeout(1500);

    // No edge should have been created
    await expect(page.locator(".react-flow__edge")).toHaveCount(0, {
      timeout: 5000,
    });
  },
);

test(
  "connecting compatible ChatInput source to ChatOutput target creates exactly one edge",
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

    // Add ChatInput via drag so it lands at a separate position
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

    // Connect: ChatInput source → ChatOutput target (compatible)
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

test(
  "connecting the same compatible pair twice does not duplicate the edge",
  { tag: ["@release", "@workspace", "@regression"] },
  async ({ page }) => {
    await awaitBootstrapTest(page);

    await page.waitForSelector('[data-testid="blank-flow"]', { timeout: 30000 });
    await page.getByTestId("blank-flow").click();

    // Add ChatOutput
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

    // Add ChatInput
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

    // First connection
    await page
      .getByTestId("handle-chatinput-noshownode-chat message-source")
      .click();
    await page
      .getByTestId("handle-chatoutput-noshownode-inputs-target")
      .click();

    await expect(page.locator(".react-flow__edge")).toHaveCount(1, {
      timeout: 8000,
    });

    // Attempt the same connection again — should not produce a second edge
    await page
      .getByTestId("handle-chatinput-noshownode-chat message-source")
      .click();
    await page
      .getByTestId("handle-chatoutput-noshownode-inputs-target")
      .click();
    await page.waitForTimeout(1000);

    // Still only one edge (or the old one was replaced — either way, not two)
    const edgeCount = await page.locator(".react-flow__edge").count();
    expect(edgeCount).toBeLessThanOrEqual(1);
  },
);
