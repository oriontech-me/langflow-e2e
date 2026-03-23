import { expect, test } from "../../../../fixtures/fixtures";
import { adjustScreenView } from "../../../../helpers/ui/adjust-screen-view";
import { awaitBootstrapTest } from "../../../../helpers/other/await-bootstrap-test";
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

test.describe("Playground — fullscreen and panel behavior", () => {
  test(
    "playground modal is visible after opening from the flow editor",
    { tag: ["@release", "@workspace", "@regression", "@playground"] },
    async ({ page }) => {
      await test.step("Set up ChatInput → ChatOutput flow", async () => {
        await setupPlayground(page);
      });

      await test.step("Open playground and confirm chat input is visible", async () => {
        await page.getByTestId("playground-btn-flow-io").click();
        await expect(
          page.getByTestId("input-chat-playground").last(),
        ).toBeVisible({ timeout: 15000 });
      });
    },
  );

  test(
    "playground fullscreen button expands the view",
    { tag: ["@release", "@workspace", "@regression", "@playground"] },
    async ({ page }) => {
      await test.step("Set up ChatInput → ChatOutput flow and open playground", async () => {
        await setupPlayground(page);
        await page.getByTestId("playground-btn-flow-io").click();
        await expect(
          page.getByTestId("input-chat-playground").last(),
        ).toBeVisible({ timeout: 15000 });
      });

      await test.step("Click fullscreen button", async () => {
        await page.getByRole("button", { name: "Enter fullscreen" }).click();
      });

      await test.step("Confirm close button appears and chat input remains visible", async () => {
        await expect(
          page.getByTestId("playground-close-button"),
        ).toBeVisible({ timeout: 5000 });
        await expect(
          page.getByTestId("input-chat-playground").last(),
        ).toBeVisible({ timeout: 5000 });
      });
    },
  );

  test(
    "playground can be closed and reopened from the flow editor",
    { tag: ["@release", "@workspace", "@regression", "@playground"] },
    async ({ page }) => {
      await test.step("Set up ChatInput → ChatOutput flow and open playground", async () => {
        await setupPlayground(page);
        await page.getByTestId("playground-btn-flow-io").click();
        await expect(
          page.getByTestId("input-chat-playground").last(),
        ).toBeVisible({ timeout: 15000 });
      });

      await test.step("Enter fullscreen and close playground via keyboard", async () => {
        await page.getByRole("button", { name: "Enter fullscreen" }).click();
        const closeBtn = page.getByTestId("playground-close-button");
        await expect(closeBtn).toBeVisible({ timeout: 5000 });
        await closeBtn.focus();
        await page.keyboard.press("Enter");
        await expect(
          page.getByTestId("input-chat-playground").last(),
        ).not.toBeVisible({ timeout: 5000 });
      });

      await test.step("Reopen playground and confirm chat input is visible again", async () => {
        await page.getByTestId("playground-btn-flow-io").click();
        await expect(
          page.getByTestId("input-chat-playground").last(),
        ).toBeVisible({ timeout: 15000 });
      });
    },
  );
});
