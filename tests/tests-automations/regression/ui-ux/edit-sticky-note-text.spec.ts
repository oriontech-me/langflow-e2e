import { expect, test } from "../../../fixtures/fixtures";
import { setupBlankFlow } from "../../../helpers/flows/setup-blank-flow";
import { adjustScreenView } from "../../../helpers/ui/adjust-screen-view";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";
import { deleteFlow } from "../../../helpers/flows/delete-flow";

test.describe("Sticky Note — Edit Text", () => {
  let flowId = "";

  test.afterEach(async ({ page }) => {
    // Delete the flow created during this test so it does not pollute the
    // instance for subsequent runs.
    if (flowId) {
      await deleteFlow(page.request, flowId);
    }
  });

  test(
    "user can edit the text of an existing sticky note and the canvas reflects only the new text",
    { tag: ["@release", "@workspace", "@stable"] },
    async ({ page }) => {
      await test.step("set up blank canvas", async () => {
        // Bootstrap the Langflow dashboard before creating the flow
        await awaitBootstrapTest(page, { skipModal: true });

        flowId = await setupBlankFlow(page);

        // Zoom out so the note node fits comfortably in the viewport
        await adjustScreenView(page, { numberOfZoomOut: 3 });
      });

      await test.step("add sticky note and fill initial text", async () => {
        // Click the canvas toolbar button to add a sticky note
        await page.getByTestId("canvas-add-note-button").click();

        // The note is placed on the canvas immediately after the button click
        await expect(page.getByTestId("note_node")).toBeVisible({
          timeout: 10000,
        });

        // Verify the note description area is visible before editing
        await expect(page.getByTestId("generic-node-desc")).toBeVisible({
          timeout: 10000,
        });

        // Enter edit mode by double-clicking the note description area
        await page.getByTestId("generic-node-desc").dblclick();

        // Wait for the edit textarea to appear
        await expect(page.getByTestId("textarea")).toBeVisible({
          timeout: 10000,
        });

        // Confirm the textarea is empty on a fresh note
        await expect(page.getByTestId("textarea")).toHaveValue("", {
          timeout: 5000,
        });

        // Type the initial content
        await page.getByTestId("textarea").fill("Original note content");

        await expect(page.getByTestId("textarea")).toHaveValue(
          "Original note content",
          { timeout: 5000 },
        );

        // Commit the note: click the canvas background then press Escape
        await page.getByTestId("rf__wrapper").click();
        await page.keyboard.press("Escape");

        // Textarea must be gone before proceeding
        await expect(page.getByTestId("textarea")).toHaveCount(0, {
          timeout: 10000,
        });

        // The rendered note must display the committed text
        const initialRendered = await page
          .getByTestId("generic-node-desc")
          .innerText();
        expect(initialRendered).toContain("Original note content");
      });

      await test.step("reopen the populated note and replace its text", async () => {
        // Re-enter edit mode on the already-populated note
        await page.getByTestId("generic-node-desc").dblclick();

        // Textarea must reappear with the existing text pre-loaded
        await expect(page.getByTestId("textarea")).toBeVisible({
          timeout: 10000,
        });
        await expect(page.getByTestId("textarea")).toHaveValue(
          "Original note content",
          { timeout: 5000 },
        );

        // Replace the content with the new text (clear first, then fill)
        await page.getByTestId("textarea").clear();
        await page.getByTestId("textarea").fill("Edited note content");

        await expect(page.getByTestId("textarea")).toHaveValue(
          "Edited note content",
          { timeout: 5000 },
        );

        // Commit the edited note: click the canvas background then press Escape
        await page.getByTestId("rf__wrapper").click();
        await page.keyboard.press("Escape");

        // Textarea must be gone before asserting the rendered result
        await expect(page.getByTestId("textarea")).toHaveCount(0, {
          timeout: 10000,
        });
      });

      await test.step("verify the canvas shows only the new text", async () => {
        // Capture what the rendered note displays after the edit
        const rendered = await page
          .getByTestId("generic-node-desc")
          .innerText();

        // The new text must be present …
        expect(rendered).toContain("Edited note content");
        // … and the old text must be absent — proving replace, not append
        expect(rendered).not.toContain("Original note content");
      });
    },
  );
});
