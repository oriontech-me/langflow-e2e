import { expect, type Page } from "@playwright/test";

/**
 * Spreads the canvas nodes vertically so none of them overlaps another.
 *
 * Components added from the sidebar's `+` button all land at the same default
 * position, offset by ~10px each. Stacked nodes make every canvas interaction
 * ambiguous: the topmost node's subtree intercepts pointer events aimed at a
 * handle underneath it, so a `click()` on a perfectly valid handle times out —
 * or, worse, silently lands on the wrong handle and produces a *different*
 * connection than the test intended (observed on #939, where a
 * type-incompatible pair appeared to connect).
 *
 * Each node after the first is dragged down by a fixed step; the helper then
 * polls until every pair of bounding boxes is vertically disjoint, so callers
 * can interact with handles by testid without `force`.
 *
 * Nodes are dragged from just below their top edge — the node header is the
 * drag handle, and pressing the body can land on an interactive field.
 *
 * @param page   Playwright page positioned on the flow canvas.
 * @param stepY  Vertical distance between consecutive nodes, in screen pixels.
 */
export async function separateOverlappingNodes(
  page: Page,
  stepY = 220,
): Promise<void> {
  const nodes = page.locator(".react-flow__node");
  const count = await nodes.count();
  if (count < 2) return;

  for (let i = 1; i < count; i++) {
    const box = await nodes.nth(i).boundingBox();
    expect(box, `node ${i} must be on screen to be separated`).not.toBeNull();

    const startX = box!.x + box!.width / 2;
    const startY = box!.y + 8;

    // ReactFlow starts a node drag from intermediate move events; a single
    // jump from press to release is swallowed and the node stays put.
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX, startY + stepY * i, { steps: 12 });
    await page.mouse.up();
  }

  await expect
    .poll(
      async () => {
        const boxes = await nodes.evaluateAll((els) =>
          els.map((el) => {
            const r = el.getBoundingClientRect();
            return { top: r.top, bottom: r.bottom };
          }),
        );
        return boxes.every((a, i) =>
          boxes.every((b, j) => i === j || a.bottom < b.top || b.bottom < a.top),
        );
      },
      {
        timeout: 15000,
        message: "canvas nodes should not overlap after being separated",
      },
    )
    .toBe(true);
}
