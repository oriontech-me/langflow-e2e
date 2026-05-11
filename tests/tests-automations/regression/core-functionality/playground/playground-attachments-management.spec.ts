import path from "path";
import type { Page } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { setupPlayground } from "../../../../helpers/flows/setup-playground";

const IMAGE_A = path.resolve(
  __dirname,
  "../../../../assets/media/chain.png",
);
const IMAGE_B = path.resolve(
  __dirname,
  "../../../../assets/media/chain-2.png",
);

const fileInput = (page: Page) =>
  page.locator('[data-testid="input-wrapper"] input[type="file"]');

const previewImage = (page: Page, fileName: string) =>
  page.locator(`[data-testid="input-wrapper"] img[alt="${fileName}"]`);

const previewDeleteButton = (page: Page) =>
  page.locator(
    '[data-testid="input-wrapper"] button[aria-label="Delete file"]',
  );

test.describe("Playground — Chat Input Attachments Management", () => {
  test.describe.configure({ mode: "serial" });

  let createdFlowId: string | null = null;

  test.afterEach(async ({ page }) => {
    if (createdFlowId) {
      await page.goto("/");
      await page.request.delete(`/api/v1/flows/${createdFlowId}`);
      createdFlowId = null;
    }
  });

  const openPlayground = async (page: Page) => {
    createdFlowId = await setupPlayground(page);
    await page.getByTestId("playground-btn-flow-io").click();
    await expect(page.getByTestId("input-chat-playground")).toBeVisible({
      timeout: 15000,
    });
  };

  const attach = async (page: Page, image: string, alt: string) => {
    await fileInput(page).setInputFiles(image);
    await expect(previewImage(page, alt)).toBeVisible({ timeout: 10000 });
  };

  test(
    "playground must show one compact preview per attached image when two images are attached",
    { tag: ["@stable", "@regression", "@playground", "@components"] },
    async ({ page }) => {
      await test.step(
        "Set up ChatInput → ChatOutput echo flow and open playground",
        async () => {
          await openPlayground(page);
        },
      );

      await test.step(
        "Attach two images sequentially and verify both previews remain",
        async () => {
          await attach(page, IMAGE_A, "chain.png");
          await attach(page, IMAGE_B, "chain-2.png");

          await expect(previewImage(page, "chain.png")).toBeVisible();
          await expect(previewImage(page, "chain-2.png")).toBeVisible();
          await expect(previewDeleteButton(page)).toHaveCount(2);
        },
      );
    },
  );

  test(
    "playground must keep the remaining preview when one of two attachments is removed",
    { tag: ["@stable", "@regression", "@playground", "@components"] },
    async ({ page }) => {
      await test.step(
        "Set up flow, open playground and attach two images",
        async () => {
          await openPlayground(page);
          await attach(page, IMAGE_A, "chain.png");
          await attach(page, IMAGE_B, "chain-2.png");
        },
      );

      await test.step(
        "Remove the chain.png preview via its X button",
        async () => {
          await page
            .locator(
              '[data-testid="input-wrapper"] div:has(> img[alt="chain.png"]) button[aria-label="Delete file"]',
            )
            .click();
        },
      );

      await test.step(
        "First preview is gone; second preview stays",
        async () => {
          await expect(previewImage(page, "chain.png")).toHaveCount(0);
          await expect(previewImage(page, "chain-2.png")).toBeVisible();
          await expect(previewDeleteButton(page)).toHaveCount(1);
        },
      );
    },
  );

  test(
    "playground must render both attached images in the user message after sending",
    { tag: ["@stable", "@regression", "@playground", "@components"] },
    async ({ page }) => {
      await test.step(
        "Set up flow, open playground and attach two images",
        async () => {
          await openPlayground(page);
          await attach(page, IMAGE_A, "chain.png");
          await attach(page, IMAGE_B, "chain-2.png");
        },
      );

      await test.step("Send the message", async () => {
        await page.getByTestId("button-send").click();
      });

      await test.step(
        "Bot responds and both images render from the server in the user message",
        async () => {
          await expect(page.getByTestId("div-chat-message")).toBeVisible({
            timeout: 30000,
          });
          await expect(
            page.locator('img[src*="/files/images/"][src$="chain.png"]'),
          ).toBeVisible({ timeout: 10000 });
          await expect(
            page.locator('img[src*="/files/images/"][src$="chain-2.png"]'),
          ).toBeVisible({ timeout: 10000 });
        },
      );
    },
  );

  test(
    "playground input must return to empty state after removing the only attachment",
    { tag: ["@stable", "@regression", "@playground", "@components"] },
    async ({ page }) => {
      await test.step(
        "Set up flow, open playground and attach a single image",
        async () => {
          await openPlayground(page);
          await attach(page, IMAGE_A, "chain.png");
        },
      );

      await test.step(
        "Remove the only attachment and confirm input has no preview",
        async () => {
          await previewDeleteButton(page).click();
          await expect(previewImage(page, "chain.png")).toHaveCount(0);
          await expect(previewDeleteButton(page)).toHaveCount(0);
          await expect(page.getByTestId("button-send")).toBeEnabled();
        },
      );

      await test.step(
        "Send a plain text message — no orphan attachment and round-trip works",
        async () => {
          await page.getByTestId("input-chat-playground").fill("hello");
          await page.getByTestId("button-send").click();
          await expect(page.getByTestId("div-chat-message")).toBeVisible({
            timeout: 30000,
          });
          await expect(
            page.locator('img[src*="/files/images/"]'),
          ).toHaveCount(0);
        },
      );
    },
  );

  test(
    "playground swap flow must send only the second image when the first is removed before attaching the second",
    { tag: ["@stable", "@regression", "@playground", "@components"] },
    async ({ page }) => {
      await test.step(
        "Set up flow, open playground and attach image A",
        async () => {
          await openPlayground(page);
          await attach(page, IMAGE_A, "chain.png");
        },
      );

      await test.step(
        "Remove image A, then attach image B (composite swap)",
        async () => {
          await previewDeleteButton(page).click();
          await expect(previewImage(page, "chain.png")).toHaveCount(0);
          await attach(page, IMAGE_B, "chain-2.png");
        },
      );

      await test.step("Send the message", async () => {
        await page.getByTestId("button-send").click();
      });

      await test.step(
        "Only image B is rendered in the user message; image A is absent",
        async () => {
          await expect(page.getByTestId("div-chat-message")).toBeVisible({
            timeout: 30000,
          });
          await expect(
            page.locator('img[src*="/files/images/"][src$="chain-2.png"]'),
          ).toBeVisible({ timeout: 10000 });
          await expect(
            page.locator('img[src*="/files/images/"][src$="_chain.png"]'),
          ).toHaveCount(0);
        },
      );
    },
  );
});
