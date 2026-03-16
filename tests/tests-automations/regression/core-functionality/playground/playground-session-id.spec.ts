import { expect, test } from "../../../../fixtures/fixtures";
import { adjustScreenView } from "../../../../helpers/ui/adjust-screen-view";
import { awaitBootstrapTest } from "../../../../helpers/other/await-bootstrap-test";
import { zoomOut } from "../../../../helpers/ui/zoom-out";

async function setupMockedChatFlow(page: any) {
  await awaitBootstrapTest(page);
  await page.waitForSelector('[data-testid="blank-flow"]', { timeout: 30000 });
  await page.getByTestId("blank-flow").click();

  // Add ChatOutput
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

  // Add ChatInput via drag
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

  // Mock the run endpoint so no real LLM call is made
  await page.route("**/api/v1/run/**", async (route: import("@playwright/test").Route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        outputs: [
          {
            outputs: [
              { results: { message: { text: "Mocked response" } } },
            ],
          },
        ],
        session_id: "mocked-session",
      }),
    });
  });
}

test(
  "playground opens with a chat input field after connecting ChatInput and ChatOutput",
  { tag: ["@release", "@workspace", "@regression"] },
  async ({ page }) => {
    await setupMockedChatFlow(page);

    await page.getByTestId("playground-btn-flow-io").click();
    await page.waitForSelector('[data-testid="input-chat-playground"]', {
      timeout: 15000,
    });

    const inputField = page.getByTestId("input-chat-playground").last();
    await expect(inputField).toBeVisible({ timeout: 5000 });
    await expect(inputField).toBeEnabled({ timeout: 3000 });
  },
);

test(
  "playground session ID input accepts a custom session value",
  { tag: ["@release", "@workspace", "@regression"] },
  async ({ page }) => {
    await setupMockedChatFlow(page);

    await page.getByTestId("playground-btn-flow-io").click();
    await page.waitForSelector('[data-testid="input-chat-playground"]', {
      timeout: 15000,
    });

    const customSession = `session-${Date.now()}`;

    await page.getByTestId("popover-anchor-input-session_id").clear();
    await page.getByTestId("popover-anchor-input-session_id").fill(customSession);
    await expect(page.getByTestId("popover-anchor-input-session_id")).toHaveValue(customSession);
  },
);

test(
  "changing session ID in playground resets the conversation history display",
  { tag: ["@release", "@workspace", "@regression"] },
  async ({ page }) => {
    await setupMockedChatFlow(page);

    await page.getByTestId("playground-btn-flow-io").click();
    await page.waitForSelector('[data-testid="input-chat-playground"]', {
      timeout: 15000,
    });

    await expect(page.getByTestId("input-chat-playground").last()).toBeVisible({ timeout: 5000 });

    const sessionA = `session-a-${Date.now()}`;
    await page.getByTestId("popover-anchor-input-session_id").clear();
    await page.getByTestId("popover-anchor-input-session_id").fill(sessionA);
    await expect(page.getByTestId("popover-anchor-input-session_id")).toHaveValue(sessionA);

    const sessionB = `session-b-${Date.now()}`;
    await page.getByTestId("popover-anchor-input-session_id").clear();
    await page.getByTestId("popover-anchor-input-session_id").fill(sessionB);
    await expect(page.getByTestId("popover-anchor-input-session_id")).toHaveValue(sessionB);
  },
);
