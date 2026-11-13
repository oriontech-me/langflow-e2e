import path from "path";
import { expect, test } from "../../../../fixtures/fixtures";
import { setupPlayground } from "../../../../helpers/flows/setup-playground";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";

const TXT_PATH = path.resolve(
  __dirname,
  "../../../../assets/files/test-file.txt",
);

// The delete button's accessible name, matched by its "Delete " prefix.
// langflow-ai/langflow#16277 (first shipped in 1.14.0.dev23) turned it from
// "Delete file" into "Delete <file name>"; the exact "Delete file" match found
// nothing (#2416). main and the 1.13.x line still say "Delete file", and the
// prefix holds on both.
const DELETE_BUTTON_NAME = /^Delete /;

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

  test(
    "playground must show non-image preview tile (delete button, no <img>) in input area after attaching a .txt file",
    { tag: ["@stable", "@regression", "@playground", "@components"] },
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

          // The compact FilePreviewDisplay tile renders a delete button whenever a
          // file is attached (either branch). Visible button proves the attach
          // landed and a preview tile rendered.
          await expect(
            inputWrapper.getByRole("button", { name: DELETE_BUTTON_NAME }),
          ).toBeVisible({ timeout: 5000 });

          // Positive marker of the non-image branch. While the upload is in flight
          // the tile shows a spinner (input-wrapper passes `loading`) with the
          // delete button already visible and no <img> yet, so the zero-<img>
          // count below is, on its own, satisfied by an IMAGE attachment too —
          // measured in #2416 by attaching chain.png. The File icon renders only
          // once loading cleared and the non-image branch was taken. Scoped to
          // the tile (the div whose direct child is the delete button) because on
          // the 1.13.x line the attach button also renders icon-File.
          const tile = inputWrapper.locator(
            'div:has(> button[aria-label^="Delete "])',
          );
          await expect(tile.getByTestId("icon-File")).toBeVisible({
            timeout: 10000,
          });

          // With the tile resolved, the image branch would have emitted
          // <img src=URL.createObjectURL(file)>; zero <img> proves it did not run.
          await expect(inputWrapper.locator("img")).toHaveCount(0);
        },
      );
    },
  );

  test(
    "playground must render non-image attachment in user message (truncated filename + zero file-images) after sending a .txt",
    { tag: ["@stable", "@regression", "@playground", "@components"] },
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
            .getByRole("button", { name: DELETE_BUTTON_NAME }),
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

          // Since #16277 the input tile renders its own truncated name
          // (formatFileName(name, 6) -> "test-f...txt"), which also ends in
          // "...txt". The user message bubble has no data-testid to scope to, so
          // prove the attachment left the input first: after that, a page-wide
          // "...txt" can only be the sent message. Without this, the assert
          // below passes on the input tile alone.
          const inputWrapper = page.locator('[data-testid="input-wrapper"]');
          await expect(
            inputWrapper.getByRole("button", { name: DELETE_BUTTON_NAME }),
          ).toHaveCount(0);
          await expect(inputWrapper.getByText(/\.\.\.txt$/)).toHaveCount(0);

          // Expanded FilePreviewDisplay non-image branch emits a <span> with
          // formatFileName(name, 10). From 1.14.0.dev23 the display drops the
          // server's upload timestamp prefix ("test-file...txt"); before, it read
          // e.g. "2026-05-08...txt". The "...{ext}" suffix is literal output from
          // formatFileName when name.length > 10 — robust on both.
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
