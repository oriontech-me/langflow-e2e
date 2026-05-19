import { readFileSync } from "fs";
import path from "path";
import { expect, test } from "../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { simulateDragAndDrop } from "../../../helpers/ui/simulate-drag-and-drop";

test.describe("Export and Import Flow (IDs 173 + 120)", () => {
  let preTestFlowIds: Set<string> = new Set();

  test.beforeEach(async ({ request }) => {
    try {
      const headers = { Authorization: await getAuthToken(request) };
      const listRes = await request.get("/api/v1/flows/", { headers });
      if (listRes.ok()) {
        const body = await listRes.json();
        const items = Array.isArray(body) ? body : (body?.items ?? []);
        preTestFlowIds = new Set(items.map((f: any) => f.id));
      }
    } catch {
      preTestFlowIds = new Set();
    }
  });

  test.afterEach(async ({ request }) => {
    try {
      const headers = { Authorization: await getAuthToken(request) };
      const listRes = await request.get("/api/v1/flows/", { headers });
      if (listRes.ok()) {
        const body = await listRes.json();
        const items = Array.isArray(body) ? body : (body?.items ?? []);
        for (const f of items) {
          if (!preTestFlowIds.has(f.id)) {
            await request.delete(`/api/v1/flows/${f.id}`, { headers });
          }
        }
      }
    } catch {
      // Cleanup is best-effort.
    }
  });

  test(
    "export flow to JSON must trigger success message",
    { tag: ["@stable", "@release", "@workspace", "@api", "@regression"] },
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

      await expect(page.getByText("Export").first()).toBeVisible({
        timeout: 5000,
      });
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
    { tag: ["@stable", "@release", "@workspace", "@api", "@regression"] },
    async ({ page }) => {
      await awaitBootstrapTest(page, { skipModal: true });

      await page.waitForSelector('[data-testid="mainpage_title"]', {
        timeout: 30000,
      });

      await simulateDragAndDrop(
        page,
        path.join(__dirname, "../../../assets/flows/collection.json"),
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
    { tag: ["@stable", "@release", "@workspace", "@api", "@regression"] },
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

      const downloadPromise = page.waitForEvent("download", { timeout: 30000 });

      await page.getByTestId("home-dropdown-menu").nth(0).click();
      await page.getByTestId("btn-download-json").last().click();
      await page.waitForSelector('[data-testid="modal-export-button"]', {
        timeout: 10000,
      });
      await page.getByTestId("modal-export-button").click();

      const download = await downloadPromise;
      const filePath = await download.path();
      expect(filePath).toBeTruthy();

      const content = readFileSync(filePath!, "utf-8");
      const parsed = JSON.parse(content);
      expect(parsed).toHaveProperty("data");
      expect(parsed.data).toHaveProperty("nodes");
      expect(Array.isArray(parsed.data.nodes)).toBeTruthy();
      expect(parsed.data.nodes.length).toBeGreaterThan(0);
    },
  );

  test(
    "import flow from JSON via upload button must load flow on canvas",
    { tag: ["@stable", "@release", "@workspace", "@api", "@regression"] },
    async ({ page }) => {
      await awaitBootstrapTest(page, { skipModal: true });

      await page.waitForSelector('[data-testid="mainpage_title"]', {
        timeout: 30000,
      });

      await expect(page.getByTestId("upload-project-button").last()).toBeVisible({
        timeout: 10000,
      });

      const jsonContent = readFileSync(
        path.join(__dirname, "../../../assets/flows/collection.json"),
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
    },
  );
});
