import type { Page } from "@playwright/test";
import { addCustomComponentFromSidebar } from "./add-component-from-sidebar";

/**
 * Adds a blank Custom Component to the canvas via the dedicated
 * `sidebar-custom-component-button`, and does not return until a node actually
 * landed.
 *
 * It used to spin its own retry loop:
 *
 * ```ts
 * while (numberOfCustomComponents === 0) {
 *   await page.getByTestId("sidebar-custom-component-button").click();
 *   numberOfCustomComponents = await page
 *     .locator('[data-testid="title-Custom Component"]').count();
 * }
 * ```
 *
 * That was right about the mechanism — Langflow drops this click and an identical
 * second one repairs it (#1301: 14 of 16 swallowed, 14 of 14 repaired, nightly
 * 1.12.0.dev23) — and wrong in three ways that mattered.
 *
 * 1. **Unbounded.** With the add genuinely broken it clicks forever, and the
 *    caller dies on the 5-minute test timeout with no cause named. #1304's rule
 *    is that a swallowed add is reported AS a swallowed add, so it stays eligible
 *    for `@stable` auto-removal instead of reading as a hung test.
 * 2. **No delay between clicks**, so a landed-but-not-yet-rendered add is clicked
 *    again and leaves TWO components on a canvas whose callers assert exact
 *    counts.
 * 3. **Keyed on `title-Custom Component`, a name the caller may already have
 *    changed** — `edit-name-description-node.spec.ts` renames the node — so the
 *    loop could not be reused by the specs that most needed it.
 *
 * The repair now lives in the shared primitive, which judges the add by a set
 * difference over canvas node ids (never a count delta — see #1304) and throws
 * naming the swallowed click plus the observed sidebar state when two attempts
 * both produce nothing.
 */
export const addCustomComponent = async (page: Page) => {
  await addCustomComponentFromSidebar(page);
};
