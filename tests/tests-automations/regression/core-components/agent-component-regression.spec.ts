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
      // The /flows a11y refactor (Langflow #13891) makes the card content
      // pointer-events-none; open the flow via the card's overlay button.
      await page
        .getByTestId("list-card")
        .filter({
          has: page
            .getByTestId("flow-name-div")
            .filter({ hasText: flowName }),
        })
        .getByTestId("list-card-open-button")
        .first()
        .click();

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
      test.skip(
        optionCount === 0,
        "No providers configured in local Langflow — per-provider assertions cannot run",
      );

      // Per-provider conditional assertions — only assert when the option exists.
      // Scope the icon lookup to the option row so we never match the canvas
      // trigger icon (genericIconComponent renders `icon-{Provider}` in both
      // ModelTrigger.tsx and ModelList.tsx).
      const openaiOptions = page.locator('[data-testid^="gpt-"][data-testid$="-option"]');
      if ((await openaiOptions.count()) > 0) {
        const firstOpenaiOption = openaiOptions.first();
        await expect(firstOpenaiOption).toBeVisible({ timeout: 5000 });
        await expect(firstOpenaiOption.getByTestId("icon-OpenAI")).toBeVisible({
          timeout: 5000,
        });
      }

      const anthropicOptions = page.locator(
        '[data-testid^="claude-"][data-testid$="-option"]',
      );
      if ((await anthropicOptions.count()) > 0) {
        const firstAnthropicOption = anthropicOptions.first();
        await expect(firstAnthropicOption).toBeVisible({ timeout: 5000 });
        await expect(firstAnthropicOption.getByTestId("icon-Anthropic")).toBeVisible({
          timeout: 5000,
        });
      }
    },
  );

  test(
    "selecting a different-provider model swaps the canvas provider icon",
    { tag: ["@stable", "@release", "@regression", "@components", "@agents"] },
    async ({ page }) => {
      await addAgentToBlankFlow(page);

      // Probe the dropdown once to determine whether both providers are pre-configured.
      await page.getByTestId("value-dropdown-model_model").click();
      const openaiOption = page
        .locator('[data-testid^="gpt-"][data-testid$="-option"]')
        .first();
      const anthropicOption = page
        .locator('[data-testid^="claude-"][data-testid$="-option"]')
        .first();
      const hasOpenAI = (await openaiOption.count()) > 0;
      const hasAnthropic = (await anthropicOption.count()) > 0;

      test.skip(
        !hasOpenAI || !hasAnthropic,
        "Test 4 requires both OpenAI and Anthropic to be pre-configured in the local Langflow instance",
      );

      // Capture the option testids so we can re-open the dropdown and re-select deterministically.
      const openaiTestId = await openaiOption.getAttribute("data-testid");
      const anthropicTestId = await anthropicOption.getAttribute("data-testid");
      if (!openaiTestId || !anthropicTestId) {
        throw new Error("Failed to capture provider option testids from dropdown");
      }

      // Scope provider-icon assertions to the model dropdown trigger button
      // itself (`data-testid="model_model"`). `genericIconComponent` renders
      // `icon-{Provider}` in three places — the trigger (`ModelTrigger.tsx`),
      // the option rows (`ModelList.tsx`), and the popover footer — so a
      // broader scope (the ReactFlow node or `-main-node`) would yield false
      // positives whenever the popover is mounted. The popover uses
      // `PopoverContentWithoutPortal`, so it sits inside the same node DOM
      // subtree as the trigger and cannot be scoped out by ancestor alone.
      // Note: `-main-node` covers only the title bar; in the expanded node
      // (`GenericNode/index.tsx`) `RenderInputParameters` is a SIBLING of
      // `-main-node`, so the trigger isn't inside it either.
      const modelTrigger = page.getByTestId("model_model");

      // Select OpenAI model first.
      await openaiOption.click();
      await expect(modelTrigger.getByTestId("icon-OpenAI")).toBeVisible({
        timeout: 5000,
      });

      // Switch to Anthropic model.
      await page.getByTestId("value-dropdown-model_model").click();
      await page.getByTestId(anthropicTestId).click();
      await expect(modelTrigger.getByTestId("icon-Anthropic")).toBeVisible({
        timeout: 5000,
      });

      // The OpenAI icon must no longer appear inside the trigger.
      await expect(modelTrigger.getByTestId("icon-OpenAI")).toHaveCount(0, {
        timeout: 5000,
      });
    },
  );
});
