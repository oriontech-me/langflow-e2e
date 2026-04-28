import path from "path";
import { expect, test } from "../../../../fixtures/fixtures";
import { setupPlayground } from "../../../../helpers/flows/setup-playground";

// The server prefixes uploaded filenames with a timestamp, so alt becomes e.g.
// "2026-03-22_20-09-16_chain.png". Match by src path instead of alt.
const IMAGE_PATH = path.resolve(
  __dirname,
  "../../../../assets/media/chain.png",
);

test.describe("Playground Output – Image Upload (ID B0c)", () => {
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
    "playground must show image compact preview in input area after attaching an image",
    { tag: ["@regression", "@playground"] },
    async ({ page }) => {
      await test.step(
        "Set up ChatInput → ChatOutput echo flow and open playground",
        async () => {
          createdFlowId = await setupPlayground(page);
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
            .locator('[data-testid="input-wrapper"] input[type="file"]')
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
          createdFlowId = await setupPlayground(page);
          await page.getByTestId("playground-btn-flow-io").click();
          await expect(
            page.getByTestId("input-chat-playground"),
          ).toBeVisible({ timeout: 15000 });
        },
      );

      await test.step("Attach image and send message", async () => {
        await page
          .locator('[data-testid="input-wrapper"] input[type="file"]')
          .setInputFiles(IMAGE_PATH);

        await expect(
          page.locator('[data-testid="input-wrapper"] img[alt="chain.png"]'),
        ).toBeVisible({ timeout: 5000 });

        await page.getByTestId("button-send").click();
      });

      await test.step(
        "Verify user message contains the uploaded image",
        async () => {
          // Wait for bot response — confirms the full chat history including user message is rendered
          await expect(page.getByTestId("div-chat-message")).toBeVisible({
            timeout: 30000,
          });

          await expect(
            page.locator('img[src*="/files/images/"]'),
          ).toBeVisible({ timeout: 10000 });
        },
      );
    },
  );
});
