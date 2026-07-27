import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { createFlow } from "../../../helpers/flows/create-flow";
import { deleteFlow } from "../../../helpers/flows/delete-flow";
import { waitForFlowSaveSettled } from "../../../helpers/flows/wait-for-flow-save-settled";

// Getting a component from the sidebar onto the canvas — QA-CHECKLIST §15.2:
// double-click, drag-and-drop, and the state the added component arrives in.
// Spec doc: docs/ui-ux/sidebar-add-component.md
//
// The third way of adding a component (hover the card, click "+") is already
// @stable in core-components/componentHoverAdd.spec.ts and is NOT repeated here.
// This spec also replaces core-components/canvas-component-defaults.spec.ts,
// whose tests asserted only node count + header text (never a default value).
//
// Deliberately does NOT call adjustScreenView: fitting/zooming the viewport
// moves the very coordinates the drag test measures.

// The component catalog category the Chat Input / Chat Output components live in
// on 1.12 (`GET /api/v1/all`).
const CATALOG_CATEGORY = "input_output";
// Where the dragged component is dropped, relative to the canvas pane.
const DROP_POINT = { x: 700, y: 420 };
// Drop-position tolerance in flow units. The drop landed exactly on the point
// live; 20px absorbs the node's own grab offset without letting a
// "reset to default position" regression through (a click-added node lands
// hundreds of units away).
const DROP_TOLERANCE = 20;

interface TemplateField {
  value?: unknown;
}

interface PersistedNode {
  id: string;
  position: { x: number; y: number };
  data?: {
    type?: string;
    node?: {
      display_name?: string;
      template?: Record<string, TemplateField>;
    };
  };
}

/** Creates an empty flow with an identity viewport and returns its id. */
async function createEmptyFlow(
  request: APIRequestContext,
  token: string,
): Promise<string> {
  return createFlow(
    request,
    {
      name: `sidebar-add-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      description: "Empty canvas for the §15.2 add-component tests",
      data: { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
      is_component: false,
    },
    { headers: { Authorization: token } },
  );
}

/** Reads the persisted nodes of a flow, polling until the expected count. */
async function readPersistedNodes(
  request: APIRequestContext,
  token: string,
  flowId: string,
  expectedCount: number,
): Promise<PersistedNode[]> {
  let nodes: PersistedNode[] = [];
  // Poll instead of reading once: the autosave PATCH may still be in flight, and
  // asserting on a stale read would fail for the wrong reason.
  await expect
    .poll(
      async () => {
        const res = await request.get(`/api/v1/flows/${flowId}`, {
          headers: { Authorization: token },
        });
        if (!res.ok()) return -1;
        const body = (await res.json()) as { data?: { nodes?: PersistedNode[] } };
        nodes = body.data?.nodes ?? [];
        return nodes.length;
      },
      { timeout: 20000 },
    )
    .toBe(expectedCount);
  return nodes;
}

/** Adds a sidebar component to the canvas by double-clicking its card. */
async function addComponentByDoubleClick(
  page: Page,
  search: string,
  cardTestId: string,
): Promise<void> {
  await page.getByTestId("sidebar-search-input").fill(search);
  await expect(page.getByTestId(cardTestId)).toBeVisible({ timeout: 30000 });
  await page.getByTestId(cardTestId).dblclick();
}

/** The canvas pane rect plus its live viewport transform. */
async function readCanvasFrame(page: Page) {
  const box = await page.locator(".react-flow__pane").boundingBox();
  expect(box, "canvas pane has no bounding box").not.toBeNull();

  const transform = await page
    .locator(".react-flow__viewport")
    .evaluate((el) => (el as HTMLElement).style.transform);
  const match = transform.match(
    /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)\s*scale\(([\d.]+)\)/,
  );
  expect(match, `unparsable viewport transform: "${transform}"`).not.toBeNull();

  return {
    pane: box!,
    viewport: {
      x: Number(match![1]),
      y: Number(match![2]),
      scale: Number(match![3]),
    },
  };
}

test.describe("ui-ux — add components to the canvas from the sidebar", () => {
  let token: string;
  let flowId: string;

  test.beforeEach(async ({ page, request }) => {
    token = await getAuthToken(request);
    flowId = await createEmptyFlow(request, token);

    await page.goto(`/flow/${flowId}`);
    await expect(page.getByTestId("sidebar-search-input")).toBeVisible({
      timeout: 30000,
    });
    // Every test starts from an empty canvas; asserting it here is what makes
    // "one node exists afterwards" a causal check instead of a coincidence.
    await expect(page.locator(".react-flow__node")).toHaveCount(0);
  });

  test.afterEach(async ({ page, request }) => {
    // Unmount the editor first: it polls GET /flows/{id}/events and a mid-poll
    // delete 404s into the fixture's backend-error monitor.
    await page.goto("/").catch(() => {});
    await deleteFlow(request, flowId, { headers: { Authorization: token } });
  });

  test("double-click on a sidebar component adds it to the canvas",
    { tag: ["@stable", "@workspace", "@ui-ux"] },
    async ({ page }) => {
      await test.step("double-click the Chat Input card", async () => {
        await addComponentByDoubleClick(
          page,
          "chat input",
          "input_outputChat Input",
        );
      });

      await test.step("exactly one Chat Input node is on the canvas", async () => {
        const nodes = page.locator(".react-flow__node");
        await expect(nodes).toHaveCount(1, { timeout: 15000 });
        // The node id encodes the component type, so this rejects "some node
        // appeared" as well as "the wrong component was added".
        await expect(nodes.first()).toHaveAttribute(
          "data-testid",
          /^rf__node-ChatInput-/,
        );
        await expect(page.getByTestId("title-Chat Input")).toBeVisible();
      });
    });

  test("dragging a sidebar component drops the node at the pointer",
    { tag: ["@stable", "@workspace", "@ui-ux"] },
    async ({ page, request }) => {
      const frame = await readCanvasFrame(page);

      await test.step("drag the Chat Output card onto the canvas", async () => {
        await page.getByTestId("sidebar-search-input").fill("chat output");
        await expect(page.getByTestId("input_outputChat Output")).toBeVisible({
          timeout: 30000,
        });

        await page
          .getByTestId("input_outputChat Output")
          .dragTo(page.locator(".react-flow__pane"), {
            targetPosition: DROP_POINT,
          });
      });

      await test.step("one Chat Output node appears", async () => {
        const nodes = page.locator(".react-flow__node");
        await expect(nodes).toHaveCount(1, { timeout: 15000 });
        await expect(nodes.first()).toHaveAttribute(
          "data-testid",
          /^rf__node-ChatOutput-/,
        );
      });

      await test.step("the node is persisted at the drop position", async () => {
        // This is what separates a real drop from a click-to-add: the node has
        // to land where the pointer was released, not at an app-chosen default.
        await waitForFlowSaveSettled(page);
        const [node] = await readPersistedNodes(request, token, flowId, 1);

        const expected = {
          x: (DROP_POINT.x - frame.viewport.x) / frame.viewport.scale,
          y: (DROP_POINT.y - frame.viewport.y) / frame.viewport.scale,
        };
        expect(Math.abs(node.position.x - expected.x)).toBeLessThanOrEqual(
          DROP_TOLERANCE,
        );
        expect(Math.abs(node.position.y - expected.y)).toBeLessThanOrEqual(
          DROP_TOLERANCE,
        );
      });
    });

  test("an added component arrives with its catalog default settings",
    { tag: ["@stable", "@workspace", "@ui-ux"] },
    async ({ page, request }) => {
      let catalogTemplate: Record<string, TemplateField> = {};
      let catalogDisplayName = "";

      await test.step("read the Chat Input defaults from the component catalog", async () => {
        const res = await request.get("/api/v1/all", {
          headers: { Authorization: token },
        });
        expect(res.status()).toBe(200);
        const catalog = (await res.json()) as Record<
          string,
          Record<
            string,
            { display_name?: string; template?: Record<string, TemplateField> }
          >
        >;
        const chatInput = catalog?.[CATALOG_CATEGORY]?.ChatInput;
        expect(
          chatInput,
          `ChatInput missing from GET /api/v1/all -> ${CATALOG_CATEGORY}`,
        ).toBeTruthy();

        catalogTemplate = chatInput!.template ?? {};
        catalogDisplayName = chatInput!.display_name ?? "";
        expect(Object.keys(catalogTemplate).length).toBeGreaterThan(0);
      });

      await test.step("add Chat Input to the canvas", async () => {
        await addComponentByDoubleClick(
          page,
          "chat input",
          "input_outputChat Input",
        );
        await expect(page.locator(".react-flow__node")).toHaveCount(1, {
          timeout: 15000,
        });
        await waitForFlowSaveSettled(page);
      });

      await test.step("the persisted node carries every catalog default", async () => {
        const [node] = await readPersistedNodes(request, token, flowId, 1);
        expect(node.data?.type).toBe("ChatInput");
        expect(node.data?.node?.display_name).toBe(catalogDisplayName);

        const nodeTemplate = node.data?.node?.template ?? {};
        const fieldNames = (t: Record<string, TemplateField>) =>
          Object.keys(t)
            .filter((k) => k !== "_type")
            .sort();
        // A field missing from the added node means the component was built from
        // a stale/partial template.
        expect(fieldNames(nodeTemplate)).toEqual(fieldNames(catalogTemplate));

        for (const [field, spec] of Object.entries(catalogTemplate)) {
          if (field === "_type" || !spec || !("value" in spec)) continue;
          expect(
            nodeTemplate[field]?.value,
            `default value of "${field}" does not match the catalog`,
          ).toEqual(spec.value);
        }
      });

      await test.step("the node renders its defaults in the UI", async () => {
        await expect(page.getByTestId("title-Chat Input")).toBeVisible();
        // Chat Input's catalog default for input_value is the empty string.
        await expect(
          page.getByTestId("textarea_str_input_value"),
        ).toHaveValue("");
      });
    });
});
