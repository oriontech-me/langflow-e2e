import { expect, test } from "../../../../fixtures/fixtures";
import { setupPlayground } from "../../../../helpers/flows/setup-playground";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";

test.describe("Playground — Shareable URL Generation", () => {
  test.describe.configure({ mode: "serial" });

  let createdFlowId: string | null = null;

  test.afterEach(async ({ page }) => {
    if (createdFlowId) {
      // Navigate to home before deleting to stop background browser requests
      // for the current flow; without this, pending polling GETs complete
      // after the DELETE and trigger spurious 404 fixture errors.
      await page.goto("/");
      await deleteFlow(page.request, createdFlowId);
      createdFlowId = null;
    }
  });

  test(
    "Shareable playground URL is generated when publishing is enabled",
    { tag: ["@release", "@playground", "@stable"] },
    async ({ page }) => {
      await test.step("create blank Chat Input → Chat Output flow", async () => {
        createdFlowId = await setupPlayground(page);
      });

      await test.step("open Share dropdown and verify initial state", async () => {
        await page.getByTestId("publish-button").click();
        await expect(page.getByTestId("shareable-playground")).toBeVisible({
          timeout: 10000,
        });
        await expect(page.getByTestId("publish-switch")).not.toBeChecked();
      });

      await test.step("enable sharing and validate generated URL", async () => {
        await page.getByTestId("publish-switch").click();
        await expect(page.getByTestId("publish-switch")).toBeChecked({
          timeout: 10000,
        });

        const shareLink = page.locator('[data-testid="shareable-playground"] a');
        await expect(shareLink).toBeVisible({ timeout: 10000 });

        const href = await shareLink.getAttribute("href");
        expect(href).toMatch(/\/playground\/[0-9a-f-]{36}/);
      });

      await test.step("disable sharing to restore state", async () => {
        await page.getByTestId("publish-switch").click();
        await expect(page.getByTestId("publish-switch")).not.toBeChecked({
          timeout: 10000,
        });
      });
    },
  );
});
