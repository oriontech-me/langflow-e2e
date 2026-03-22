import { expect, test } from "../../../../fixtures/fixtures";
import { adjustScreenView } from "../../../../helpers/ui/adjust-screen-view";
import { awaitBootstrapTest } from "../../../../helpers/other/await-bootstrap-test";
import { cleanAllFlows } from "../../../../helpers/flows/clean-all-flows";
import { zoomOut } from "../../../../helpers/ui/zoom-out";

async function setupPlayground(page: any) {
  await awaitBootstrapTest(page);
  await page.waitForSelector('[data-testid="blank-flow"]', { timeout: 30000 });
  await page.getByTestId("blank-flow").click();

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

  await page
    .getByTestId("handle-chatinput-noshownode-chat message-source")
    .click();
  await page
    .getByTestId("handle-chatoutput-noshownode-inputs-target")
    .click();

  await expect(page.locator(".react-flow__edge")).toHaveCount(1, {
    timeout: 8000,
  });
}

test.describe.configure({ mode: "serial" });

test.describe("Playground UX", () => {
  test.afterEach(async ({ page }) => {
    await page.goto("/");
    await cleanAllFlows(page);
  });

  test(
    "user message must appear instantly in playground before AI responds",
    { tag: ["@release", "@regression", "@playground"] },
    async ({ page }) => {
      await test.step("Set up ChatInput → ChatOutput flow and open playground", async () => {
        await setupPlayground(page);
        await page.getByTestId("playground-btn-flow-io").click();
        await expect(
          page.getByTestId("input-chat-playground").last(),
        ).toBeVisible({ timeout: 15000 });
      });

      await test.step("Send message and confirm it appears before flow responds", async () => {
        const userMessage = "Hello from regression test";
        await page.getByTestId("input-chat-playground").last().fill(userMessage);
        await page.getByTestId("button-send").last().click();

        // User message must appear immediately — before the flow finishes
        await expect(page.getByText(userMessage).last()).toBeVisible({
          timeout: 5000,
        });
      });

      await test.step("Wait for flow to complete", async () => {
        // input re-enables when isBuilding becomes false
        await expect(
          page.getByTestId("input-chat-playground").last(),
        ).toBeEnabled({ timeout: 15000 });
      });
    },
  );

  test(
    "playground must scroll to latest message after sending",
    { tag: ["@release", "@regression", "@playground"] },
    async ({ page }) => {
      await test.step("Set up ChatInput → ChatOutput flow and open playground", async () => {
        await setupPlayground(page);
        await page.getByTestId("playground-btn-flow-io").click();
        await expect(
          page.getByTestId("input-chat-playground").last(),
        ).toBeVisible({ timeout: 15000 });
      });

      await test.step("Send enough messages to overflow the chat and wait for each response", async () => {
        const messages = [
          "Message 1.", "Message 2.", "Message 3.", "Message 4.",
          "Message 5.", "Message 6.", "Message 7.", "Message 8.",
          "Message 9.", "Message 10.",
        ];
        for (const msg of messages) {
          await page.getByTestId("input-chat-playground").last().fill(msg);
          await page.getByTestId("button-send").last().click();
          await expect(
            page.getByTestId("input-chat-playground").last(),
          ).toBeEnabled({ timeout: 15000 });
        }
      });

      await test.step("Confirm last message is visible in viewport after auto-scroll", async () => {
        const lastMessage = page.getByText("Message 10.").last();
        await expect(lastMessage).toBeVisible({ timeout: 10000 });
        await expect(lastMessage).toBeInViewport({ timeout: 5000 });
      });
    },
  );

  test(
    "playground input field must be ready after flow responds",
    { tag: ["@release", "@regression", "@playground"] },
    async ({ page }) => {
      await test.step("Set up ChatInput → ChatOutput flow and open playground", async () => {
        await setupPlayground(page);
        await page.getByTestId("playground-btn-flow-io").click();
        await expect(
          page.getByTestId("input-chat-playground").last(),
        ).toBeVisible({ timeout: 15000 });
      });

      await test.step("Send message and wait for flow to respond", async () => {
        await page.getByTestId("input-chat-playground").last().fill("Hi.");
        await page.getByTestId("button-send").last().click();
        await expect(
          page.getByTestId("input-chat-playground").last(),
        ).toBeEnabled({ timeout: 15000 });
      });

      await test.step("Confirm input is ready for a follow-up message", async () => {
        const input = page.getByTestId("input-chat-playground").last();
        await expect(input).toBeVisible({ timeout: 5000 });
        await expect(input).toBeEnabled();
        await input.fill("Follow-up message.");
        expect(await input.inputValue()).toBe("Follow-up message.");
      });
    },
  );
});
