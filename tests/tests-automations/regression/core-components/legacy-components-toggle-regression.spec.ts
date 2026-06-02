import { expect, test } from "../../../fixtures/fixtures";
import { addLegacyComponents } from "../../../helpers/flows/add-legacy-components";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";

test(
  "Show Legacy Components toggle controls visibility of legacy components in the sidebar",
  { tag: ["@stable", "@regression", "@components"] },
  async ({ page }) => {
    await test.step("Open a blank flow", async () => {
      await awaitBootstrapTest(page);
      await page.getByTestId("blank-flow").click();
      await expect(page.getByTestId("sidebar-search-input")).toBeVisible({
        timeout: 10000,
      });
    });

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
