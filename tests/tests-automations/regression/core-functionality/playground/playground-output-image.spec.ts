import path from "path";
import type { Page } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { adjustScreenView } from "../../../../helpers/ui/adjust-screen-view";
import { awaitBootstrapTest } from "../../../../helpers/other/await-bootstrap-test";
import { cleanAllFlows } from "../../../../helpers/flows/clean-all-flows";
import { zoomOut } from "../../../../helpers/ui/zoom-out";

/**
 * Image upload in the playground uses a hidden <input type="file"> inside the
 * input-wrapper. We set files directly on that element to avoid depending on
 * the OS file-chooser dialog or the tooltip-based button locator.
 *
 * Compact preview (before send):
 *   - img inside [data-testid="input-wrapper"], alt="chain.png" (File object)
 *
 * Expanded preview (after send — user message in chat history):
 *   - div-chat-message is the BOT message testid only; user messages use a
 *     different testid. The uploaded image is in the user message, rendered
 *     via FilePreviewDisplay (expanded variant).
 *   - The server prefixes the filename with a timestamp, so the alt becomes
 *     e.g. "2026-03-22_20-09-16_chain.png". We match by src instead:
 *     img[src*="/files/images/"] is the stable selector.
 */

const IMAGE_PATH = path.resolve(
  __dirname,
  "../../../../assets/media/chain.png",
);

async function setupChatEchoFlow(page: Page): Promise<void> {
  await awaitBootstrapTest(page);
  await expect(page.getByTestId("blank-flow")).toBeVisible({ timeout: 30000 });
  await page.getByTestId("blank-flow").click();

  // Add Chat Output
  await page.getByTestId("sidebar-search-input").fill("chat output");
  await expect(page.getByTestId("input_outputChat Output")).toBeVisible({
    timeout: 30000,
  });
  await page
    .getByTestId("input_outputChat Output")
    .hover()
    .then(async () => {
      await page.getByTestId("add-component-button-chat-output").click();
    });

  await zoomOut(page, 2);

  // Add Chat Input
  await page.getByTestId("sidebar-search-input").fill("chat input");
  await expect(page.getByTestId("input_outputChat Input")).toBeVisible({
    timeout: 30000,
  });
  await page
    .getByTestId("input_outputChat Input")
    .dragTo(page.locator('//*[@id="react-flow-id"]'), {
      targetPosition: { x: 100, y: 100 },
    });

  await adjustScreenView(page);

  // Connect ChatInput → ChatOutput
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

test.describe("Playground Output – Image Upload (ID B0c)", () => {
  test.afterEach(async ({ page }) => {
    await page.goto("/");
    await cleanAllFlows(page);
  });

  test(
    "playground must show image compact preview in input area after attaching an image",
    { tag: ["@regression", "@playground"] },
    async ({ page }) => {
      await test.step(
        "Set up ChatInput → ChatOutput echo flow and open playground",
        async () => {
          await setupChatEchoFlow(page);
          await page.getByTestId("playground-btn-flow-io").click();
          await expect(
            page.getByTestId("input-chat-playground"),
          ).toBeVisible({ timeout: 15000 });
        },
      );

      await test.step(
        "Attach image via hidden file input and verify compact preview appears",
        async () => {
          await page
            .locator('input[type="file"][accept*=".png"]')
            .setInputFiles(IMAGE_PATH);

          await expect(
            page.locator('[data-testid="input-wrapper"] img[alt="chain.png"]'),
          ).toBeVisible({ timeout: 5000 });
        },
      );
    },
  );

  test(
    "playground must display uploaded image in user message after sending",
    { tag: ["@regression", "@playground"] },
    async ({ page }) => {
      await test.step(
        "Set up ChatInput → ChatOutput echo flow and open playground",
        async () => {
          await setupChatEchoFlow(page);
          await page.getByTestId("playground-btn-flow-io").click();
          await expect(
            page.getByTestId("input-chat-playground"),
          ).toBeVisible({ timeout: 15000 });
        },
      );

      await test.step("Attach image and send message", async () => {
        await page
          .locator('input[type="file"][accept*=".png"]')
          .setInputFiles(IMAGE_PATH);

        await expect(
          page.locator('[data-testid="input-wrapper"] img[alt="chain.png"]'),
        ).toBeVisible({ timeout: 5000 });

        await page.getByTestId("button-send").click();
      });

      await test.step(
        "Verify user message contains the uploaded image",
        async () => {
          // div-chat-message is the bot message container; wait for the flow
          // to complete so the full chat history (including user message) is rendered
          await expect(page.getByTestId("div-chat-message")).toBeVisible({
            timeout: 30000,
          });

          // The user message renders files via FilePreviewDisplay (expanded variant).
          // The server prefixes the filename with a timestamp, so we match by
          // src pattern instead of alt: all server-stored images are served
          // from /api/v1/files/images/{flow_id}/{filename}.
          await expect(
            page.locator('img[src*="/files/images/"]'),
          ).toBeVisible({ timeout: 10000 });
        },
      );
    },
  );
});
