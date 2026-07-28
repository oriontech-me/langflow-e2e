import { expect, test } from "../../../fixtures/fixtures";
import { addComponentFromSidebar } from "../../../helpers/flows/add-component-from-sidebar";
import { deleteFlow } from "../../../helpers/flows/delete-flow";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { setupBlankFlow } from "../../../helpers/flows/setup-blank-flow";

/**
 * §15.4 — Move component within canvas.
 *
 * Dragging a node must move it on screen AND persist the new coordinates, so a
 * reopened flow keeps the layout. Asserting only the DOM would pass on a
 * UI-only move that never reaches the autosave PATCH — the regression this spec
 * exists to catch — so the DOM transform and the API `position` are compared
 * against each other.
 *
 * Not to be confused with `ui-ux/sidebar-add-component.spec.ts` (dragging a
 * component OUT of the sidebar, i.e. creation) or
 * `flow-functionality/dragAndDrop.spec.ts` (dropping a flow FILE to import it).
 */

/** Screen-pixel offset applied to the node during the drag. */
const DRAG_DX = 240;
const DRAG_DY = 120;

/**
 * Tolerance, in flow units, when comparing an expected position to a measured
 * one. The canvas may sit at a zoom level other than 1, so a screen-pixel drag
 * is not a 1:1 flow-coordinate delta.
 */
const POSITION_TOLERANCE = 60;

/** Reads `translate(Xpx, Ypx)` off a `.react-flow__node` element. */
function parseTransform(transform: string): { x: number; y: number } {
  const match = transform.match(
    /translate\(\s*(-?[\d.]+)px[,\s]+(-?[\d.]+)px\s*\)/,
  );
  if (!match) {
    throw new Error(`unexpected node transform: ${transform}`);
  }
  return { x: Number(match[1]), y: Number(match[2]) };
}

test.describe("Canvas — moving a component", () => {
  let createdFlowId: string | null = null;

  /** Nodes as the backend currently has them (empty until autosave lands). */
  async function fetchNodes(
    request: import("@playwright/test").APIRequestContext,
    flowId: string,
  ) {
    const bearer = await getAuthToken(request);
    const response = await request.get(`/api/v1/flows/${flowId}`, {
      headers: bearer ? { Authorization: bearer } : undefined,
    });
    expect(response.status()).toBe(200);
    const body = await response.json();
    return (body?.data?.nodes ?? []) as Array<{
      position: { x: number; y: number };
    }>;
  }

  test.beforeEach(async ({ page, request }) => {
    createdFlowId = await setupBlankFlow(page);
    await expect(page.locator(".react-flow__node")).toHaveCount(0);

    // A single node: with two stacked components the topmost one captures the
    // press and the drag silently moves the wrong node.
    await addComponentFromSidebar(
      page,
      "prompt",
      "add-component-button-prompt-template",
    );
    await expect(page.locator(".react-flow__node")).toHaveCount(1, {
      timeout: 30000,
    });

    // The canvas autosave is debounced, so the flow is still node-less on the
    // server right after the component renders. Gate on server truth before
    // any position is read from it (network silence is not persistence).
    await expect
      .poll(async () => (await fetchNodes(request, createdFlowId!)).length, {
        timeout: 30000,
        message: "the added component should be persisted before the drag",
      })
      .toBe(1);
  });

  test.afterEach(async ({ page }) => {
    if (createdFlowId) {
      await page.goto("/").catch(() => {});
      await deleteFlow(page.request, createdFlowId);
      createdFlowId = null;
    }
  });

  test("dragging a component moves it on the canvas and persists the new position",
    { tag: ["@stable", "@release", "@workspace", "@ui-ux"] },
    async ({ page, request }) => {
      const node = page.locator(".react-flow__node").first();
      const flowId = createdFlowId!;

      const readPersistedPosition = async () => {
        const nodes = await fetchNodes(request, flowId);
        expect(nodes.length, "the flow should hold exactly one node").toBe(1);
        return nodes[0].position;
      };

      let before = { x: 0, y: 0 };

      await test.step("Read the starting position from the DOM and the API", async () => {
        before = parseTransform(
          await node.evaluate((el: HTMLElement) => el.style.transform),
        );

        const persisted = await readPersistedPosition();
        expect(
          Math.abs(persisted.x - before.x),
          "the stored position must match the rendered one before the drag",
        ).toBeLessThanOrEqual(POSITION_TOLERANCE);
        expect(Math.abs(persisted.y - before.y)).toBeLessThanOrEqual(
          POSITION_TOLERANCE,
        );
      });

      await test.step("Drag the node by its title", async () => {
        // The title is the drag handle: pressing the node body can land on an
        // interactive field and start editing instead of dragging.
        const title = node.getByTestId("title-Prompt Template");
        const box = await title.boundingBox();
        expect(box, "the node title must be on screen to drag it").not.toBeNull();

        const startX = box!.x + box!.width / 2;
        const startY = box!.y + box!.height / 2;

        // ReactFlow starts a node drag from intermediate move events — a single
        // jump from press to release is swallowed and the node stays put.
        await page.mouse.move(startX, startY);
        await page.mouse.down();
        await page.mouse.move(startX + DRAG_DX, startY + DRAG_DY, {
          steps: 15,
        });
        await page.mouse.up();
      });

      await test.step("The node moved by approximately the dragged offset", async () => {
        await expect
          .poll(
            async () => {
              const now = parseTransform(
                await node.evaluate((el: HTMLElement) => el.style.transform),
              );
              return (
                Math.abs(now.x - (before.x + DRAG_DX)) <= POSITION_TOLERANCE &&
                Math.abs(now.y - (before.y + DRAG_DY)) <= POSITION_TOLERANCE
              );
            },
            {
              timeout: 15000,
              message: "the node transform should reflect the drag offset",
            },
          )
          .toBe(true);
      });

      await test.step("The new position reached the backend", async () => {
        const after = parseTransform(
          await node.evaluate((el: HTMLElement) => el.style.transform),
        );

        // The autosave PATCH is debounced, so the API is polled rather than read
        // once. This is the assertion that a UI-only move cannot satisfy.
        await expect
          .poll(
            async () => {
              const persisted = await readPersistedPosition();
              return (
                Math.abs(persisted.x - after.x) <= POSITION_TOLERANCE &&
                Math.abs(persisted.y - after.y) <= POSITION_TOLERANCE
              );
            },
            {
              timeout: 20000,
              message: "the moved position should be persisted to the flow",
            },
          )
          .toBe(true);

        // …and it must actually differ from where the node started, otherwise a
        // no-op drag would satisfy the check above.
        const persisted = await readPersistedPosition();
        expect(
          Math.abs(persisted.x - before.x) + Math.abs(persisted.y - before.y),
          "the persisted position must differ from the pre-drag one",
        ).toBeGreaterThan(POSITION_TOLERANCE);
      });
    },
  );
});
