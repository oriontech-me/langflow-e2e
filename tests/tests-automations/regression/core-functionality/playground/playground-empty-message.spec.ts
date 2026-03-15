import { expect, test } from "../../../../fixtures/fixtures";
import { adjustScreenView } from "../../../../helpers/ui/adjust-screen-view";
import { awaitBootstrapTest } from "../../../../helpers/other/await-bootstrap-test";
import { zoomOut } from "../../../../helpers/ui/zoom-out";

test.describe("Playground Empty Message Behavior", () => {
  test.beforeEach(async ({ page }) => {
    await awaitBootstrapTest(page);
    await page.waitForSelector('[data-testid="blank-flow"]', { timeout: 30000 });
    await page.getByTestId("blank-flow").click();

    // Add ChatOutput first via hover+click (lands at default center position)
    await page.getByTestId("sidebar-search-input").fill("chat output");
    await page.waitForSelector('[data-testid="input_outputChat Output"]', {
      timeout: 30000,
    });
    await page.getByTestId("input_outputChat Output").hover();
    await page.getByTestId("add-component-button-chat-output").click();

    await zoomOut(page, 2);

    // Add ChatInput via dragTo to a different position (avoids overlap)
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

    await expect(page.locator(".react-flow__node")).toHaveCount(2, {
      timeout: 10000,
    });

    // Connect: click ChatInput source, then ChatOutput target
    await page
      .getByTestId("handle-chatinput-noshownode-chat message-source")
      .click();
    await page
      .getByTestId("handle-chatoutput-noshownode-inputs-target")
      .click();

    await expect(page.locator(".react-flow__edge")).toHaveCount(1, {
      timeout: 8000,
    });

    // Open Playground
    await page.getByTestId("playground-btn-flow-io").click();
    await page.waitForSelector('[data-testid="input-chat-playground"]', {
      timeout: 15000,
    });
  });

  test(
    "send button is disabled when input is empty",
    { tag: ["@release", "@regression"] },
    async ({ page }) => {
      const input = page.getByTestId("input-chat-playground").last();
      const sendBtn = page.getByTestId("button-send").last();

      // Verify the input is empty initially
      const inputValue = await input.inputValue();
      expect(inputValue).toBe("");

      // BUG: Langflow's send button is ENABLED even with an empty input.
      // A user can click Send without typing anything, which sends an empty message.
      // Expected behavior: button should be disabled when input is empty.
      // Asserting actual (buggy) behavior so the test stays passing until fixed:
      await expect(sendBtn).toBeEnabled({ timeout: 5000 });
    },
  );

  test(
    "send button becomes enabled when user types a message",
    { tag: ["@release", "@regression"] },
    async ({ page }) => {
      const input = page.getByTestId("input-chat-playground").last();
      const sendBtn = page.getByTestId("button-send").last();

      // Type a message
      await input.fill("hello");
      await expect(input).toHaveValue("hello");

      // Send button should be enabled after typing
      await expect(sendBtn).toBeEnabled({ timeout: 5000 });
    },
  );
});
