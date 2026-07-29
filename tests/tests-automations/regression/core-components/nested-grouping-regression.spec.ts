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

// Reads the persisted shape of the flow. Canvas mutations are autosaved on a
// debounce, so every backend assertion below polls through this rather than
// reading once — an immediate GET after grouping still returns the two
// ungrouped nodes.
// `showNode` is normalised to null when absent: a freshly created GroupNode
// carries NO showNode key at all (the node literal in `reactflowUtils` sets
// only id/type/node/position), and the key only appears once the user toggles
// collapse or expand. Reporting it as null rather than undefined keeps the
// assertions below non-vacuous — `toEqual` ignores undefined properties.
async function readPersistedNodes(
  page: Page,
  flowId: string,
): Promise<Array<{ type?: string; showNode: boolean | null; hasInnerFlow: boolean }>> {
  const authToken = await getAuthToken(page.request);
  const res = await page.request.get(`/api/v1/flows/${flowId}`, {
    headers: authToken ? { Authorization: authToken } : {},
  });
  if (!res.ok()) return [];
  const body = (await res.json()) as {
    data?: {
      nodes?: Array<{
        data?: { type?: string; showNode?: boolean; node?: { flow?: unknown } };
      }>;
    };
  };
  return (body.data?.nodes ?? []).map((n) => ({
    type: n.data?.type,
    showNode: n.data?.showNode ?? null,
    hasInnerFlow: n.data?.node?.flow != null,
  }));
}

// Opens the Group node's right-click toolbar. The toolbar is a dropdown
// rendered per node; reopening it is required between state changes because
// collapsing swaps the Minimize entry for Expand.
async function openGroupToolbar(page: Page): Promise<void> {
  await page.getByTestId("title-Group").click({ button: "right" });
  await expect(page.getByTestId("group-button-modal")).toBeVisible({
    timeout: 5000,
  });
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

  test(
    "a Group node collapses and expands from its toolbar, and the state is persisted",
    {
      tag: ["@release", "@regression", "@components", "@workspace"],
    },
    async ({ page }) => {
      let expandedHeight = 0;

      await test.step("Create a 2-node non-IO flow and group both nodes into a single Group", async () => {
        createdFlowId = await createTwoNodeFlow(page);
        await selectAllNodesBoxDrag(page);
        await triggerGroupMutation(page);
        await expect(page.locator(".react-flow__node")).toHaveCount(1, {
          timeout: 8000,
        });
        await expect(page.getByTestId("title-Group")).toBeVisible();
      });

      await test.step("Wait for the grouped shape to reach the backend and record the expanded height", async () => {
        // Server truth, not just the canvas: one GroupNode carrying the
        // encapsulated sub-flow. Polled because autosave is debounced.
        // showNode is null here — a new Group is expanded by DEFAULT, with no
        // explicit flag, so the collapse below is what first writes the key.
        await expect
          .poll(async () => readPersistedNodes(page, createdFlowId!), {
            timeout: 20000,
            message: "the grouped flow should reach the backend",
          })
          .toEqual([
            { type: "GroupNode", showNode: null, hasInnerFlow: true },
          ]);

        const box = await page.locator(".react-flow__node").boundingBox();
        expect(box, "the Group node must be on screen").not.toBeNull();
        expandedHeight = box!.height;

        // The group's field rows are what collapsing hides.
        await expect(page.getByTestId("title-input")).toBeVisible();
        await expect(page.getByTestId("title-language model")).toBeVisible();
      });

      await test.step("Collapse the Group from its right-click toolbar", async () => {
        await openGroupToolbar(page);
        // Expanded state offers Minimize and not Expand — the two entries are
        // mutually exclusive, which is what distinguishes a real state change
        // from a re-render.
        await expect(page.getByTestId("expand-button-modal")).toHaveCount(0);
        await page.getByTestId("minimize-button-modal").click();
      });

      await test.step("Assert the collapsed Group: fields hidden, handles inert, node shorter", async () => {
        await expect(page.getByTestId("title-input")).toHaveCount(0, {
          timeout: 10000,
        });
        await expect(page.getByTestId("title-language model")).toHaveCount(0);
        // The Group itself stays on the canvas — collapsed, not removed.
        await expect(page.getByTestId("title-Group")).toBeVisible();

        // Every handle is marked no-show while collapsed, so nothing can be
        // wired into a collapsed group.
        const handles = page.locator(".react-flow__handle");
        await expect(handles).not.toHaveCount(0);
        await expect(handles).toHaveCount(
          await page.locator(".react-flow__handle.no-show").count(),
        );

        await expect
          .poll(
            async () => (await page.locator(".react-flow__node").boundingBox())?.height ?? 0,
            { timeout: 10000, message: "the collapsed Group should be shorter" },
          )
          .toBeLessThan(expandedHeight);
      });

      await test.step("Assert the collapse was persisted", async () => {
        await expect
          .poll(async () => readPersistedNodes(page, createdFlowId!), {
            timeout: 20000,
            message: "showNode should persist as false after collapsing",
          })
          .toEqual([
            { type: "GroupNode", showNode: false, hasInnerFlow: true },
          ]);
      });

      await test.step("Expand the Group again from its right-click toolbar", async () => {
        await openGroupToolbar(page);
        // Collapsed state offers Expand and not Minimize.
        await expect(page.getByTestId("minimize-button-modal")).toHaveCount(0);
        await page.getByTestId("expand-button-modal").click();
      });

      await test.step("Assert the expanded Group restored its fields and live handles", async () => {
        await expect(page.getByTestId("title-input")).toBeVisible({
          timeout: 10000,
        });
        await expect(page.getByTestId("title-language model")).toBeVisible();
        await expect(page.locator(".react-flow__handle.no-show")).toHaveCount(0);

        await expect
          .poll(
            async () => (await page.locator(".react-flow__node").boundingBox())?.height ?? 0,
            { timeout: 10000, message: "the expanded Group should regain its height" },
          )
          .toBeGreaterThan(expandedHeight / 2);
      });

      await test.step("Assert the expansion was persisted", async () => {
        await expect
          .poll(async () => readPersistedNodes(page, createdFlowId!), {
            timeout: 20000,
            message: "showNode should persist as true after expanding",
          })
          .toEqual([
            { type: "GroupNode", showNode: true, hasInnerFlow: true },
          ]);
      });
    },
  );
});
