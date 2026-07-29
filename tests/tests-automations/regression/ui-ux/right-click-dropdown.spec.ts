import { expect, test } from "../../../fixtures/fixtures";
import { addComponentFromSidebar } from "../../../helpers/flows/add-component-from-sidebar";
import { deleteFlow } from "../../../helpers/flows/delete-flow";
import { setupBlankFlow } from "../../../helpers/flows/setup-blank-flow";
import { unselectNodes } from "../../../helpers/ui/unselect-nodes";

/**
 * §15.9 — Context menu via right-click on a canvas component.
 *
 * A single right-click on a node must select it (exactly like a left-click)
 * AND open its options menu immediately — no prior left-click, no hover over
 * the toolbar's `...` button.
 *
 * Two selector decisions, both measured live on nightly 1.12.0.dev8:
 *
 * 1. The open menu is `[data-radix-popper-content-wrapper] [role="listbox"]`.
 *    `more-options-modal` is NOT used: that testid is the toolbar's `...`
 *    button, and the toolbar mounts on SELECTION, not on the menu
 *    (`GenericNode`: `selected && selectedNodesCount === 1 || rightClickedNodeId
 *    === data.id`). A plain left-click on the node therefore already yields
 *    `more-options-modal` = 1 with `role="listbox"` = 0 — gating on it proves
 *    the node is selected, never that the menu opened, and would stay green if
 *    the menu broke entirely. That is the false green the previous version of
 *    this spec shipped (and #1027's deleted `canvas-right-click-component`).
 * 2. Items are located by `role="option"` + text, never by testid: `Duplicate`
 *    and `Copy` share the testid `copy-button-modal` upstream.
 *
 * The item set is component-dependent (`Freeze` renders for Prompt Template but
 * not for Chat Input / Language Model), so the exact ordered contract is
 * asserted for the Prompt Template fixture only.
 *
 * `Save` is deliberately never clicked — it writes the node into the account's
 * saved-component library, i.e. state shared with every other spec on the
 * instance.
 *
 * Sibling coverage not duplicated here: `core-components/componentDelete.spec.ts`
 * (Delete through the toolbar menu), `ui-ux/minimize.spec.ts` (Minimize/Expand),
 * `flow-functionality/canvas-copy-paste.spec.ts` (keyboard Copy/Paste).
 *
 * The sibling checklist item "context menu via right-click on canvas" has no
 * product surface on 1.12.0.dev8 (the pane's `contextmenu` event is not
 * prevented and no menu renders); test 3 asserts that absence — see
 * `docs/ui-ux/right-click-dropdown.md`.
 */

/**
 * Ordered item contract of the Prompt Template context menu on 1.12.0.dev8.
 *
 * Substring regexes rather than exact labels: each row's text also carries its
 * shortcut hint ("DuplicateCtrlD"), Freeze is prefixed by its inline
 * `snowflake-svg` element ("snowflake-svgFreezeCtrlF") and Delete arrives padded
 * (" Delete "). Matched as an array, so the count and the order are still exact.
 */
const MENU_ITEMS = [
  /Save/,
  /Duplicate/,
  /Copy/,
  /Docs/,
  /Minimize/,
  /Freeze/,
  /Download/,
  /Delete/,
];

test.describe("Canvas — right-click context menu on a component", () => {
  let createdFlowId: string | null = null;

  test.beforeEach(async ({ page }) => {
    // setupBlankFlow creates the flow via API (avoids the UI-creation 500 race)
    // and returns its id so afterEach can clean it up.
    createdFlowId = await setupBlankFlow(page);

    // The canvas starts empty, so the "exactly 1 node" assert below proves the
    // fixture component was really added.
    await expect(page.locator(".react-flow__node")).toHaveCount(0);

    // Prompt Template is not a singleton, so it can be duplicated (Chat Input
    // and Webhook cannot — see core-components/singleton-components.spec.ts).
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
      // Leave the editor first: staying on it while the flow is deleted makes
      // background polling 404, which the fixture's error monitor would flag.
      await page.goto("/").catch(() => {});
      await deleteFlow(page.request, createdFlowId);
      createdFlowId = null;
    }
  });

  test("right-clicking a component selects it and opens its options menu",
    { tag: ["@stable", "@release", "@components", "@ui-ux"] },
    async ({ page }) => {
      const node = page.locator(".react-flow__node").first();
      const menu = page.locator(
        '[data-radix-popper-content-wrapper] [role="listbox"]',
      );

      await test.step("Clear the selection left by adding the component", async () => {
        await unselectNodes(page);
        // Precondition: without this, the selection assert below could pass on
        // the selection the sidebar "+" already left behind.
        await expect(page.locator(".react-flow__node.selected")).toHaveCount(0);
      });

      await test.step("Right-click the node once", async () => {
        await node.click({ button: "right" });
      });

      await test.step("The right-click selected the node", async () => {
        await expect(page.locator(".react-flow__node.selected")).toHaveCount(
          1,
          { timeout: 10000 },
        );
      });

      await test.step("The options menu opened with its full item contract", async () => {
        await expect(menu).toBeVisible({ timeout: 10000 });
        await expect(menu).toHaveAttribute("data-state", "open");
        // toHaveText with an array asserts the exact count AND order of items.
        await expect(menu.getByRole("option")).toHaveText(MENU_ITEMS, {
          timeout: 10000,
        });
      });

      await test.step("Escape closes the menu and clears the selection", async () => {
        await page.keyboard.press("Escape");
        await expect(menu).toHaveCount(0, { timeout: 10000 });
        // One keypress does both: Escape is also the canvas deselect shortcut
        // (§15.4), so the node the right-click had selected goes back to
        // unselected. Measured on 1.12.0.dev8.
        await expect(page.locator(".react-flow__node.selected")).toHaveCount(0, {
          timeout: 10000,
        });
      });
    },
  );

  test("an item picked from the right-click menu acts on that component",
    { tag: ["@stable", "@release", "@components", "@ui-ux"] },
    async ({ page }) => {
      const node = page.locator(".react-flow__node").first();
      const menu = page.locator(
        '[data-radix-popper-content-wrapper] [role="listbox"]',
      );

      await test.step("Open the context menu on the node", async () => {
        await unselectNodes(page);
        await node.click({ button: "right" });
        await expect(menu).toBeVisible({ timeout: 10000 });
      });

      await test.step("Choosing Duplicate adds one node and closes the menu", async () => {
        await menu
          .getByRole("option")
          .filter({ hasText: /^Duplicate/ })
          .click();
        // The duplicate is the observable: the action really ran, rather than
        // the menu merely rendering a clickable row.
        await expect(page.locator(".react-flow__node")).toHaveCount(2, {
          timeout: 15000,
        });
        await expect(menu).toHaveCount(0, { timeout: 10000 });
      });
    },
  );

  test("right-clicking the canvas background opens no menu and dismisses an open one",
    { tag: ["@stable", "@regression", "@workspace", "@ui-ux"] },
    async ({ page }) => {
      const node = page.locator(".react-flow__node").first();
      const pane = page.locator(".react-flow__pane");
      const menu = page.locator(
        '[data-radix-popper-content-wrapper] [role="listbox"]',
      );
      // Every menu surface Langflow could render here — the node's own listbox,
      // a hypothetical pane `role="menu"`, or any Radix popover.
      const anyMenu = page.locator(
        '[role="menu"], [role="listbox"], [data-radix-popper-content-wrapper]',
      );
      const selected = page.locator(".react-flow__node.selected");

      // Bottom-left of the pane: away from the node, which lands centred when
      // added from the sidebar. A click that did hit the node would REOPEN the
      // menu and fail the asserts below, so a mis-aimed point cannot produce a
      // silent pass.
      const paneBox = await pane.boundingBox();
      expect(paneBox, "the canvas pane must be laid out").not.toBeNull();
      const emptySpot = {
        x: Math.round(paneBox!.width * 0.12),
        y: Math.round(paneBox!.height * 0.85),
      };

      await test.step("Open the node's context menu", async () => {
        await unselectNodes(page);
        await node.click({ button: "right" });
        await expect(menu).toBeVisible({ timeout: 10000 });
      });

      await test.step("Right-clicking the pane dismisses it and opens nothing", async () => {
        await pane.click({ button: "right", position: emptySpot });
        await expect(anyMenu).toHaveCount(0, { timeout: 10000 });
        // Only the popover goes: `onPaneClick`, the handler that clears
        // `rightClickedNodeId`, is a LEFT-click handler, so the selection the
        // right-click made survives. Measured on 1.12.0.dev8.
        await expect(selected).toHaveCount(1);
      });

      await test.step("Right-clicking the pane on a clean canvas renders nothing", async () => {
        await unselectNodes(page);
        await expect(selected).toHaveCount(0);
        await pane.click({ button: "right", position: emptySpot });
        await expect(anyMenu).toHaveCount(0, { timeout: 10000 });
      });
    },
  );
});
