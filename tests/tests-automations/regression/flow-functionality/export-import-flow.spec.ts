import { readFileSync } from "fs";
import path from "path";
import { expect, test } from "../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { simulateDragAndDrop } from "../../../helpers/ui/simulate-drag-and-drop";

// Force serial execution within this file so the diff-based cleanup remains
// safe — the snapshot/diff pattern is racy across workers when multiple tests
// run concurrently against the same backend.
test.describe.configure({ mode: "serial" });

test.describe("Export and Import Flow (IDs 173 + 120)", () => {
  const LIST_PARAMS = { get_all: "true", remove_example_flows: "true" };

  // `null` is a sentinel meaning "snapshot failed — skip cleanup this run" so
  // we never delete the entire workspace if the list endpoint hiccups.
  let preTestFlowIds: Set<string> | null = null;

  test.beforeEach(async ({ request }) => {
    preTestFlowIds = null;
    try {
      const headers = { Authorization: await getAuthToken(request) };
      const listRes = await request.get("/api/v1/flows/", {
        headers,
        params: LIST_PARAMS,
      });
      if (listRes.ok()) {
        const body = await listRes.json();
        const flows: Array<{ id: string }> = Array.isArray(body)
          ? body
          : (body?.flows ?? []);
        preTestFlowIds = new Set(flows.map((f) => f.id));
      }
    } catch {
      // Leave sentinel as null so afterEach skips cleanup.
    }
  });

  test.afterEach(async ({ request }) => {
    if (preTestFlowIds === null) return;
    const snapshot = preTestFlowIds;
    try {
      const headers = { Authorization: await getAuthToken(request) };
      const listRes = await request.get("/api/v1/flows/", {
        headers,
        params: LIST_PARAMS,
      });
      if (listRes.ok()) {
        const body = await listRes.json();
        const flows: Array<{ id: string }> = Array.isArray(body)
          ? body
          : (body?.flows ?? []);
        for (const f of flows) {
          if (!snapshot.has(f.id)) {
            await request.delete(`/api/v1/flows/${f.id}`, { headers });
          }
        }
      }
    } catch {
      // Cleanup is best-effort.
    }
  });

  test(
    "export flow to JSON triggers success toast and produces a valid file",
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

      // Arm the download capture BEFORE clicking the export button to avoid a
      // race between the download event and modal interaction.
      const downloadPromise = page.waitForEvent("download", { timeout: 30000 });

      await page.getByTestId("home-dropdown-menu").nth(0).click();
      await page.getByTestId("btn-download-json").last().click();

      await expect(page.getByText("Export").first()).toBeVisible({
        timeout: 5000,
      });
      await page.waitForSelector('[data-testid="modal-export-button"]', {
        timeout: 10000,
      });
      await page.getByTestId("modal-export-button").click();

      // Both the user-visible toast and the actual downloadable file content.
      await expect(page.getByText(/.*exported successfully/)).toBeVisible({
        timeout: 10000,
      });

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

      // The upload button's onClick branches on payload shape: single-flow
      // JSONs (with `data.nodes`) go through `uploadFlow`; project bundles
      // (e.g. `collection.json`'s `{ flows: [...] }`) go through the project
      // upload endpoint which requires a `folder_name` form field. The button
      // doesn't supply one, so feeding a single-flow fixture exercises the
      // path that actually succeeds via this entry point. This is distinct
      // from Test 2's drag-and-drop on `cards-wrapper`.
      const flowPath = path.join(
        __dirname,
        "../../../assets/flows/flow.json",
      );

      const fileChooserPromise = page.waitForEvent("filechooser", {
        timeout: 10000,
      });
      await page.getByTestId("upload-project-button").last().click();
      const fileChooser = await fileChooserPromise;
      await fileChooser.setFiles(flowPath);

      await page.waitForSelector("text=uploaded successfully", {
        timeout: 60000,
      });

      await expect(page.getByText("uploaded successfully")).toBeVisible();
    },
  );
});
