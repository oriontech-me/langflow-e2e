import { expect, test } from "../../../fixtures/fixtures";
import { adjustScreenView } from "../../../helpers/ui/adjust-screen-view";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";
import { zoomOut } from "../../../helpers/ui/zoom-out";

async function setupChatFlow(page: any) {
  await awaitBootstrapTest(page);
  await page.waitForSelector('[data-testid="blank-flow"]', { timeout: 30000 });
  await page.getByTestId("blank-flow").click();

  // Add ChatOutput first (hover → click add button)
  await page.waitForSelector('[data-testid="sidebar-search-input"]', {
    timeout: 30000,
  });
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

  // Add ChatInput via drag to a different position to avoid overlap
  await page.getByTestId("sidebar-search-input").fill("chat input");
  await page.waitForSelector('[data-testid="input_outputChat Input"]', {
    timeout: 30000,
  });
  await page.getByTestId("input_outputChat Input").dragTo(
    page.locator('//*[@id="react-flow-id"]'),
    { targetPosition: { x: 100, y: 100 } },
  );

  await adjustScreenView(page);

  // Connect ChatInput source → ChatOutput target
  await page
    .getByTestId("handle-chatinput-noshownode-chat message-source")
    .click();
  await page
    .getByTestId("handle-chatoutput-noshownode-inputs-target")
    .click();
}

test.describe("Execution Error Notifications", () => {
  test(
    "executing flow with server error shows error feedback",
    { tag: ["@release", "@workspace", "@regression"] },
    async ({ page }) => {
      await setupChatFlow(page);

      // Open playground first, before setting up the mock, so the modal can load normally
      await page.getByTestId("playground-btn-flow-io").click();
      await page.waitForSelector('[data-testid="input-chat-playground"]', {
        timeout: 30000,
      });

      // The playground uses /api/v1/build/{flowId}/flow (not /run).
      // Now that the playground is open, mock to return 500 to simulate an execution failure.
      await page.route("**/api/v1/build/**", async (route) => {
        const url = route.request().url();
        // Only intercept the /flow build endpoint (not vertices order or others)
        if (url.includes("/flow")) {
          await route.fulfill({
            status: 500,
            contentType: "application/json",
            body: JSON.stringify({
              detail: "Internal server error during execution",
            }),
          });
        } else {
          await route.continue();
        }
      });

      await page.getByTestId("input-chat-playground").last().fill("test message");
      await page.getByTestId("button-send").last().click();

      // Langflow shows error feedback as:
      // 1. A build-failure banner: "Flow build failed" / "Error starting build process"
      // 2. A slide-in toast with class "error-build-message"
      // 3. Text from the alert store (MISSED_ERROR_ALERT = "Oops! Looks like you missed something")
      // 4. Inline error in chat (bg-error-red class)
      const buildFailedText = await page
        .getByText(/flow build failed|error starting build|build process/i)
        .first()
        .isVisible({ timeout: 8000 })
        .catch(() => false);

      const errorToast = await page
        .locator(".error-build-message")
        .first()
        .isVisible({ timeout: 3000 })
        .catch(() => false);

      const errorAlertText = await page
        .getByText(/oops|looks like you missed|error occurred|internal server/i)
        .first()
        .isVisible({ timeout: 3000 })
        .catch(() => false);

      const inlineChatError = await page
        .locator('[class*="bg-error-red"], [class*="error-red"]')
        .first()
        .isVisible({ timeout: 3000 })
        .catch(() => false);

      expect(
        buildFailedText || errorToast || errorAlertText || inlineChatError,
        "Expected error feedback when execution fails with 500",
      ).toBe(true);
    },
  );

  test(
    "executing flow with network timeout shows error feedback",
    { tag: ["@release", "@workspace", "@regression"] },
    async ({ page }) => {
      await setupChatFlow(page);

      // Open playground first, before setting up the mock
      await page.getByTestId("playground-btn-flow-io").click();
      await page.waitForSelector('[data-testid="input-chat-playground"]', {
        timeout: 30000,
      });

      // Abort the build request to simulate a network timeout
      await page.route("**/api/v1/build/**", async (route) => {
        const url = route.request().url();
        if (url.includes("/flow")) {
          await route.abort("timedout");
        } else {
          await route.continue();
        }
      });

      await page.getByTestId("input-chat-playground").last().fill("timeout test");
      await page.getByTestId("button-send").last().click();

      // Wait for error feedback
      const buildFailedText = await page
        .getByText(/flow build failed|error starting build|build process/i)
        .first()
        .isVisible({ timeout: 10000 })
        .catch(() => false);

      const errorToast = await page
        .locator(".error-build-message")
        .first()
        .isVisible({ timeout: 5000 })
        .catch(() => false);

      const errorText = await page
        .getByText(/oops|looks like you missed|error|failed|timeout|network/i)
        .first()
        .isVisible({ timeout: 5000 })
        .catch(() => false);

      expect(
        buildFailedText || errorToast || errorText,
        "Expected error feedback when execution times out",
      ).toBe(true);
    },
  );

  test(
    "flow run button shows loading state during execution",
    { tag: ["@release", "@workspace", "@regression"] },
    async ({ page }) => {
      await setupChatFlow(page);

      // Open playground first, before setting up the mock
      await page.getByTestId("playground-btn-flow-io").click();
      await page.waitForSelector('[data-testid="input-chat-playground"]', {
        timeout: 30000,
      });

      // Mock with a delayed response so we can observe the loading state
      await page.route("**/api/v1/build/**", async (route) => {
        const url = route.request().url();
        if (url.includes("/flow")) {
          await new Promise((resolve) => setTimeout(resolve, 1500));
          await route.fulfill({
            status: 200,
            contentType: "text/event-stream",
            body: `data: {"event": "end", "data": {"outputs": [{"outputs": [{"results": {"message": {"text": "Delayed mock response"}}}]}], "session_id": "test-session-loading"}}\n\n`,
          });
        } else {
          await route.continue();
        }
      });

      await page.getByTestId("input-chat-playground").last().fill("loading test");
      await page.getByTestId("button-send").last().click();

      // While waiting for the delayed response, check for loading state indicators
      const stopButtonVisible = await page
        .getByRole("button", { name: /stop/i })
        .isVisible({ timeout: 5000 })
        .catch(() => false);

      const sendButtonDisabled = await page
        .getByTestId("button-send")
        .last()
        .isDisabled({ timeout: 5000 })
        .catch(() => false);

      const loadingIndicator = await page
        .locator(
          '[class*="loading"], [class*="spinner"], [aria-busy="true"], [data-testid*="loading"]',
        )
        .first()
        .isVisible({ timeout: 5000 })
        .catch(() => false);

      expect(
        stopButtonVisible || sendButtonDisabled || loadingIndicator,
        "Expected loading state indicator while execution is in progress",
      ).toBe(true);

      // Wait for the delayed response to complete
      await page.waitForTimeout(2000);
    },
  );
});
