import { expect, test } from "../../../../fixtures/fixtures";
import { setupPlayground } from "../../../../helpers/flows/setup-playground";

test.describe("Playground UX", () => {
  test.describe.configure({ mode: "serial" });

  let createdFlowId: string | null = null;

  test.afterEach(async ({ page }) => {
    if (createdFlowId) {
      await page.goto("/");
      await page.request.delete(`/api/v1/flows/${createdFlowId}`);
      createdFlowId = null;
    }
  });

  test(
    "user message must appear instantly in playground before AI responds",
    { tag: ["@release", "@regression", "@playground", "@stable"] },
    async ({ page }) => {
      await test.step("Set up ChatInput → ChatOutput flow and open playground", async () => {
        createdFlowId = await setupPlayground(page);
        await page.getByTestId("playground-btn-flow-io").click();
        await expect(
          page.getByTestId("input-chat-playground").last(),
        ).toBeVisible({ timeout: 15000 });
      });

      await test.step("Send message and confirm it appears in chat", async () => {
        const userMessage = "Hello from regression test";
        await page.getByTestId("input-chat-playground").last().fill(userMessage);
        await page.getByTestId("button-send").last().click();

        await expect(page.getByText(userMessage).last()).toBeVisible({
          timeout: 3000,
        });
      });

      await test.step("Wait for flow to complete", async () => {
        await expect(
          page.getByTestId("input-chat-playground").last(),
        ).toBeEnabled({ timeout: 15000 });
      });
    },
  );

  test(
    "playground must scroll to latest message after sending",
    { tag: ["@release", "@regression", "@playground", "@stable"] },
    async ({ page }) => {
      await test.step("Set up ChatInput → ChatOutput flow and open playground", async () => {
        createdFlowId = await setupPlayground(page);
        await page.getByTestId("playground-btn-flow-io").click();
        await expect(
          page.getByTestId("input-chat-playground").last(),
        ).toBeVisible({ timeout: 15000 });
      });

      await test.step("Send enough messages to overflow the chat and wait for each response", async () => {
        const messages = [
          "Message 1.", "Message 2.", "Message 3.",
          "Message 4.", "Message 5.", "Message 6.",
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
        const lastMessage = page.getByText("Message 6.").last();
        await expect(lastMessage).toBeVisible({ timeout: 10000 });
        await expect(lastMessage).toBeInViewport({ timeout: 5000 });
      });
    },
  );

  test(
    "playground input field must be ready after flow responds",
    { tag: ["@release", "@regression", "@playground", "@stable"] },
    async ({ page }) => {
      await test.step("Set up ChatInput → ChatOutput flow and open playground", async () => {
        createdFlowId = await setupPlayground(page);
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
        await expect(input).toHaveValue("Follow-up message.");
      });
    },
  );
});
