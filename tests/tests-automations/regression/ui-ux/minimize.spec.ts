import { expect, test } from "../../../fixtures/fixtures";
import { addComponentFromSidebar } from "../../../helpers/flows/add-component-from-sidebar";
import { deleteFlow } from "../../../helpers/flows/delete-flow";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { setupBlankFlow } from "../../../helpers/flows/setup-blank-flow";

/**
 * §15.4 — Minimize component on canvas.
 *
 * Collapsing and restoring a node through its options menu, asserted in the DOM
 * and in the persisted flow.
 *
 * Two facts drive the fixture choice, both measured on nightly 1.12.0.dev8:
 *
 * 1. **Chat Output ships minimized** (`minimized: true` in `GET /api/v1/all`),
 *    so a spec built on it would start in the end state. Prompt Template has
 *    `minimized: false` and renders expanded, making both directions observable.
 * 2. **The inherited version of this spec was red** because it searched for
 *    `Text Input`, which is now `legacy: true` and therefore hidden from the
 *    default sidebar — an intentional product change. The fix is a different
 *    fixture component, not enabling the legacy toggle (that surface belongs to
 *    `core-components/legacy-components-toggle-regression.spec.ts`).
 *
 * The minimize state is read from `data.showNode`, not `node.minimized`:
 * `minimized` is the catalog default and does not track the user's action
 * (verified — after minimizing the Prompt Template, `showNode` was `false`
 * while `minimized` stayed `false`).
 */

test.describe("Canvas — minimize and expand a component", () => {
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
      data: { showNode?: boolean };
    }>;
  }

  test.beforeEach(async ({ page, request }) => {
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

    // The canvas autosave is debounced, so the flow is still node-less on the
    // server right after the component renders. Gate on server truth before
    // reading `showNode` from it.
    await expect
      .poll(async () => (await fetchNodes(request, createdFlowId!)).length, {
        timeout: 30000,
        message: "the added component should be persisted before minimizing",
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

  test("user must be able to minimize and expand a component",
    { tag: ["@stable", "@release", "@workspace", "@ui-ux"] },
    async ({ page, request }) => {
      const node = page.locator(".react-flow__node").first();
      const hiddenHandles = node.locator(".react-flow__handle.no-show");
      const flowId = createdFlowId!;

      const readShowNode = async () => {
        const nodes = await fetchNodes(request, flowId);
        expect(nodes.length, "the flow should hold exactly one node").toBe(1);
        return nodes[0].data.showNode;
      };

      /**
       * Selects the node and opens its toolbar options menu.
       *
       * The ⋮ trigger is DISPATCHED to, not clicked: a real coordinate click on it
       * is hit-tested by the ReactFlow pane and DESELECTS the node, which unmounts
       * the floating `NodeToolbar` and destroys the Radix menu as it opens —
       * reproduced at `--workers=1` with no backend load in #867, and the reason
       * `helpers/ui/expand-focused-node.ts` drives the same button this way. The
       * node body click above stays a real click: the body lives in the pane and
       * selects correctly.
       *
       * This mattered more once #1290 moved the repeated-toggle step in below: the
       * menu now opens ten times per run instead of two.
       */
      const openNodeMenu = async () => {
        await node.click();
        const moreOptions = page.getByTestId("more-options-modal");
        await moreOptions.dispatchEvent("pointerdown");
        await moreOptions.dispatchEvent("pointerup");
        await moreOptions.dispatchEvent("click");
      };

      let expandedHeight = 0;
      let minimizedHeight = 0;

      await test.step("The node starts expanded", async () => {
        await expect(hiddenHandles).toHaveCount(0);
        const box = await node.boundingBox();
        expect(box, "the node must be on screen").not.toBeNull();
        expandedHeight = box!.height;
      });

      await test.step("Minimize collapses the node", async () => {
        await openNodeMenu();
        await page.getByTestId("minimize-button-modal").click();

        // Every handle on a minimized node is rendered with `no-show`; a
        // count > 0 is the durable DOM signal (heights shift with styling).
        await expect(hiddenHandles.first()).toBeVisible({ timeout: 10000 });
        await expect
          .poll(async () => (await node.boundingBox())!.height, {
            timeout: 10000,
            message: "the minimized node should be shorter than the expanded one",
          })
          .toBeLessThan(expandedHeight);
        minimizedHeight = (await node.boundingBox())!.height;
      });

      await test.step("The minimized state reached the backend", async () => {
        await expect
          .poll(readShowNode, {
            timeout: 20000,
            message: "minimizing should persist data.showNode = false",
          })
          .toBe(false);
      });

      await test.step("Expand restores the node", async () => {
        await openNodeMenu();
        // The item swaps identity rather than toggling under one testid.
        await page.getByTestId("expand-button-modal").click();

        await expect(hiddenHandles).toHaveCount(0, { timeout: 10000 });
        // Compared against the minimized height, not the original expanded one:
        // selecting the node adds affordances, so the restored height is close
        // to — but not exactly — the first measurement.
        await expect
          .poll(async () => (await node.boundingBox())!.height, {
            timeout: 10000,
            message: "the expanded node should be taller than the minimized one",
          })
          .toBeGreaterThan(minimizedHeight);
      });

      await test.step("The expanded state reached the backend", async () => {
        await expect
          .poll(readShowNode, {
            timeout: 20000,
            message: "expanding should persist data.showNode = true",
          })
          .toBe(true);
      });

      // Moved here from `ui-ux/general-bugs-minimize-state-error.spec.ts`, which
      // #1290 deleted: that file duplicated everything above with weaker
      // assertions (a `hide-node-content` count, no geometry, no server truth) and
      // added exactly one thing this test lacked — REPETITION, which was the
      // original bug: the state error showed up only after toggling several times,
      // never on the first cycle. It is a step rather than a second test so it
      // reuses the node, the menu helper and the persisted-state reader already
      // established here, and so it runs in the daily at all (the deleted file was
      // not `@stable`, i.e. no scheduled lane ever executed it).
      await test.step("Toggling repeatedly keeps both states correct", async () => {
        // Four MORE cycles: the steps above already performed one, so the node is
        // toggled five times in total — the deleted file's loop count.
        //
        // Each half is a retried unit (`toPass`), the same shape
        // `expandFocusedNode` uses, because the menu open is the fragile part: if
        // the ⋮ ever loses the selection the menu never renders and the item click
        // would otherwise time out on actionability with no attribution.
        for (let cycle = 1; cycle <= 4; cycle++) {
          await expect(async () => {
            if ((await hiddenHandles.count()) > 0) return; // already minimized
            await openNodeMenu();
            await page.getByTestId("minimize-button-modal").click({ timeout: 5000 });
            await expect(hiddenHandles.first()).toBeVisible({ timeout: 5000 });
          }, `cycle ${cycle}: minimizing should hide the handles`).toPass({
            timeout: 30000,
          });

          await expect(async () => {
            if ((await hiddenHandles.count()) === 0) return; // already expanded
            await openNodeMenu();
            await page.getByTestId("expand-button-modal").click({ timeout: 5000 });
            await expect(hiddenHandles).toHaveCount(0, { timeout: 5000 });
          }, `cycle ${cycle}: expanding should restore the handles`).toPass({
            timeout: 30000,
          });
        }

        // The store and the backend still agree after the round trips — a stale
        // `showNode` is the shape the original bug produced.
        await expect
          .poll(readShowNode, {
            timeout: 20000,
            message: "the node should end expanded, and say so on the server",
          })
          .toBe(true);
      });
    },
  );
});
