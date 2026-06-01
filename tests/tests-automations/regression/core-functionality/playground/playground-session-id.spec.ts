import { expect, test } from "../../../../fixtures/fixtures";
import { setupPlayground } from "../../../../helpers/flows/setup-playground";

test.describe("Playground — Session ID input", () => {
  test.describe.configure({ mode: "serial" });

  let createdFlowId: string | null = null;

  test.afterEach(async ({ page }) => {
    if (createdFlowId) {
      // Navigate to home before deleting to stop background browser requests
      // for the current flow; without this, pending polling GETs complete
      // after the DELETE and trigger spurious 404 fixture errors.
      await page.goto("/");
      await page.request.delete(`/api/v1/flows/${createdFlowId}`);
      createdFlowId = null;
    }
  });

  test(
    "session ID input accepts a custom value",
    { tag: ["@release", "@regression", "@playground"] },
    async ({ page }) => {
      await test.step("set up ChatInput → ChatOutput flow", async () => {
        createdFlowId = await setupPlayground(page);
      });

      await test.step("open playground and wait for chat input", async () => {
        await page.getByTestId("playground-btn-flow-io").click();
        await expect(
          page.getByTestId("input-chat-playground").last(),
        ).toBeVisible({ timeout: 15000 });
      });

      await test.step("fill session ID and confirm value persists", async () => {
        const customSession = `session-${Date.now()}`;
        const sessionInput = page.getByTestId(
          "popover-anchor-input-session_id",
        );

        await sessionInput.clear();
        await sessionInput.fill(customSession);
        await expect(sessionInput).toHaveValue(customSession);
      });
    },
  );
});
