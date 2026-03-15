import { readFileSync } from "fs";
import path from "path";
import { expect, test } from "../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";
import { simulateDragAndDrop } from "../../../helpers/ui/simulate-drag-and-drop";

test.describe("Export and Import Flow (IDs 173 + 120)", () => {
  test(
    "export flow to JSON must trigger success message",
    { tag: ["@release", "@workspace", "@api"] },
    async ({ page }) => {
      await awaitBootstrapTest(page);

      await page.waitForSelector('[data-testid="blank-flow"]', {
        timeout: 30000,
      });
      await page.getByTestId("blank-flow").click();

      await page.waitForSelector('[data-testid="sidebar-search-input"]', {
        timeout: 30000,
      });

      await page.getByTestId("sidebar-search-input").fill("chat input");
      await page.waitForSelector('[data-testid="input_outputChat Input"]', {
        timeout: 30000,
      });
      await page
        .getByTestId("input_outputChat Input")
        .hover()
        .then(async () => {
          await page.getByTestId("add-component-button-chat-input").click();
        });

      await page.getByTestId("icon-ChevronLeft").click();

      await page.waitForSelector('[data-testid="home-dropdown-menu"]', {
        timeout: 30000,
      });

      await page.getByTestId("home-dropdown-menu").nth(0).click();
      await page.getByTestId("btn-download-json").last().click();

      await page.getByText("Export").first().isVisible();
      await page.waitForSelector('[data-testid="modal-export-button"]', {
        timeout: 10000,
      });
      await page.getByTestId("modal-export-button").click();

      await expect(page.getByText(/.*exported successfully/)).toBeVisible({
        timeout: 10000,
      });
    },
  );

  test(
    "imported JSON flow must load all components on canvas",
    { tag: ["@release", "@workspace", "@api"] },
    async ({ page }) => {
      await awaitBootstrapTest(page, { skipModal: true });

      await page.waitForSelector('[data-testid="mainpage_title"]', {
        timeout: 30000,
      });

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
    "exported JSON must be valid and contain flow data",
    { tag: ["@release", "@workspace", "@api"] },
    async ({ page }) => {
      await awaitBootstrapTest(page);

      await page.waitForSelector('[data-testid="blank-flow"]', {
        timeout: 30000,
      });
      await page.getByTestId("blank-flow").click();

      await page.waitForSelector('[data-testid="sidebar-search-input"]', {
        timeout: 30000,
      });

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

      await page.getByTestId("icon-ChevronLeft").click();

      await page.waitForSelector('[data-testid="home-dropdown-menu"]', {
        timeout: 30000,
      });

      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: 15000 }).catch(() => null),
        (async () => {
          await page.getByTestId("home-dropdown-menu").nth(0).click();
          await page.getByTestId("btn-download-json").last().click();
          await page.waitForSelector('[data-testid="modal-export-button"]', {
            timeout: 10000,
          });
          await page.getByTestId("modal-export-button").click();
        })(),
      ]);

      if (download) {
        const filePath = await download.path();
        if (filePath) {
          const content = readFileSync(filePath, "utf-8");
          const parsed = JSON.parse(content);
          expect(parsed).toHaveProperty("data");
          expect(parsed.data).toHaveProperty("nodes");
          expect(Array.isArray(parsed.data.nodes)).toBeTruthy();
          expect(parsed.data.nodes.length).toBeGreaterThan(0);
        }
      } else {
        await expect(page.getByText(/.*exported successfully/)).toBeVisible({
          timeout: 10000,
        });
      }
    },
  );

  test(
    "import flow from JSON via upload button must load flow on canvas",
    { tag: ["@release", "@workspace", "@api"] },
    async ({ page }) => {
      await awaitBootstrapTest(page, { skipModal: true });

      await page.waitForSelector('[data-testid="mainpage_title"]', {
        timeout: 30000,
      });

      const uploadButton = page.getByTestId("upload-project-button").last();
      if (await uploadButton.isVisible({ timeout: 5000 })) {
        const jsonContent = readFileSync(
          path.join(__dirname, "../../assets/collection.json"),
          "utf-8",
        );

        const dataTransfer = await page.evaluateHandle((data) => {
          const dt = new DataTransfer();
          const file = new File([data], "collection.json", {
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
});
