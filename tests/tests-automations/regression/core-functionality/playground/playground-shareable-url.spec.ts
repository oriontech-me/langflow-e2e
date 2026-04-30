import { expect, test } from "../../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../../helpers/other/await-bootstrap-test";

test.describe("Playground — Shareable URL Generation", () => {
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
    "Simple Agent shareable playground URL is generated when publishing is enabled",
    { tag: ["@release", "@playground"] },
    async ({ page }) => {
      await test.step("load Simple Agent template", async () => {
        await awaitBootstrapTest(page);
        await page.getByTestId("side_nav_options_all-templates").click();
        await page.getByRole("heading", { name: "Simple Agent" }).first().click();
        await expect(
          page.getByTestId("canvas_controls_dropdown"),
        ).toBeVisible({ timeout: 30000 });

        const flowUrl = page.url();
        const flowIdMatch = flowUrl.match(/\/flow\/([0-9a-f-]{36})/);
        createdFlowId = flowIdMatch?.[1] ?? null;
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
