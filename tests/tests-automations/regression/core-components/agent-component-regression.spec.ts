import type { Page } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";
import { adjustScreenView } from "../../../helpers/ui/adjust-screen-view";
import { cleanAllFlows } from "../../../helpers/flows/clean-all-flows";

// Each test creates a flow that autosaves to the backend. Serial mode prevents
// parallel autosave races and keeps cleanAllFlows deterministic between tests.
test.describe.configure({ mode: "serial" });

async function addAgentToBlankFlow(page: Page): Promise<void> {
  await awaitBootstrapTest(page);
  await page.waitForSelector('[data-testid="blank-flow"]', { timeout: 30000 });
  await page.getByTestId("blank-flow").click();

  await page.getByTestId("disclosure-models & agents").click();
  await page.waitForSelector('[data-testid="models_and_agentsAgent"]', {
    timeout: 10000,
    state: "visible",
  });
  await page
    .getByTestId("models_and_agentsAgent")
    .dragTo(page.locator('//*[@id="react-flow-id"]'), {
      targetPosition: { x: 300, y: 300 },
    });

  await adjustScreenView(page, { numberOfZoomOut: 2 });
  await expect(page.getByTestId("title-Agent")).toBeVisible({ timeout: 10000 });
}

test.describe("Agent Component — canvas regression", () => {
  test.afterEach(async ({ page }) => {
    try {
      await page.goto("/");
      await cleanAllFlows(page);
    } catch {
      // best-effort cleanup
    }
  });

  test(
    "renders on canvas with default fields and handles",
    { tag: ["@stable", "@release", "@regression", "@components", "@agents"] },
    async ({ page }) => {
      await addAgentToBlankFlow(page);

      await expect(page.locator(".react-flow__node")).toHaveCount(1, {
        timeout: 10000,
      });

      await expect(page.getByTestId("title-Agent")).toBeVisible({ timeout: 5000 });

      await expect(
        page.getByTestId("handle-agent-shownode-tools-left"),
      ).toBeVisible({ timeout: 5000 });
      await expect(
        page.getByTestId("handle-agent-shownode-language model-left"),
      ).toBeVisible({ timeout: 5000 });
      await expect(
        page.getByTestId("handle-agent-shownode-response-right"),
      ).toBeVisible({ timeout: 5000 });

      await expect(page.getByTestId("textarea_str_system_prompt")).toBeVisible({
        timeout: 5000,
      });

      await expect(page.getByTestId("value-dropdown-model_model")).toBeVisible({
        timeout: 5000,
      });
    },
  );

  test(
    "system prompt accepts input and persists across flow reload",
    { tag: ["@stable", "@release", "@regression", "@components", "@agents"] },
    async ({ page }) => {
      // Body added in Task 3.
    },
  );

  test(
    "model dropdown exposes manage-model-providers and lists configured models",
    { tag: ["@stable", "@release", "@regression", "@components", "@agents"] },
    async ({ page }) => {
      // Body added in Task 4.
    },
  );

  test(
    "selecting a different-provider model swaps the canvas provider icon",
    { tag: ["@stable", "@release", "@regression", "@components", "@agents"] },
    async ({ page }) => {
      // Body added in Task 5.
    },
  );
});
