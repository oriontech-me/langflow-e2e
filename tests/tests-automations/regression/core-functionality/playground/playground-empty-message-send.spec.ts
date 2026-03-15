import { expect, test } from "../../../../fixtures/fixtures";
import { adjustScreenView } from "../../../../helpers/ui/adjust-screen-view";
import { awaitBootstrapTest } from "../../../../helpers/other/await-bootstrap-test";
import { zoomOut } from "../../../../helpers/ui/zoom-out";

// Helper: builds a connected ChatInput → ChatOutput flow and opens the Playground.
async function setupPlayground(page: any) {
  await awaitBootstrapTest(page);
  await page.waitForSelector('[data-testid="blank-flow"]', { timeout: 30000 });
  await page.getByTestId("blank-flow").click();

  // Add ChatOutput first via hover-click (lands at default canvas centre)
  await page.getByTestId("sidebar-search-input").fill("chat output");
  await page.waitForSelector('[data-testid="input_outputChat Output"]', {
    timeout: 30000,
  });
  await page.getByTestId("input_outputChat Output").hover();
  await page.getByTestId("add-component-button-chat-output").click();

  await zoomOut(page, 2);

  // Add ChatInput via dragTo so it lands at a different position
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

  // Connect: click ChatInput source handle, then ChatOutput target handle
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
}

test.describe("Playground Empty-Message Send Behavior", () => {
  test(
    "send button is enabled when input is empty (Langflow bug)",
    { tag: ["@release", "@workspace", "@regression"] },
    async ({ page }) => {
      await setupPlayground(page);

      const input = page.getByTestId("input-chat-playground").last();
      const sendBtn = page.getByTestId("button-send").last();

      // Confirm the input starts empty — no prior fill has been done.
      const inputValue = await input.inputValue();
      expect(inputValue).toBe("");

      // BUG: the send button should be disabled when the input is empty so
      // that users cannot dispatch an empty-message run.  Current behaviour
      // is that the button remains ENABLED regardless of input content.
      // This assertion documents the actual (buggy) behaviour; the test will
      // need updating once the bug is fixed.
      await expect(sendBtn).toBeEnabled({ timeout: 5000 });
    },
  );

  test(
    "send button becomes enabled after typing a message",
    { tag: ["@release", "@workspace", "@regression"] },
    async ({ page }) => {
      await setupPlayground(page);

      const input = page.getByTestId("input-chat-playground").last();
      const sendBtn = page.getByTestId("button-send").last();

      // Fill the input with a non-empty message
      await input.fill("Hello, Langflow!");
      await expect(input).toHaveValue("Hello, Langflow!");

      // Send button must be enabled when there is content to send
      await expect(sendBtn).toBeEnabled({ timeout: 5000 });
    },
  );

  test(
    "clearing the input after typing leaves the field empty",
    { tag: ["@release", "@workspace", "@regression"] },
    async ({ page }) => {
      await setupPlayground(page);

      const input = page.getByTestId("input-chat-playground").last();

      // Type content then clear it
      await input.fill("some message");
      await expect(input).toHaveValue("some message");

      await input.clear();

      // Input must be empty after clearing
      await expect(input).toHaveValue("");
    },
  );
});
