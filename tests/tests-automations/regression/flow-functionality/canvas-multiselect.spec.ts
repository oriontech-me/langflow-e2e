import { expect, test } from "../../../fixtures/fixtures";
import { addComponentFromSidebar } from "../../../helpers/flows/add-component-from-sidebar";
import { deleteFlow } from "../../../helpers/flows/delete-flow";
import { setupBlankFlow } from "../../../helpers/flows/setup-blank-flow";
import { unselectNodes } from "../../../helpers/ui/unselect-nodes";

/**
 * §15.4 — Select multiple components via box selection.
 *
 * A Shift+drag marquee must select every node it encloses. The selection is
 * asserted DIRECTLY through `.react-flow__node.selected`.
 *
 * The inherited version asserted it indirectly — copy the selection, paste it,
 * expect `2 originals + 2 pasted = 4` — and was deterministically red at 3: one
 * of its fixtures was Chat Input, a **singleton** that cannot be copy/pasted
 * (`core-components/singleton-components.spec.ts`), so only one node ever
 * pasted. Keyboard Copy/Paste is covered by `ui-ux/langflowShortcuts.spec.ts`
 * and `flow-functionality/canvas-copy-paste.spec.ts`; this spec has no business
 * routing a selection assertion through the clipboard.
 *
 * Marquee-delete of a whole canvas is also covered by
 * `core-components/componentDelete.spec.ts` (§15.4, already `[x]`); test 2 here
 * is scoped to proving *this* selection reaches the canvas action layer.
 */

/** How far the second node is dragged so the two stop overlapping. */
const SEPARATION_DX = 40;
const SEPARATION_DY = 260;

test.describe("Canvas — box selection", () => {
  let createdFlowId: string | null = null;

  test.beforeEach(async ({ page }) => {
    createdFlowId = await setupBlankFlow(page);
    await expect(page.locator(".react-flow__node")).toHaveCount(0);

    await addComponentFromSidebar(
      page,
      "prompt",
      "add-component-button-prompt-template",
    );
    await expect(page.locator(".react-flow__node")).toHaveCount(1, {
      timeout: 30000,
    });

    await addComponentFromSidebar(
      page,
      "chat output",
      "add-component-button-chat-output",
    );
    await expect(page.locator(".react-flow__node")).toHaveCount(2, {
      timeout: 30000,
    });

    // Components added from the sidebar stack ~10px apart. A marquee over
    // stacked nodes cannot distinguish "selected both" from "selected the top
    // one", so the second node is dragged clear first.
    const topNode = page.locator(".react-flow__node").nth(1);
    const box = await topNode.boundingBox();
    expect(box, "the second node must be on screen to separate it").not.toBeNull();
    const startX = box!.x + box!.width / 2;
    const startY = box!.y + 12;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + SEPARATION_DX, startY + SEPARATION_DY, {
      steps: 15,
    });
    await page.mouse.up();

    await expect
      .poll(
        async () => {
          const boxes = await page
            .locator(".react-flow__node")
            .evaluateAll((nodes) =>
              nodes.map((n) => {
                const r = n.getBoundingClientRect();
                return { top: r.top, bottom: r.bottom };
              }),
            );
          return boxes[0].bottom < boxes[1].top || boxes[1].bottom < boxes[0].top;
        },
        {
          timeout: 15000,
          message: "the two nodes must not overlap before the marquee",
        },
      )
      .toBe(true);
  });

  test.afterEach(async ({ page }) => {
    if (createdFlowId) {
      await page.goto("/").catch(() => {});
      await deleteFlow(page.request, createdFlowId);
      createdFlowId = null;
    }
  });

  /**
   * Shift+drags a marquee across the given screen rectangle. ReactFlow needs an
   * intermediate move to start the selection gesture.
   */
  const marquee = async (
    page: import("@playwright/test").Page,
    from: { x: number; y: number },
    to: { x: number; y: number },
  ) => {
    await page.keyboard.down("Shift");
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 20, from.y + 20, { steps: 5 });
    await page.mouse.move(to.x, to.y, { steps: 15 });
    await page.mouse.up();
    await page.keyboard.up("Shift");
  };

  /** Screen rectangle enclosing every node, padded by `pad` pixels. */
  const nodesBounds = async (
    page: import("@playwright/test").Page,
    pad: number,
  ) => {
    const boxes = await page
      .locator(".react-flow__node")
      .evaluateAll((nodes) =>
        nodes.map((n) => {
          const r = n.getBoundingClientRect();
          return { x: r.x, y: r.y, right: r.right, bottom: r.bottom };
        }),
      );
    return {
      from: {
        x: Math.min(...boxes.map((b) => b.x)) - pad,
        y: Math.min(...boxes.map((b) => b.y)) - pad,
      },
      to: {
        x: Math.max(...boxes.map((b) => b.right)) + pad,
        y: Math.max(...boxes.map((b) => b.bottom)) + pad,
      },
    };
  };

  test("a Shift+drag marquee selects every component it encloses",
    { tag: ["@stable", "@release", "@workspace", "@ui-ux"] },
    async ({ page }) => {
      const selected = page.locator(".react-flow__node.selected");

      await test.step("Start from an unselected canvas", async () => {
        await unselectNodes(page);
        await expect(selected).toHaveCount(0);
      });

      await test.step("A marquee drawn away from the nodes selects nothing", async () => {
        // Negative control: proves the count below is caused by enclosing the
        // nodes, not by the marquee gesture itself.
        const bounds = await nodesBounds(page, 30);
        const emptyY = bounds.from.y - 120;
        await marquee(
          page,
          { x: bounds.from.x, y: emptyY },
          { x: bounds.to.x, y: bounds.from.y - 40 },
        );
        await expect(selected).toHaveCount(0);
      });

      await test.step("A marquee enclosing both nodes selects both", async () => {
        const bounds = await nodesBounds(page, 30);
        await marquee(page, bounds.from, bounds.to);
        await expect(selected).toHaveCount(2, { timeout: 10000 });
      });
    },
  );

  test("deleting a box selection clears the selected components",
    { tag: ["@stable", "@release", "@workspace", "@ui-ux"] },
    async ({ page }) => {
      const selected = page.locator(".react-flow__node.selected");

      await test.step("Box-select both nodes", async () => {
        await unselectNodes(page);
        const bounds = await nodesBounds(page, 30);
        await marquee(page, bounds.from, bounds.to);
        await expect(selected).toHaveCount(2, { timeout: 10000 });
      });

      await test.step("Delete removes every selected node", async () => {
        await page.keyboard.press("Delete");
        await expect(page.locator(".react-flow__node")).toHaveCount(0, {
          timeout: 10000,
        });
      });
    },
  );
});
