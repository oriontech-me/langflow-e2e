import { expect, test } from "../../../../fixtures/fixtures";
import { setupPlayground } from "../../../../helpers/flows/setup-playground";

test.describe("LLM Invalid API Key UI Error Display", () => {
  let createdFlowId: string | null = null;

  test.afterEach(async ({ page }) => {
    if (createdFlowId) {
      await page.goto("/");
      await page.request.delete(`/api/v1/flows/${createdFlowId}`);
      createdFlowId = null;
    }
  });

  test(
    "playground shows error when LLM run endpoint returns 500 (mocked invalid API key)",
    { tag: ["@release", "@workspace", "@regression", "@agents"] },
    async ({ page }) => {
      createdFlowId = await setupPlayground(page);

      // Mock the run endpoint to simulate an invalid API-key error from the LLM
      await page.route("**/api/v1/run/**", async (route) => {
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({
            detail: "Invalid API key. Please check your OpenAI API key.",
          }),
        });
      });

      // Open Playground
      await page.getByTestId("playground-btn-flow-io").click();
      await page.waitForSelector('[data-testid="input-chat-playground"]', {
        timeout: 15000,
      });

      // Send a message to trigger the mocked error
      const input = page.getByTestId("input-chat-playground").last();
      await input.fill("trigger error");
      await page.getByTestId("button-send").last().click();

      // The UI must surface some error indication to the user.
      // Accept any of: error text, a toast, an alert element, or red styling.
      const errorIndicators = [
        page.getByText(/error|invalid|api key|failed/i).first(),
        page.locator('[class*="error"], [class*="alert"], [role="alert"]').first(),
        page.locator('[data-testid*="error"], [data-testid*="alert"]').first(),
      ];

      let errorVisible = false;
      for (const indicator of errorIndicators) {
        if (
          await indicator.isVisible({ timeout: 10000 }).catch(() => false)
        ) {
          errorVisible = true;
          break;
        }
      }

      expect(
        errorVisible,
        "Expected an error message to be visible in the playground after a 500 run response",
      ).toBe(true);
    },
  );

  test(
    "playground input remains usable after API error (mocked)",
    { tag: ["@release", "@workspace", "@regression", "@agents"] },
    async ({ page }) => {
      createdFlowId = await setupPlayground(page);

      // Mock the run endpoint to return a 500 error
      await page.route("**/api/v1/run/**", async (route) => {
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({
            detail: "Invalid API key. Please check your OpenAI API key.",
          }),
        });
      });

      // Open Playground and send a message
      await page.getByTestId("playground-btn-flow-io").click();
      await page.waitForSelector('[data-testid="input-chat-playground"]', {
        timeout: 15000,
      });

      await page.getByTestId("input-chat-playground").last().fill("trigger error");
      await page.getByTestId("button-send").last().click();

      // Wait briefly for the error to be processed
      await page.waitForTimeout(3000);

      // The chat input must still be visible and interactive after the error
      const input = page.getByTestId("input-chat-playground").last();
      await expect(input).toBeVisible({ timeout: 5000 });
      await expect(input).toBeEnabled({ timeout: 5000 });

      // Verify the input can be filled again — confirming usability
      await input.fill("follow-up message");
      await expect(input).toHaveValue("follow-up message");
    },
  );
});
