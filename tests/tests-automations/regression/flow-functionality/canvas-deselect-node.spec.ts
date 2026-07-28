import { expect, test } from "../../../fixtures/fixtures";
import { addComponentFromSidebar } from "../../../helpers/flows/add-component-from-sidebar";
import { deleteFlow } from "../../../helpers/flows/delete-flow";
import { setupBlankFlow } from "../../../helpers/flows/setup-blank-flow";

/**
 * §15.4 — Deselect node by clicking an empty canvas area / via Escape.
 *
 * Same contract from two affordances: a selected node must return to
 * unselected, so the node toolbar and the canvas shortcuts stop acting on it.
 *
 * Both tests gate on the node being selected FIRST, so a run where the click
 * never selected anything fails at the setup step instead of passing vacuously
 * on a canvas that had no selection to begin with.
 *
 * `Escape` also closes an open node context menu — that half is
 * `ui-ux/right-click-dropdown.spec.ts` (§15.9). No menu is open here, so this
 * spec isolates the deselect behavior.
 */

test.describe("Canvas — deselecting a node", () => {
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
  });

  test.afterEach(async ({ page }) => {
    if (createdFlowId) {
      await page.goto("/").catch(() => {});
      await deleteFlow(page.request, createdFlowId);
      createdFlowId = null;
    }
  });

  test("clicking empty canvas area deselects a selected node",
    { tag: ["@stable", "@release", "@workspace", "@ui-ux"] },
    async ({ page }) => {
      const selected = page.locator(".react-flow__node.selected");

      await test.step("Select the node", async () => {
        await page.locator(".react-flow__node").first().click();
        await expect(selected).toHaveCount(1, { timeout: 10000 });
      });

      await test.step("Clicking the empty pane clears the selection", async () => {
        // Targets `.react-flow__pane` rather than the `#react-flow-id` wrapper:
        // the wrapper's coordinate space includes the node layer, so a "far
        // away" offset computed against it can still land on a node after a
        // zoom change.
        await page
          .locator(".react-flow__pane")
          .click({ position: { x: 5, y: 5 } });
        await expect(selected).toHaveCount(0, { timeout: 10000 });
      });
    },
  );

  test("pressing Escape deselects a selected node",
    { tag: ["@stable", "@release", "@workspace", "@ui-ux"] },
    async ({ page }) => {
      const selected = page.locator(".react-flow__node.selected");

      await test.step("Select the node", async () => {
        await page.locator(".react-flow__node").first().click();
        await expect(selected).toHaveCount(1, { timeout: 10000 });
      });

      await test.step("Escape clears the selection", async () => {
        await page.keyboard.press("Escape");
        await expect(selected).toHaveCount(0, { timeout: 10000 });
      });
    },
  );
});
