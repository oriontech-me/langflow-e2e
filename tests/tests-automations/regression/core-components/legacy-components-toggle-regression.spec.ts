import { expect, test } from "../../../fixtures/fixtures";
import { addLegacyComponents } from "../../../helpers/flows/add-legacy-components";
import { setupBlankFlow } from "../../../helpers/flows/setup-blank-flow";

test.describe("Show Legacy Components toggle", () => {
  let createdFlowId: string | null = null;

  test.beforeEach(async ({ page }) => {
    // setupBlankFlow creates the flow via API (avoids the UI-creation 500 race)
    // and returns its id so afterEach can clean it up.
    createdFlowId = await setupBlankFlow(page);
    await expect(page.getByTestId("sidebar-search-input")).toBeVisible({
      timeout: 10000,
    });
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
    "Show Legacy Components toggle controls visibility of legacy components in the sidebar",
    { tag: ["@stable", "@regression", "@components"] },
    async ({ page }) => {
      await test.step("Python REPL is hidden while the toggle is OFF (baseline)", async () => {
        await page.getByTestId("sidebar-search-input").fill("Python REPL");
        // Positive control: the non-legacy substitute (Python Interpreter, whose
        // internal name is PythonREPLComponent) always matches this search, so its
        // presence proves the sidebar actually rendered results. Asserting it
        // first kills the "empty list resolves toHaveCount(0) before the filter
        // applied" race — the 0 below now means "filtered out", not "not rendered".
        await expect(
          page.getByTestId("utilitiesPython Interpreter"),
        ).toBeVisible();
        await expect(page.getByTestId("toolsPython REPL")).toHaveCount(0);
      });

      await test.step("Enable the Show Legacy Components toggle", async () => {
        // Clear the search first: an active search renders a second
        // 'sidebar-options-trigger', which would break Playwright strict mode.
        await page.getByTestId("sidebar-search-input").fill("");
        await addLegacyComponents(page);
      });

      await test.step("Python REPL is visible while the toggle is ON", async () => {
        // Same search as the baseline; only the toggle changed — so the legacy
        // component must now appear (count goes from 0 to 1).
        await page.getByTestId("sidebar-search-input").fill("Python REPL");
        await expect(page.getByTestId("toolsPython REPL")).toHaveCount(1);
      });
    },
  );
});
