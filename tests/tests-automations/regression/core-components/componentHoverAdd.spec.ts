import { expect, test } from "../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";
import { trackCreatedFlows } from "../../../helpers/flows/track-created-flows";

// This spec bootstraps through the UI (`awaitBootstrapTest` + `blank-flow`), so
// the flow it works on is created by the app, not by the test — and it was
// deleted by nobody: 14 "New Flow" orphans had accumulated on the local instance
// by the time #1384 was worked. The tracker captures every
// `POST /api/v1/flows` → 201 the page makes and deletes those ids in `afterEach`
// (repo convention, #490/#681; shared implementation from #1108).
let flows: ReturnType<typeof trackCreatedFlows> | undefined;

test.afterEach(async ({ request }) => {
  await flows?.cleanup(request);
  flows = undefined;
});

test(
  "user can add components by hovering and clicking the plus icon",
  { tag: ["@release", "@components", "@workspace", "@stable"] },

  async ({ page }) => {
    flows = trackCreatedFlows(page);
    await awaitBootstrapTest(page);

    await page.getByTestId("blank-flow").click();
    await expect(page.getByTestId("sidebar-search-input")).toBeVisible({
      timeout: 10000,
    });

    await page.getByTestId("sidebar-search-input").click();
    await page.getByTestId("sidebar-search-input").fill("chat input");

    // Two sibling elements, two jobs (#1384 / upstream #14250): the
    // `group/draggable` wrapper is the hover group AND the only ancestor the "+"
    // button sits inside, while `input_outputChat Input` is the label row the
    // user points at. The "+" used to live inside the label row — chaining off it
    // resolved nothing after the a11y restructure, which is how this failed on
    // the 2026-08-10 daily one line after asserting the row visible.
    const hoverGroup = page.getByTestId("input_output_chat input_draggable");
    const labelRow = page.getByTestId("input_outputChat Input");
    await expect(hoverGroup).toBeVisible({ timeout: 10000 });
    await expect(labelRow).toBeVisible({ timeout: 10000 });

    const plusIcon = hoverGroup.getByTestId("icon-Plus");
    await expect(plusIcon).toBeAttached();

    // Plus icon starts hidden (opacity 0 on sm+ viewports) — confirms the
    // hover-to-reveal affordance is wired up correctly.
    const initialOpacity = await plusIcon.evaluate(
      (el) => window.getComputedStyle(el).opacity,
    );
    expect(initialOpacity).toBe("0");

    // Hover via explicit mouse coordinates over the LABEL row's center, then
    // re-issue the move so the cursor stays put while Playwright polls opacity.
    // Calling `.hover()` alone proved flaky here: between polls the cursor
    // effectively left the `group/draggable` parent (opacity reverted from 0.88
    // back to 0), so the assertion saw the transition unwind. The label row is
    // the hover target on purpose — it does NOT contain the "+", so a reveal
    // observed from there proves the group-level hover is what wires it.
    //
    // The box is re-read on every attempt, and that is the fix for a second,
    // different flake seen while validating #1384: the sidebar is still settling
    // when the row first becomes visible (its component catalog streams in,
    // #537), so a box read once could be stale by the time the cursor got there
    // — the pointer landed beside the row and opacity sat at "0" for the full
    // 3 s. Measured 12/12 reveals within ~250 ms on a settled sidebar, so a
    // genuinely broken reveal class still burns the whole budget and fails; this
    // retries the POSITIONING, never the assertion.
    //
    // After hover, opacity must reach 1 — proves the
    // `group-hover/draggable:opacity-100` class actually wires the reveal.
    // Without this, a regression that removes the hover class would still pass
    // because Playwright can click an `opacity: 0` element that receives
    // pointer events.
    await expect(async () => {
      const box = await labelRow.boundingBox();
      expect(box).not.toBeNull();
      const cx = box!.x + box!.width / 2;
      const cy = box!.y + box!.height / 2;
      await page.mouse.move(cx, cy);
      await page.mouse.move(cx, cy);

      await expect(plusIcon).toHaveCSS("opacity", "1", { timeout: 2000 });
    }).toPass({ timeout: 15000, intervals: [250, 500, 1000] });
    await plusIcon.click();

    await expect(page.locator(".react-flow__node").first()).toBeVisible({
      timeout: 10000,
    });
  },
);
