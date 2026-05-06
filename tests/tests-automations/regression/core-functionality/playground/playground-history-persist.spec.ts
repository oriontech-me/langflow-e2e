import { expect, test } from "../../../../fixtures/fixtures";
import { setupPlayground } from "../../../../helpers/flows/setup-playground";

test.describe("Playground — history persistence", () => {
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
    "messages sent in playground must persist after closing and reopening",
    { tag: ["@stable", "@regression", "@playground"] },
    async ({ page }) => {
      await test.step("set up ChatInput → ChatOutput flow", async () => {
        createdFlowId = await setupPlayground(page);
      });

      await test.step("open playground, send message, and wait for response", async () => {
        await page.getByTestId("playground-btn-flow-io").click();
        await expect(page.getByTestId("input-chat-playground")).toBeVisible({
          timeout: 15000,
        });
        await page.getByTestId("input-chat-playground").fill("history test");
        await page.getByTestId("button-send").click();
        await expect(page.getByTestId("div-chat-message")).toBeVisible({
          timeout: 15000,
        });
      });

      await test.step("close playground via close button", async () => {
        await page.getByTestId("playground-close-button").click();
        await expect(page.getByTestId("input-chat-playground")).not.toBeVisible(
          { timeout: 5000 },
        );
      });

      await test.step("reopen playground and assert message is still visible", async () => {
        await page.getByTestId("playground-btn-flow-io").click();
        await expect(page.getByTestId("input-chat-playground")).toBeVisible({
          timeout: 15000,
        });
        await expect(page.getByTestId("div-chat-message")).toBeVisible({
          timeout: 10000,
        });
      });
    },
  );
});
