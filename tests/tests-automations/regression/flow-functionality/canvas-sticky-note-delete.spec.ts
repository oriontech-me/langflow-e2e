import { expect, test } from "../../../fixtures/fixtures";
import { adjustScreenView } from "../../../helpers/ui/adjust-screen-view";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";

test(
  "delete sticky note removes it from canvas",
  { tag: ["@release", "@workspace", "@regression"] },
  async ({ page }) => {
    await awaitBootstrapTest(page);

    await page.waitForSelector('[data-testid="blank-flow"]', { timeout: 30000 });
    await page.getByTestId("blank-flow").click();

    // Add a sticky note via the sidebar add_note button
    await page.getByTestId("sidebar-nav-add_note").click();
    const canvas = page.locator('//*[@id="react-flow-id"]');
    await canvas.click();
    await page.mouse.up();
    await page.mouse.down();

    await adjustScreenView(page, { numberOfZoomOut: 4 });

    // Verify note is on canvas
    await expect(page.getByTestId("note_node")).toBeVisible({ timeout: 5000 });

    // Select the note by clicking it
    await page.getByTestId("note_node").click();
    await page.waitForTimeout(300);

    // Delete via keyboard Delete key
    await page.keyboard.press("Delete");
    await page.waitForTimeout(1000);

    // Note must be gone
    await expect(page.getByTestId("note_node")).toHaveCount(0, {
      timeout: 5000,
    });
  },
);

test(
  "delete sticky note via Backspace key",
  { tag: ["@release", "@workspace", "@regression"] },
  async ({ page }) => {
    await awaitBootstrapTest(page);

    await page.waitForSelector('[data-testid="blank-flow"]', { timeout: 30000 });
    await page.getByTestId("blank-flow").click();

    // Add a sticky note
    await page.getByTestId("sidebar-nav-add_note").click();
    const canvas = page.locator('//*[@id="react-flow-id"]');
    await canvas.click();
    await page.mouse.up();
    await page.mouse.down();

    await adjustScreenView(page, { numberOfZoomOut: 4 });

    await expect(page.getByTestId("note_node")).toBeVisible({ timeout: 5000 });

    // Click on the note to select
    await page.getByTestId("note_node").click();
    await page.waitForTimeout(300);

    // Delete via Backspace
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(1000);

    await expect(page.getByTestId("note_node")).toHaveCount(0, {
      timeout: 5000,
    });
  },
);

test(
  "multiple sticky notes can be added and deleted independently",
  { tag: ["@release", "@workspace", "@regression"] },
  async ({ page }) => {
    await awaitBootstrapTest(page);

    await page.waitForSelector('[data-testid="blank-flow"]', { timeout: 30000 });
    await page.getByTestId("blank-flow").click();

    // Add first note
    await page.getByTestId("sidebar-nav-add_note").click();
    await page.locator('//*[@id="react-flow-id"]').click();
    await page.mouse.up();
    await page.mouse.down();

    await adjustScreenView(page, { numberOfZoomOut: 4 });
    await expect(page.getByTestId("note_node")).toHaveCount(1, {
      timeout: 5000,
    });

    // Add second note
    await page.getByTestId("sidebar-nav-add_note").click();
    await page.locator('//*[@id="react-flow-id"]').click({ position: { x: 300, y: 200 } });
    await page.mouse.up();
    await page.mouse.down();

    await page.waitForTimeout(500);

    // Both notes must be present before deletion
    await expect(page.getByTestId("note_node")).toHaveCount(2, {
      timeout: 5000,
    });
    const noteCount = await page.getByTestId("note_node").count();

    // Delete one note
    await page.getByTestId("note_node").first().click();
    await page.waitForTimeout(300);
    await page.keyboard.press("Delete");
    await page.waitForTimeout(1000);

    // Exactly one note must remain after deleting one of two
    await expect(page.getByTestId("note_node")).toHaveCount(noteCount - 1, {
      timeout: 5000,
    });
  },
);
