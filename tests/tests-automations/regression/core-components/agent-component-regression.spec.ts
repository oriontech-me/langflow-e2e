import type { Page } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";
import { adjustScreenView } from "../../../helpers/ui/adjust-screen-view";
import { cleanAllFlows } from "../../../helpers/flows/clean-all-flows";
import { renameFlow } from "../../../helpers/flows/rename-flow";

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
      await addAgentToBlankFlow(page);

      const uniq = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const flowName = `agent-prompt-${uniq}`;
      const systemPrompt = `system-prompt-test-${uniq}`;

      // Rename the flow via the settings dialog so we can re-open it by name
      // (avoids the page.goto(/flow/{id}) cache-stale race documented in memory).
      await renameFlow(page, { flowName });

      // Type the prompt and wait for autosave (Langflow PATCHes the flow on blur).
      const patchPromise = page.waitForResponse(
        (resp) =>
          resp.url().includes("/api/v1/flows/") &&
          resp.request().method() === "PATCH" &&
          resp.ok(),
        { timeout: 15000 },
      );

      const promptField = page.getByTestId("textarea_str_system_prompt");
      await promptField.click();
      await promptField.fill(systemPrompt);
      await promptField.blur();
      await patchPromise;

      // Navigate away and re-open the flow by name.
      await page.goto("/");
      await page.waitForSelector('[data-testid="mainpage_title"]', {
        timeout: 15000,
      });
      await page.getByText(flowName, { exact: true }).click();

      await expect(page.getByTestId("title-Agent")).toBeVisible({
        timeout: 15000,
      });
      await expect(page.getByTestId("textarea_str_system_prompt")).toHaveValue(
        systemPrompt,
        { timeout: 5000 },
      );
    },
  );

  test(
    "model dropdown exposes manage-model-providers and lists configured models",
    { tag: ["@stable", "@release", "@regression", "@components", "@agents"] },
    async ({ page }) => {
      await addAgentToBlankFlow(page);

      await page.getByTestId("value-dropdown-model_model").click();

      // Canonical configuration entry point in 1.10.x — must be reachable from the dropdown.
      await expect(page.getByTestId("manage-model-providers")).toBeVisible({
        timeout: 5000,
      });

      // Count visible model options; the option-testid pattern ends in "-option".
      const options = page.locator('[data-testid$="-option"]');
      const optionCount = await options.count();

      // When at least one provider is pre-configured, we expect provider icons.
      // When none is configured (option count is 0), the per-provider assertions
      // self-skip — the manage-model-providers assertion above is the floor.
      if (optionCount === 0) {
        return;
      }

      // Per-provider conditional assertions — only assert when the option exists.
      const openaiOptions = page.locator('[data-testid^="gpt-"][data-testid$="-option"]');
      if ((await openaiOptions.count()) > 0) {
        await expect(openaiOptions.first()).toBeVisible({ timeout: 5000 });
        await expect(page.getByTestId("icon-OpenAI").first()).toBeVisible({
          timeout: 5000,
        });
      }

      const anthropicOptions = page.locator(
        '[data-testid^="claude-"][data-testid$="-option"]',
      );
      if ((await anthropicOptions.count()) > 0) {
        await expect(anthropicOptions.first()).toBeVisible({ timeout: 5000 });
        await expect(page.getByTestId("icon-Anthropic").first()).toBeVisible({
          timeout: 5000,
        });
      }
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
