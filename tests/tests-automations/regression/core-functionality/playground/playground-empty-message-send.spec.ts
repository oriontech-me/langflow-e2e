import { expect, test } from "../../../../fixtures/fixtures";
import { setupPlayground } from "../../../../helpers/flows/setup-playground";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";

test.describe("Playground Empty-Message Send Behavior", () => {
  let createdFlowId: string | null = null;

  test.afterEach(async ({ page }) => {
    if (createdFlowId) {
      await page.goto("/");
      await deleteFlow(page.request, createdFlowId);
      createdFlowId = null;
    }
  });

  test(
    "send button stays enabled regardless of input content",
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

      // By design, button-send is only disabled while files are uploading;
      // it is intentionally not tied to chat-text emptiness, so the button
      // remains enabled even with an empty input. This test pins that
      // contract so a regression to a content-aware disabled state is
      // surfaced for review.
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
