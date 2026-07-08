import { expect, test } from "../../../../fixtures/fixtures";
import { setupPlayground } from "../../../../helpers/flows/setup-playground";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";

test.describe("LLM Invalid API Key UI Error Display", () => {
  let createdFlowId: string | null = null;

  test.afterEach(async ({ page }) => {
    if (createdFlowId) {
      await page.goto("/");
      await deleteFlow(page.request, createdFlowId);
      createdFlowId = null;
    }
  });

  test(
    "playground shows error when LLM run endpoint returns 500 (mocked invalid API key)",
    { tag: ["@stable", "@release", "@workspace", "@regression", "@agents", "@playground"] },
    async ({ page }) => {
      // This test intentionally injects an HTTP 500 on the run endpoint, so the
      // fixture's backend-error monitor will see it — allow it explicitly.
      (page as any).allowFlowErrors();
      createdFlowId = await setupPlayground(page);

      // Open Playground first so initialization build calls are not intercepted
      await page.getByTestId("playground-btn-flow-io").click();
      await page.waitForSelector('[data-testid="input-chat-playground"]', {
        timeout: 15000,
      });

      // Langflow's playground executes the flow via POST /api/v2/workflows
      // (replaced the older /api/v1/build/{flowId}/flow path in 1.11.x). Mock the
      // POST with a 500 to simulate an invalid-API-key run failure.
      await page.route("**/api/v2/workflows**", async (route) => {
        if (route.request().method() === "POST") {
          await route.fulfill({
            status: 500,
            contentType: "application/json",
            body: JSON.stringify({
              detail: "Invalid API key. Please check your OpenAI API key.",
            }),
          });
        } else {
          await route.continue();
        }
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
    { tag: ["@stable", "@release", "@workspace", "@regression", "@agents", "@playground"] },
    async ({ page }) => {
      // This test intentionally injects an HTTP 500 on the run endpoint, so the
      // fixture's backend-error monitor will see it — allow it explicitly.
      (page as any).allowFlowErrors();
      createdFlowId = await setupPlayground(page);

      // Open Playground first so initialization build calls are not intercepted
      await page.getByTestId("playground-btn-flow-io").click();
      await page.waitForSelector('[data-testid="input-chat-playground"]', {
        timeout: 15000,
      });

      // Mock the playground execution call (POST /api/v2/workflows) with a 500
      await page.route("**/api/v2/workflows**", async (route) => {
        if (route.request().method() === "POST") {
          await route.fulfill({
            status: 500,
            contentType: "application/json",
            body: JSON.stringify({
              detail: "Invalid API key. Please check your OpenAI API key.",
            }),
          });
        } else {
          await route.continue();
        }
      });

      // Register the response waiter before triggering the request so we can
      // confirm the full mocked 500 cycle completed before asserting recovery
      const runResponsePromise = page.waitForResponse(
        (resp) =>
          resp.url().includes("/api/v2/workflows") &&
          resp.request().method() === "POST",
        { timeout: 10000 },
      );

      await page.getByTestId("input-chat-playground").last().fill("trigger error");
      await page.getByTestId("button-send").last().click();

      await runResponsePromise;

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
