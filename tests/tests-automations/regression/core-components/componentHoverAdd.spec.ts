import { expect, test } from "../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";

test(
  "user can add components by hovering and clicking the plus icon",
  { tag: ["@release", "@components", "@workspace"] },

  async ({ page }) => {
    await awaitBootstrapTest(page);

    await page.getByTestId("blank-flow").click();
    await expect(page.getByTestId("sidebar-search-input")).toBeVisible({
      timeout: 10000,
    });

    await page.getByTestId("sidebar-search-input").click();
    await page.getByTestId("sidebar-search-input").fill("chat input");

    const componentLocator = page.getByTestId("input_outputChat Input");
    await expect(componentLocator).toBeVisible({ timeout: 10000 });

    const plusIcon = componentLocator.getByTestId("icon-Plus");
    await expect(plusIcon).toBeAttached();

    // Plus icon starts hidden (opacity 0 on sm+ viewports) — confirms the
    // hover-to-reveal affordance is wired up correctly.
    const initialOpacity = await plusIcon.evaluate(
      (el) => window.getComputedStyle(el).opacity,
    );
    expect(initialOpacity).toBe("0");

    // Hover via explicit mouse coordinates over the row's center, then re-issue
    // the move so the cursor stays put while Playwright polls opacity. Calling
    // `componentLocator.hover()` alone proved flaky here: between polls the
    // cursor effectively left the `group/draggable` parent (opacity reverted
    // from 0.88 back to 0), so the assertion saw the transition unwind.
    const box = await componentLocator.boundingBox();
    expect(box).not.toBeNull();
    const cx = box!.x + box!.width / 2;
    const cy = box!.y + box!.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.move(cx, cy);

    // After hover, opacity must reach 1 — proves the
    // `group-hover/draggable:opacity-100` class actually wires the reveal.
    // Without this, a regression that removes the hover class would still pass
    // because Playwright can click an `opacity: 0` element that receives
    // pointer events. `toHaveCSS` auto-waits to the settled value, so the
    // Tailwind transition has time to land without false negatives.
    await expect(plusIcon).toHaveCSS("opacity", "1", { timeout: 3000 });
    await plusIcon.click();

    await expect(page.locator(".react-flow__node").first()).toBeVisible({
      timeout: 10000,
    });
  },
);
