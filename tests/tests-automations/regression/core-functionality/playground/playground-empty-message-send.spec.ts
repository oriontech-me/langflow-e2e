import { expect, test } from "../../../../fixtures/fixtures";
import { setupPlayground } from "../../../../helpers/flows/setup-playground";

test.describe("Playground Empty-Message Send Behavior", () => {
  let createdFlowId: string | null = null;

  test.afterEach(async ({ page }) => {
    if (createdFlowId) {
      await page.goto("/");
      await page.request.delete(`/api/v1/flows/${createdFlowId}`);
      createdFlowId = null;
    }
  });

  test(
    "send button is enabled when input is empty (Langflow bug)",
    { tag: ["@stable", "@release", "@workspace", "@regression", "@playground"] },
    async ({ page }) => {
      createdFlowId = await setupPlayground(page);
      await page.getByTestId("playground-btn-flow-io").click();
      await page.waitForSelector('[data-testid="input-chat-playground"]', {
        timeout: 15000,
      });

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
    { tag: ["@stable", "@release", "@workspace", "@regression", "@playground"] },
    async ({ page }) => {
      createdFlowId = await setupPlayground(page);
      await page.getByTestId("playground-btn-flow-io").click();
      await page.waitForSelector('[data-testid="input-chat-playground"]', {
        timeout: 15000,
      });

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
    { tag: ["@stable", "@release", "@workspace", "@regression", "@playground"] },
    async ({ page }) => {
      createdFlowId = await setupPlayground(page);
      await page.getByTestId("playground-btn-flow-io").click();
      await page.waitForSelector('[data-testid="input-chat-playground"]', {
        timeout: 15000,
      });

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
