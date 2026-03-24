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

test.describe("Playground — open and close behavior", () => {
  test.describe.configure({ mode: "serial" });

  test.afterEach(async ({ page }) => {
    await page.goto("/");
    await cleanAllFlows(page);
  });

  test(
    "playground opens in fullscreen with chat input visible",
    { tag: ["@release", "@regression", "@playground"] },
    async ({ page }) => {
      await test.step("set up ChatInput → ChatOutput flow", async () => {
        await setupPlayground(page);
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
    { tag: ["@release", "@regression", "@playground"] },
    async ({ page }) => {
      await test.step("set up ChatInput → ChatOutput flow and open playground", async () => {
        await setupPlayground(page);
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
