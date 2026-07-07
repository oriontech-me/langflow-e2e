import { expect, test } from "../../../../fixtures/fixtures";
import { setupPlayground } from "../../../../helpers/flows/setup-playground";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";

test.describe("Playground — history persistence", () => {
  test.describe.configure({ mode: "serial" });

  let createdFlowId: string | null = null;

  test.afterEach(async ({ page }) => {
    if (createdFlowId) {
      await page.goto("/");
      await deleteFlow(page.request, createdFlowId);
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

      await test.step("open playground, send message, and wait for run completion", async () => {
        await page.getByTestId("playground-btn-flow-io").click();
        await expect(
          page.getByTestId("input-chat-playground").last(),
        ).toBeVisible({ timeout: 15000 });
        await page
          .getByTestId("input-chat-playground")
          .last()
          .fill("history test");
        await page.getByTestId("button-send").last().click();
        await expect(
          page.getByTestId("chat-message-User-history test"),
        ).toBeVisible({ timeout: 15000 });
        await expect(page.getByTestId("button-stop").last()).toBeHidden({
          timeout: 30000,
        });
      });

      await test.step("close playground via close button", async () => {
        await page.getByTestId("playground-close-button").click();
        await expect(
          page.getByTestId("input-chat-playground").last(),
        ).not.toBeVisible({ timeout: 5000 });
      });

      await test.step("reopen playground and assert sent message is still visible", async () => {
        await page.getByTestId("playground-btn-flow-io").click();
        await expect(
          page.getByTestId("input-chat-playground").last(),
        ).toBeVisible({ timeout: 15000 });
        await expect(
          page.getByTestId("chat-message-User-history test"),
        ).toBeVisible({ timeout: 10000 });
      });
    },
  );
});
