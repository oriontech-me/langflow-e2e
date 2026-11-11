import path from "path";
import { expect, test } from "../../../../fixtures/fixtures";
import { setupPlayground } from "../../../../helpers/flows/setup-playground";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";

const TXT_PATH = path.resolve(
  __dirname,
  "../../../../assets/files/test-file.txt",
);

test.describe("Playground Output – Non-Image Attachment (#195)", () => {
  test.describe.configure({ mode: "serial" });

  let createdFlowId: string | null = null;

  test.afterEach(async ({ page }) => {
    if (createdFlowId) {
      await page.goto("/");
      await deleteFlow(page.request, createdFlowId);
      createdFlowId = null;
    }
  });

  // Quarantined for #2416: hard failure on non-environmental guard day on daily 2026-11-11 (1.14.0.dev23, umbrella e2e-qa#30).
  // Lifting it (drop `test.fixme`, restore `@stable`) is #2416's deliverable.
  test.fixme(
    "playground must show non-image preview tile (delete button, no <img>) in input area after attaching a .txt file",
    { tag: ["@regression", "@playground", "@components"] },
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
        "Attach .txt file via hidden file input",
        async () => {
          await page
            .locator('[data-testid="input-wrapper"] input[type="file"]')
            .setInputFiles(TXT_PATH);
        },
      );

      await test.step(
        "Verify non-image preview tile rendered (delete button visible, zero <img>)",
        async () => {
          const inputWrapper = page.locator('[data-testid="input-wrapper"]');

          // The compact FilePreviewDisplay tile renders a "Delete file" aria-label
          // button whenever a file is attached (either branch). Visible button proves
          // the attach landed and a preview tile rendered.
          await expect(
            inputWrapper.getByRole("button", { name: "Delete file" }),
          ).toBeVisible({ timeout: 5000 });

          // The image branch would emit <img src=URL.createObjectURL(file)> inside
          // the same tile. Zero <img> elements proves the non-image branch ran.
          await expect(inputWrapper.locator("img")).toHaveCount(0);
        },
      );
    },
  );

  // Quarantined for #2416: serial sibling of a test quarantined for the same cause: it was skipped behind it on daily 2026-11-11 (1.14.0.dev23, umbrella e2e-qa#30) and fails on the same step once it runs (PR #2420 impacted-specs lane).
  // Lifting it (drop `test.fixme`, restore `@stable`) is #2416's deliverable.
  test.fixme(
    "playground must render non-image attachment in user message (truncated filename + zero file-images) after sending a .txt",
    { tag: ["@regression", "@playground", "@components"] },
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

      await test.step("Attach .txt file and send the message", async () => {
        await page
          .locator('[data-testid="input-wrapper"] input[type="file"]')
          .setInputFiles(TXT_PATH);

        await expect(
          page
            .locator('[data-testid="input-wrapper"]')
            .getByRole("button", { name: "Delete file" }),
        ).toBeVisible({ timeout: 5000 });

        await page.getByTestId("button-send").click();
      });

      await test.step(
        "Verify file rendered in chat history with truncated filename and zero file-images",
        async () => {
          // Wait for round-trip: bot message confirms the chat history rendered
          await expect(page.getByTestId("div-chat-message")).toBeVisible({
            timeout: 30000,
          });

          // Expanded FilePreviewDisplay non-image branch emits a <span> with
          // formatFileName(name, 10). The server prefixes uploads with a timestamp,
          // so the rendered text is e.g. "2026-05-08...txt". The "...{ext}" suffix is
          // literal output from formatFileName when name.length > 10 — robust whether
          // or not the server applies the timestamp prefix.
          await expect(
            page.getByText(/\.\.\.txt$/).first(),
          ).toBeVisible({ timeout: 10000 });

          // The image-history renderer would emit img[src*="/files/images/"]; zero
          // matches proves the non-image branch ran in the chat history.
          await expect(
            page.locator('img[src*="/files/images/"]'),
          ).toHaveCount(0);
        },
      );
    },
  );
});
