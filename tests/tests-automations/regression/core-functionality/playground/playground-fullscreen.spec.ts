import { expect, test } from "../../../../fixtures/fixtures";
import { setupPlayground } from "../../../../helpers/flows/setup-playground";

test.describe("Playground — open and close behavior", () => {
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
    "playground opens in fullscreen with chat input visible",
    { tag: ["@stable", "@release", "@regression", "@playground"] },
    async ({ page }) => {
      await test.step("set up ChatInput → ChatOutput flow", async () => {
        createdFlowId = await setupPlayground(page);
      });

      await test.step("open playground and confirm it opens in fullscreen with chat input", async () => {
        await page.getByTestId("playground-btn-flow-io").click();
        // playground always opens directly in fullscreen — close button is present immediately
        await expect(
          page.getByTestId("playground-close-button"),
        ).toBeVisible({ timeout: 15000 });
        await expect(
          page.getByTestId("input-chat-playground").last(),
        ).toBeVisible({ timeout: 5000 });
      });
    },
  );

  test(
    "playground closes and reopens correctly from the flow editor",
    { tag: ["@stable", "@release", "@regression", "@playground"] },
    async ({ page }) => {
      await test.step("set up ChatInput → ChatOutput flow and open playground", async () => {
        createdFlowId = await setupPlayground(page);
        await page.getByTestId("playground-btn-flow-io").click();
        await expect(
          page.getByTestId("playground-close-button"),
        ).toBeVisible({ timeout: 15000 });
      });

      await test.step("close playground via close button", async () => {
        await page.getByTestId("playground-close-button").click();
        await expect(
          page.getByTestId("input-chat-playground").last(),
        ).not.toBeVisible({ timeout: 5000 });
      });

      await test.step("reopen playground and confirm chat input is visible again", async () => {
        await page.getByTestId("playground-btn-flow-io").click();
        await expect(
          page.getByTestId("input-chat-playground").last(),
        ).toBeVisible({ timeout: 15000 });
      });
    },
  );
});
