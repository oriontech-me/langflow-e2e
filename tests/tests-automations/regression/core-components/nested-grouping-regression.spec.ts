import type { Page } from "@playwright/test";
import { readFileSync } from "fs";
import path from "path";
import { expect, test } from "../../../fixtures/fixtures";
import { adjustScreenView } from "../../../helpers/ui/adjust-screen-view";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { deleteFlow } from "../../../helpers/flows/delete-flow";

// Asset is a 2-node subset of the Basic Prompting starter template: a
// Prompt Template wired into a Language Model. We use a custom flow (not a
// starter template) because the Group button gates on `validateSelection`
// in `src/frontend/src/utils/reactflowUtils.ts`, which rejects input/output
// components and sticky-note overlaps — both present in the starter
// templates.
const FLOW_ASSET = path.resolve(
  __dirname,
  "../../../assets/flows/two-non-io-connected.json",
);

async function createTwoNodeFlow(page: Page): Promise<string> {
  const raw = JSON.parse(readFileSync(FLOW_ASSET, "utf-8"));
  const body = {
    ...raw,
    name: `nested-grouping-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 7)}`,
  };

  const authToken = await getAuthToken(page.request);
  const res = await page.request.post("/api/v1/flows/", {
    headers: authToken ? { Authorization: authToken } : {},
    data: body,
  });
  if (res.status() !== 201) {
    throw new Error(
      `Flow creation failed: ${res.status()} — ${await res.text()}`,
    );
  }
  const { id } = (await res.json()) as { id: string };

  // Going via the dashboard avoids the stale-cache redirect that
  // `page.goto("/flow/${id}")` triggers right after an API-created flow.
  await page.goto("/");
  // The /flows a11y refactor (Langflow #13891) makes `flow-name-div`
  // `pointer-events-none`; open the flow via the card's overlay button.
  await page
    .getByTestId("list-card")
    .filter({
      has: page.getByTestId("flow-name-div").filter({ hasText: body.name }),
    })
    .getByTestId("list-card-open-button")
    .first()
    .click();
  await expect(page.getByTestId("canvas_controls_dropdown")).toBeVisible({
    timeout: 30000,
  });
  await expect(page.getByTestId("title-Prompt Template")).toBeVisible({
    timeout: 15000,
  });
  await expect(page.getByTestId("title-Language Model")).toBeVisible({
    timeout: 15000,
  });
  await adjustScreenView(page);
  return id;
}

// Selects every node on the canvas via Shift+drag across the full bounding
// rectangle of all `.react-flow__node` elements, then asserts that the
// selection actually committed by waiting for `react-flow__node.selected`
// to reach count 2. Without this wait the click on the Group button can
// race the React Flow selection lifecycle (onSelectionChange fires multiple
// times during a drag, and the SelectionMenu's onClick closure can capture
// a stale `lastSelection`).
async function selectAllNodesBoxDrag(page: Page): Promise<void> {
  const nodes = page.locator(".react-flow__node");
  await expect(nodes).toHaveCount(2);

  // Click empty canvas first to clear any pre-existing selection — fresh
  // selection state makes the drag-to-select trigger React Flow's
  // onSelectionStart/onSelectionEnd cleanly.
  await page.locator(".react-flow__pane").click({ position: { x: 5, y: 5 } });
  await expect(page.locator(".react-flow__node.selected")).toHaveCount(0, {
    timeout: 2000,
  });

  const a = await nodes.nth(0).boundingBox();
  const b = await nodes.nth(1).boundingBox();
  if (!a || !b) {
    throw new Error("Could not read bounding boxes for canvas nodes");
  }

  const pad = 40;
  const startX = Math.min(a.x, b.x) - pad;
  const startY = Math.min(a.y, b.y) - pad;
  const endX = Math.max(a.x + a.width, b.x + b.width) + pad;
  const endY = Math.max(a.y + a.height, b.y + b.height) + pad;

  await page.keyboard.down("Shift");
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(endX, endY, { steps: 12 });
  await page.mouse.up();
  await page.keyboard.up("Shift");

  // Wait until React Flow has actually marked both nodes as selected,
  // and the SelectionMenu has rendered its Group button at full opacity
  // (`opacity-100` after the 50ms isTransitioning toggle). The button only
  // takes a click once it's no longer mid-fade.
  await expect(page.locator(".react-flow__node.selected")).toHaveCount(2, {
    timeout: 5000,
  });
  await expect(page.getByTestId("group-node")).toBeVisible({ timeout: 5000 });
}

// Triggers the grouping mutation. Earlier (pre-1.10) versions of Langflow
// had a closure-rebind race in SelectionMenu's onClick that required a
// retry loop. As of 1.10.x the click consistently registers once
// `.react-flow__node.selected` count reaches 2 — verified empirically with
// 15/15 first-click passes — so the retry was removed. If flakiness
// returns, see PR #229 for the original retry approach.
async function triggerGroupMutation(page: Page): Promise<void> {
  const groupBtn = page.getByTestId("group-node");
  await expect(groupBtn).toBeVisible({ timeout: 5000 });
  await expect(groupBtn).toBeEnabled();
  await groupBtn.click({ force: true });
  await expect(groupBtn).toBeHidden({ timeout: 5000 });
}

test.describe("Nested / Grouping", () => {
  let createdFlowId: string | null = null;

  test.afterEach(async ({ page }) => {
    if (createdFlowId) {
      await deleteFlow(page.request, createdFlowId);
      createdFlowId = null;
    }
  });

  test(
    "box-selecting two connected non-IO components and clicking Group collapses them into a single Group node",
    {
      tag: ["@stable", "@release", "@regression", "@components", "@workspace"],
    },
    async ({ page }) => {
      await test.step("Create a 2-node non-IO flow and open it on the canvas", async () => {
        createdFlowId = await createTwoNodeFlow(page);
      });

      await test.step("Box-select both nodes via Shift+drag and confirm the Group button appears", async () => {
        await selectAllNodesBoxDrag(page);
      });

      await test.step("Click Group and wait for the SelectionMenu to close", async () => {
        await triggerGroupMutation(page);
      });

      await test.step("Assert the canvas collapsed to a single Group node and the original titles are gone", async () => {
        // The two source components are replaced by a single Group-typed node.
        await expect(page.locator(".react-flow__node")).toHaveCount(1, {
          timeout: 5000,
        });
        await expect(page.getByTestId("title-Group")).toBeVisible();
        // The original titles disappear from the outer canvas — proving the
        // components are nested inside the Group, not just renamed.
        await expect(page.getByTestId("title-Prompt Template")).toHaveCount(0);
        await expect(page.getByTestId("title-Language Model")).toHaveCount(0);
      });
    },
  );

  test(
    "ungrouping a Group node restores the original components and the edge between them",
    {
      tag: ["@stable", "@release", "@regression", "@components", "@workspace"],
    },
    async ({ page }) => {
      await test.step("Create a 2-node non-IO flow and group both nodes into a single Group", async () => {
        createdFlowId = await createTwoNodeFlow(page);
        await selectAllNodesBoxDrag(page);
        await triggerGroupMutation(page);
        const groupTitle = page.getByTestId("title-Group");
        await expect(groupTitle).toBeVisible({ timeout: 8000 });
        await expect(page.locator(".react-flow__node")).toHaveCount(1);
      });

      await test.step("Right-click the Group node and trigger Ungroup", async () => {
        // The Ungroup entry only renders for Group-typed nodes
        // (`isGroup && <SelectItem value="ungroup">` in
        // src/frontend/src/pages/FlowPage/components/nodeToolbarComponent/index.tsx).
        await page.getByTestId("title-Group").click({ button: "right" });
        const ungroupOption = page.getByTestId("group-button-modal");
        await expect(ungroupOption).toBeVisible({ timeout: 5000 });
        await ungroupOption.click();
      });

      await test.step("Assert the original components and edge are restored on the outer canvas", async () => {
        // expandGroupNode re-emits the saved sub-flow into the parent canvas:
        // the two original component nodes are back, the edge between them is
        // restored, and the Group node is gone.
        await expect(page.locator(".react-flow__node")).toHaveCount(2, {
          timeout: 8000,
        });
        await expect(page.locator(".react-flow__edge")).toHaveCount(1, {
          timeout: 8000,
        });
        await expect(page.getByTestId("title-Group")).toHaveCount(0);
        await expect(page.getByTestId("title-Prompt Template")).toBeVisible();
        await expect(page.getByTestId("title-Language Model")).toBeVisible();
      });
    },
  );
});
