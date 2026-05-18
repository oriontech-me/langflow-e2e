import { expect, test } from "../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";

test(
  "user can add components by hovering and clicking the plus icon",
  { tag: ["@release", "@components", "@workspace", "@stable"] },

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

    await componentLocator.hover();
    await plusIcon.click();

    await expect(page.locator(".react-flow__node").first()).toBeVisible({
      timeout: 10000,
    });
  },
);
