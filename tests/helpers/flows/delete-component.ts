import type { Page } from "@playwright/test";

export type DeleteMethod = "backspace" | "menu";

/**
 * Deletes a single component from the canvas.
 *
 * Selects the node (clicking it activates its selection/toolbar) and removes it
 * either with the Backspace key or via the node options (...) menu. Neither the
 * 3-dot button nor the "Delete" item has its own testid, so the menu path
 * targets their inner icons (`icon-MoreHorizontal` → `icon-Delete`).
 *
 * For a single-node canvas by default; pass a `node` locator to target a
 * specific one. Multi-node marquee deletion is a distinct selection flow and is
 * not covered by this helper.
 *
 * @param page    Playwright page positioned on the flow canvas.
 * @param method  `"backspace"` (default) or `"menu"`.
 * @param node    Optional node locator; defaults to the first `.react-flow__node`.
 */
export async function deleteComponent(
  page: Page,
  method: DeleteMethod = "backspace",
  node = page.locator(".react-flow__node").first(),
) {
  await node.click();
  if (method === "menu") {
    await page.getByTestId("icon-MoreHorizontal").click();
    await page.getByTestId("icon-Delete").click();
  } else {
    await page.keyboard.press("Backspace");
  }
}
