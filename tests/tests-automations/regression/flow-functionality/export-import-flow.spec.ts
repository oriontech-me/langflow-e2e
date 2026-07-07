import { readFileSync } from "fs";
import path from "path";
import type { Page } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { simulateDragAndDrop } from "../../../helpers/ui/simulate-drag-and-drop";
import { deleteFlow } from "../../../helpers/flows/delete-flow";

// Serial so the three tests share the created-flow tracker safely within
// this file.
test.describe.configure({ mode: "serial" });

test.describe("Export and Import Flow (IDs 173 + 120)", () => {
  // Ids of flows created by THIS page's own requests, collected from the
  // flow-creating POST responses and deleted one by one in afterEach. The
  // previous diff-based cleanup (snapshot the list, delete the difference)
  // deleted any flow a PARALLEL worker created during the test window — the
  // cross-worker destructive-cleanup class from #553.
  let createdFlowIds: string[] = [];

  const trackFlowCreations = (page: Page) => {
    page.on("response", async (resp) => {
      if (
        !resp.url().includes("/api/v1/flows") ||
        resp.request().method() !== "POST" ||
        !resp.ok()
      ) {
        return;
      }
      try {
        const body = await resp.json();
        const items = Array.isArray(body) ? body : (body?.flows ?? [body]);
        for (const item of items) {
          if (item?.id) createdFlowIds.push(item.id);
        }
      } catch {
        // Non-JSON response — nothing to track.
      }
    });
  };

  test.beforeEach(async ({ page }) => {
    createdFlowIds = [];
    trackFlowCreations(page);
  });

  test.afterEach(async ({ request }) => {
    const headers = { Authorization: await getAuthToken(request) };
    for (const id of createdFlowIds) {
      // Best-effort per-flow so one failure does not abort the sweep.
      await deleteFlow(request, id, { headers }).catch(() => {});
    }
    createdFlowIds = [];
  });

  test(
    "export flow to JSON triggers success toast and produces a valid file",
    { tag: ["@stable", "@release", "@workspace", "@api", "@regression"] },
    async ({ page, request }) => {
      await awaitBootstrapTest(page);

      await page.waitForSelector('[data-testid="blank-flow"]', {
        timeout: 30000,
      });

      // Capture the created flow's id from the creation response — the only
      // reliable handle for picking the right home card later (#518).
      const flowCreationPromise = page.waitForResponse(
        (resp) =>
          resp.url().includes("/api/v1/flows") &&
          resp.request().method() === "POST" &&
          resp.status() === 201,
        { timeout: 15000 },
      );
      await page.getByTestId("blank-flow").click();
      const flowId = ((await flowCreationPromise.then((r) => r.json())) as { id?: string })
        .id;
      expect(flowId, "flow creation response must include an id").toBeTruthy();

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

      // Server-truth guard: poll the flow by id until the node-add autosave is
      // PERSISTED. The previous quiet-window guard (`waitForFlowSaveSettled`,
      // #384) resolves after 700ms of network silence even when the debounced
      // PATCH hasn't fired yet — under CI load that let the test leave the
      // editor before the node ever reached the backend.
      const headers = { Authorization: await getAuthToken(request) };
      await expect
        .poll(
          async () => {
            const res = await request.get(`/api/v1/flows/${flowId}`, { headers });
            if (!res.ok()) return -1;
            const flow = await res.json();
            return flow?.data?.nodes?.length ?? 0;
          },
          { timeout: 15000 },
        )
        .toBeGreaterThan(0);

      await page.getByTestId("icon-ChevronLeft").click();

      await page.waitForSelector('[data-testid="home-dropdown-menu"]', {
        timeout: 30000,
      });

      // Arm the download capture BEFORE clicking the export button to avoid a
      // race between the download event and modal interaction.
      const downloadPromise = page.waitForEvent("download", { timeout: 30000 });

      // Export from the created flow's OWN card. The home list sorts by
      // `updated_at` DESC, so `.nth(0)` picks whatever flow ANY parallel
      // worker touched last — in the daily that exported a neighbor's empty
      // flow (`nodes: []`, #518): the export modal serializes the card's
      // client-side data with no server fetch.
      const ownCard = page
        .getByTestId("list-card")
        .filter({ has: page.getByTestId(`flow-name-${flowId}`) });
      await ownCard.getByTestId("home-dropdown-menu").click();
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
