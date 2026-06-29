import { expect, test } from "../../../fixtures/fixtures";
import { setupBlankFlow } from "../../../helpers/flows/setup-blank-flow";
import { addComponentFromSidebar } from "../../../helpers/flows/add-component-from-sidebar";

test.describe("Delete a component from the canvas", () => {
  let createdFlowId: string | null = null;

  test.beforeEach(async ({ page }) => {
    // setupBlankFlow creates the flow via API (avoids the UI-creation 500 race)
    // and returns its id so afterEach can clean it up.
    createdFlowId = await setupBlankFlow(page);
    // Precondition: the canvas starts empty, so a later "count 0" proves the
    // delete actually removed something rather than passing on an empty canvas.
    await expect(page.locator(".react-flow__node")).toHaveCount(0);
  });

  test.afterEach(async ({ page }) => {
    if (createdFlowId) {
      // Leave the editor first: staying on it while the flow is deleted makes
      // background polling 404, which the fixture's error monitor would flag.
      await page.goto("/").catch(() => {});
      await page.request.delete(`/api/v1/flows/${createdFlowId}`);
      createdFlowId = null;
    }
  });

  test(
    "Should delete a single component with the Backspace key",
    { tag: ["@release", "@stable", "@workspace", "@components"] },
    async ({ page }) => {
      await test.step("Add a Chat Input component to the canvas", async () => {
        await addComponentFromSidebar(page,
          "Chat Input",
          "add-component-button-chat-input");
        await expect(page.locator(".react-flow__node")).toHaveCount(1);
      });

      await test.step("Select the node and delete it with Backspace", async () => {
        // Clicking the node selects it; Backspace then deletes the selection.
        await page.locator(".react-flow__node").click();
        await page.keyboard.press("Backspace");
        await expect(page.locator(".react-flow__node")).toHaveCount(0);
      });
    },
  );

  test(
    "Should delete a single component via the node options menu",
    { tag: ["@release", "@stable", "@workspace", "@components"] },
    async ({ page }) => {
      await test.step("Add a Chat Input component to the canvas", async () => {
        await addComponentFromSidebar(page,
          "Chat Input",
          "add-component-button-chat-input");
        await expect(page.locator(".react-flow__node")).toHaveCount(1);
      });

      await test.step("Delete the node via its options (...) menu", async () => {
        // Select the node first so its toolbar (the ... button) is shown —
        // explicit instead of relying on the just-added node being auto-selected.
        await page.locator(".react-flow__node").click();
        // Neither the 3-dot button nor the "Delete" menu item has its own
        // testid — target their inner icons instead.
        await page.getByTestId("icon-MoreHorizontal").click();
        await page.getByTestId("icon-Delete").click();
        await expect(page.locator(".react-flow__node")).toHaveCount(0);
      });
    },
  );

  test(
    "Should delete multiple selected components with a marquee selection",
    { tag: ["@release", "@stable", "@workspace", "@components"] },
    async ({ page }) => {
      await test.step("Add two components to the canvas", async () => {
        await addComponentFromSidebar(page,
          "Chat Input",
          "add-component-button-chat-input");
        await expect(page.locator(".react-flow__node")).toHaveCount(1);
        await addComponentFromSidebar(page,
          "Chat Output",
          "add-component-button-chat-output");
        await expect(page.locator(".react-flow__node")).toHaveCount(2);
      });

      await test.step("Marquee-select all nodes and delete them", async () => {
        // Components added via the "+" button stack at the same spot, so
        // clicking each node individually is not reliable. A Shift+drag marquee
        // selects every node regardless of overlap.

        // Deselect first: the last-added node comes auto-selected, which would
        // throw off the marquee selection.
        await page.locator(".react-flow__pane").click();

        // Compute a box that fully encloses every node on the canvas.
        const nodes = page.locator(".react-flow__node");
        const count = await nodes.count();
        let minX = Infinity,
          minY = Infinity,
          maxX = -Infinity,
          maxY = -Infinity;
        for (let i = 0; i < count; i++) {
          // Nodes were just asserted present and visible, so boundingBox is non-null.
          const box = (await nodes.nth(i).boundingBox())!;
          minX = Math.min(minX, box.x);
          minY = Math.min(minY, box.y);
          maxX = Math.max(maxX, box.x + box.width);
          maxY = Math.max(maxY, box.y + box.height);
        }

        // Drag the marquee with Shift held, padding the box so it starts on
        // empty canvas (not on a node, which would drag the node instead).
        await page.keyboard.down("Shift");
        await page.mouse.move(minX - 60, minY - 60);
        await page.mouse.down();
        await page.mouse.move(maxX + 60, maxY + 60, { steps: 10 });
        await page.mouse.up();
        await page.keyboard.up("Shift");

        // Delete the selected nodes and assert the canvas is empty.
        await page.keyboard.press("Backspace");
        await expect(page.locator(".react-flow__node")).toHaveCount(0);
      });
    },
  );
});
