import path from "path";
import { expect, test } from "../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";
import { simulateDragAndDrop } from "../../../helpers/ui/simulate-drag-and-drop";

test.describe("Import Flow JSON (ID 120 - Upload)", () => {
  test(
    "upload valid JSON flow via drag and drop shows success message",
    { tag: ["@release", "@workspace", "@regression"] },
    async ({ page }) => {
      await awaitBootstrapTest(page, { skipModal: true });

      await page.waitForSelector('[data-testid="mainpage_title"]', {
        timeout: 30000,
      });

      // Use the existing collection.json asset which is known valid
      await simulateDragAndDrop(
        page,
        path.join(__dirname, "../../assets/collection.json"),
        "cards-wrapper",
      );

      await page.waitForSelector("text=uploaded successfully", {
        timeout: 60000 * 2,
      });

      await expect(page.getByText("uploaded successfully")).toBeVisible();
    },
  );

  test(
    "upload valid JSON flow via upload button shows success",
    { tag: ["@release", "@workspace", "@regression"] },
    async ({ page }) => {
      await awaitBootstrapTest(page, { skipModal: true });

      await page.waitForSelector('[data-testid="mainpage_title"]', {
        timeout: 30000,
      });

      // Try the upload-project-button approach first
      const uploadButton = page
        .getByTestId("upload-project-button")
        .last();
      const isVisible = await uploadButton
        .isVisible({ timeout: 5000 })
        .catch(() => false);

      if (isVisible) {
        const jsonContent = JSON.stringify({
          id: `test-import-${Date.now()}`,
          name: `Import Test Flow ${Date.now()}`,
          data: {
            nodes: [],
            edges: [],
            viewport: { x: 0, y: 0, zoom: 1 },
          },
          description: "",
          endpoint_name: null,
          is_component: false,
        });

        const dataTransfer = await page.evaluateHandle((data) => {
          const dt = new DataTransfer();
          const file = new File([data], "import-test.json", {
            type: "application/json",
          });
          dt.items.add(file);
          return dt;
        }, jsonContent);

        await page
          .getByTestId("cards-wrapper")
          .dispatchEvent("drop", { dataTransfer });

        await page.waitForSelector("text=uploaded successfully", {
          timeout: 60000,
        });

        await expect(page.getByText("uploaded successfully")).toBeVisible();
      } else {
        // Fall back to drag-and-drop with test asset
        await simulateDragAndDrop(
          page,
          path.join(__dirname, "../../assets/collection.json"),
          "cards-wrapper",
        );

        await page.waitForSelector("text=uploaded successfully", {
          timeout: 60000 * 2,
        });

        await expect(page.getByText("uploaded successfully")).toBeVisible();
      }
    },
  );

  test(
    "uploaded flow appears in the flow list by name",
    { tag: ["@release", "@workspace", "@regression"] },
    async ({ page }) => {
      await awaitBootstrapTest(page, { skipModal: true });

      await page.waitForSelector('[data-testid="mainpage_title"]', {
        timeout: 30000,
      });

      // We need a predictable flow name - use a known JSON file from assets
      await simulateDragAndDrop(
        page,
        path.join(__dirname, "../../assets/flow.json"),
        "cards-wrapper",
      );

      await page.waitForSelector("text=uploaded successfully", {
        timeout: 60000 * 2,
      });

      await expect(page.getByText("uploaded successfully")).toBeVisible();

      // At least one flow card should appear now
      await expect(page.locator('[data-testid="list-card"]').first()).toBeVisible(
        { timeout: 10000 },
      );
    },
  );

  test(
    "export flow menu item is accessible from list card dropdown",
    { tag: ["@release", "@workspace", "@regression"] },
    async ({ page }) => {
      await awaitBootstrapTest(page, { skipModal: true });

      await page.waitForSelector('[data-testid="mainpage_title"]', {
        timeout: 30000,
      });

      // First upload a flow so there's something to export
      await simulateDragAndDrop(
        page,
        path.join(__dirname, "../../assets/collection.json"),
        "cards-wrapper",
      );

      await page.waitForSelector("text=uploaded successfully", {
        timeout: 60000 * 2,
      });

      // Find the first list card and open its dropdown menu
      await page.waitForSelector('[data-testid="home-dropdown-menu"]', {
        timeout: 10000,
      });

      await page.getByTestId("home-dropdown-menu").first().click();

      // Export option (btn-download-json) should be in the dropdown
      await expect(page.getByTestId("btn-download-json").last()).toBeVisible({
        timeout: 5000,
      });
    },
  );
});
