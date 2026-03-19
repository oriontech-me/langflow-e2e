import * as dotenv from "dotenv";
import path from "path";
import { expect, test } from "../../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../../helpers/other/await-bootstrap-test";
import { selectGptModel } from "../../../../helpers/mcp/select-gpt-model";
import { selectAnthropicModel } from "../../../../helpers/mcp/select-anthropic-model";
import { selectGeminiModel } from "../../../../helpers/mcp/select-gemini-model";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Opens the Playground, starts a fresh session, sends a message and waits for
 * the agent to finish executing.
 * Returns the count of bot messages BEFORE sending (for assertion after).
 */
async function sendMessageInPlayground(
  page: import("@playwright/test").Page,
  message: string,
): Promise<number> {
  await page.getByTestId("playground-btn-flow-io").click();
  await page.waitForSelector('[data-testid="input-chat-playground"]', {
    timeout: 30000,
  });

  // Always start a fresh session so each test is isolated
  await page
    .getByTestId("new-chat")
    .waitFor({ state: "visible", timeout: 15000 });
  await page.getByTestId("new-chat").click();
  await page.waitForSelector('[data-testid="input-chat-playground"]', {
    timeout: 10000,
  });

  const messageCountBefore = await page
    .getByTestId("div-chat-message")
    .count();

  const chatInput = page.getByTestId("input-chat-playground").last();

  // Wait for any pre-filled default value to populate, then clear it.
  // Clearing via keyboard (Control+a → Backspace) fires a real browser input
  // event, which triggers React onChange and clears the Zustand store.
  // Plain fill() uses CDP insertText and does not replace an existing value.
  await page
    .waitForFunction(
      () => {
        const els = document.querySelectorAll(
          '[data-testid="input-chat-playground"]',
        );
        const el = els[els.length - 1] as HTMLTextAreaElement;
        return el && el.value.length > 0;
      },
      { timeout: 5000 },
    )
    .catch(() => {});

  await chatInput.click();
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Backspace");
  await chatInput.fill(message);
  await page.getByTestId("button-send").last().click();

  // Wait for execution to finish: Stop button appears then disappears
  const stopButton = page.getByRole("button", { name: "Stop" });
  try {
    await stopButton.waitFor({ state: "visible", timeout: 30000 });
    await stopButton.waitFor({ state: "hidden", timeout: 120000 });
  } catch {
    // Stop button may appear and disappear too fast to catch both transitions
  }

  return messageCountBefore;
}

// ─── Smoke ────────────────────────────────────────────────────────────────────

test(
  "Agent component can be added to canvas with correct handles",
  { tag: ["@release", "@components"] },
  async ({ page }) => {
    await awaitBootstrapTest(page);
    await page.getByTestId("blank-flow").click();

    await page.getByTestId("sidebar-search-input").fill("agent");
    await page.waitForSelector('[data-testid="models_and_agentsAgent"]', {
      timeout: 10000,
    });
    await page.getByTestId("models_and_agentsAgent").hover();
    await page.getByTestId("add-component-button-agent").click();

    await expect(page.locator(".react-flow__node")).toHaveCount(1, {
      timeout: 10000,
    });

    // Verify all documented handles are present
    await expect(
      page.getByTestId("handle-agent-shownode-tools-left"),
    ).toBeVisible({ timeout: 5000 });
    await expect(
      page.getByTestId("handle-agent-shownode-language model-left"),
    ).toBeVisible({ timeout: 5000 });
    await expect(
      page.getByTestId("handle-agent-shownode-response-right"),
    ).toBeVisible({ timeout: 5000 });
    // Input handle: display_name="Input" on MessageInput → portName = "input"
    await expect(
      page.getByTestId("handle-agent-shownode-input-left"),
    ).toBeVisible({ timeout: 5000 });
  },
);

// ─── Canvas connections ────────────────────────────────────────────────────────

test(
  "Agent connects to Chat Input and Chat Output forming a valid flow",
  { tag: ["@release", "@components"] },
  async ({ page }) => {
    await awaitBootstrapTest(page);
    await page.getByTestId("blank-flow").click();

    // Add Chat Output first (via hover + button)
    await page.getByTestId("sidebar-search-input").fill("chat output");
    await page.waitForSelector('[data-testid="input_outputChat Output"]', {
      timeout: 10000,
    });
    await page.getByTestId("input_outputChat Output").hover();
    await page.getByTestId("add-component-button-chat-output").click();

    // Add Chat Input via dragTo to avoid overlap with Chat Output
    await page.getByTestId("sidebar-search-input").clear();
    await page.getByTestId("sidebar-search-input").fill("chat input");
    await page.waitForSelector('[data-testid="input_outputChat Input"]', {
      timeout: 10000,
    });
    await page.getByTestId("input_outputChat Input").dragTo(
      page.locator('//*[@id="react-flow-id"]'),
      { targetPosition: { x: 100, y: 100 } },
    );

    // Add Agent via dragTo to a distinct canvas area
    await page.getByTestId("sidebar-search-input").clear();
    await page.getByTestId("sidebar-search-input").fill("agent");
    await page.waitForSelector('[data-testid="models_and_agentsAgent"]', {
      timeout: 10000,
    });
    await page.getByTestId("models_and_agentsAgent").dragTo(
      page.locator('//*[@id="react-flow-id"]'),
      { targetPosition: { x: 400, y: 300 } },
    );

    await expect(page.locator(".react-flow__node")).toHaveCount(3, {
      timeout: 10000,
    });

    // Connect Chat Input → Agent "Input" handle (display_name="Input")
    await page
      .getByTestId("handle-chatinput-noshownode-chat message-source")
      .click();
    await page.getByTestId("handle-agent-shownode-input-left").click();
    await expect(page.locator(".react-flow__edge")).toHaveCount(1, {
      timeout: 8000,
    });

    // Connect Agent "Response" → Chat Output
    await page.getByTestId("handle-agent-shownode-response-right").click();
    await page
      .getByTestId("handle-chatoutput-noshownode-inputs-target")
      .click();
    await expect(page.locator(".react-flow__edge")).toHaveCount(2, {
      timeout: 8000,
    });

    // Playground button must be available when Chat I/O are present and connected
    await expect(page.getByTestId("playground-btn-flow-io")).toBeVisible({
      timeout: 5000,
    });
  },
);

// ─── Simple Agent template ────────────────────────────────────────────────────

test(
  "Simple Agent template loads with correct node and edge structure",
  { tag: ["@release", "@components"] },
  async ({ page }) => {
    await awaitBootstrapTest(page);

    await page.getByTestId("side_nav_options_all-templates").click();
    await page.getByRole("heading", { name: "Simple Agent" }).first().click();
    await page.waitForSelector('[data-testid="canvas_controls_dropdown"]', {
      timeout: 30000,
    });

    const nodeCount = await page.locator(".react-flow__node").count();
    expect(nodeCount).toBeGreaterThanOrEqual(1);

    const edgeCount = await page.locator(".react-flow__edge").count();
    expect(edgeCount).toBeGreaterThanOrEqual(1);

    // Playground button requires Chat I/O components in the flow
    await expect(page.getByTestId("playground-btn-flow-io")).toBeVisible({
      timeout: 5000,
    });
  },
);

// ─── Reasoning steps in the Playground ────────────────────────────────────────
//
// Scenario 18.2: "Agent exibe steps de raciocínio no Playground"
//
// The agent must use at least one tool so that ContentBlockDisplay renders
// "Called tool <name>" accordion items in the bot message.
// The message deliberately asks for tool usage to ensure steps appear.
//
// DOM structure (from ContentBlockDisplay.tsx + bot-message.tsx):
//   - hideHeader=true in bot-message → accordion always rendered (no toggle needed)
//   - Each tool call → <AccordionTrigger> with text "Called tool <name>"
//   - Clicking the trigger expands <AccordionContent> (data-state="open")
//   - After execution → bot-message renders "Finished in Xs" status text

test.describe.serial("Agent reasoning steps in Playground", () => {
  test(
    "Simple Agent shows tool call steps in Playground with OpenAI provider",
    { tag: ["@release", "@components"] },
    async ({ page }) => {
      if (!process.env.CI) {
        dotenv.config({ path: path.resolve(__dirname, "../../../../../.env") });
      }

      test.skip(
        !process?.env?.OPENAI_API_KEY,
        "OPENAI_API_KEY required to run this test",
      );

      await awaitBootstrapTest(page);
      await page.getByTestId("side_nav_options_all-templates").click();
      await page.getByRole("heading", { name: "Simple Agent" }).first().click();
      await page.waitForSelector('[data-testid="canvas_controls_dropdown"]', {
        timeout: 30000,
      });

      await selectGptModel(page);

      const messageCountBefore = await sendMessageInPlayground(
        page,
        // Explicit tool-use instruction ensures content_blocks are populated
        "You MUST use the Calculator tool. Compute 987 multiplied by 654 using the tool. Do not answer from memory.",
      );

      // 1. A new bot message must appear
      await expect(page.getByTestId("div-chat-message")).toHaveCount(
        messageCountBefore + 1,
        { timeout: 60000 },
      );

      // 2. "Finished in Xs" status appears after execution completes
      await expect(page.getByText(/Finished in/i)).toBeVisible({
        timeout: 60000,
      });

      // 3. At least one "Called tool" reasoning step must be visible
      //    (proves content_blocks were populated and ContentBlockDisplay rendered)
      await expect(
        page.getByText(/Called tool/i).first(),
      ).toBeVisible({ timeout: 10000 });

      // 4. Clicking the first tool step expands its accordion content.
      //    AccordionTrigger uses asChild=<div> (not <button>), so click the text directly.
      await page.getByText(/Called tool/i).first().click();

      // Radix AccordionItem/AccordionContent sets data-state="open" when expanded
      await expect(
        page.locator('[data-state="open"]').first(),
      ).toBeVisible({ timeout: 5000 });
    },
  );

  test(
    "Simple Agent shows tool call steps in Playground with Anthropic provider",
    { tag: ["@release", "@components"] },
    async ({ page }) => {
      if (!process.env.CI) {
        dotenv.config({ path: path.resolve(__dirname, "../../../../../.env") });
      }

      test.skip(
        !process?.env?.ANTHROPIC_API_KEY,
        "ANTHROPIC_API_KEY required to run this test",
      );

      await awaitBootstrapTest(page);
      await page.getByTestId("side_nav_options_all-templates").click();
      await page.getByRole("heading", { name: "Simple Agent" }).first().click();
      await page.waitForSelector('[data-testid="canvas_controls_dropdown"]', {
        timeout: 30000,
      });

      await selectAnthropicModel(page);

      const messageCountBefore = await sendMessageInPlayground(
        page,
        "You MUST use the Calculator tool. Compute 987 multiplied by 654 using the tool. Do not answer from memory.",
      );

      await expect(page.getByTestId("div-chat-message")).toHaveCount(
        messageCountBefore + 1,
        { timeout: 60000 },
      );

      await expect(page.getByText(/Finished in/i)).toBeVisible({
        timeout: 60000,
      });

      await expect(
        page.getByText(/Called tool/i).first(),
      ).toBeVisible({ timeout: 10000 });

      await page.getByText(/Called tool/i).first().click();

      await expect(
        page.locator('[data-state="open"]').first(),
      ).toBeVisible({ timeout: 5000 });
    },
  );

  test(
    "Simple Agent shows tool call steps in Playground with Google Gemini provider",
    { tag: ["@release", "@components"] },
    async ({ page }) => {
      if (!process.env.CI) {
        dotenv.config({ path: path.resolve(__dirname, "../../../../../.env") });
      }

      test.skip(
        !process?.env?.GOOGLE_API_KEY,
        "GOOGLE_API_KEY required to run this test",
      );

      await awaitBootstrapTest(page);
      await page.getByTestId("side_nav_options_all-templates").click();
      await page.getByRole("heading", { name: "Simple Agent" }).first().click();
      await page.waitForSelector('[data-testid="canvas_controls_dropdown"]', {
        timeout: 30000,
      });

      await selectGeminiModel(page);

      const messageCountBefore = await sendMessageInPlayground(
        page,
        "You MUST use the Calculator tool. Compute 987 multiplied by 654 using the tool. Do not answer from memory.",
      );

      await expect(page.getByTestId("div-chat-message")).toHaveCount(
        messageCountBefore + 1,
        { timeout: 60000 },
      );

      await expect(page.getByText(/Finished in/i)).toBeVisible({
        timeout: 60000,
      });

      await expect(
        page.getByText(/Called tool/i).first(),
      ).toBeVisible({ timeout: 10000 });

      await page.getByText(/Called tool/i).first().click();

      await expect(
        page.locator('[data-state="open"]').first(),
      ).toBeVisible({ timeout: 5000 });
    },
  );

  test(
    "Simple Agent correctly switches provider from OpenAI to Anthropic and shows reasoning steps",
    { tag: ["@release", "@components"] },
    async ({ page }) => {
      if (!process.env.CI) {
        dotenv.config({ path: path.resolve(__dirname, "../../../../../.env") });
      }

      test.skip(
        !process?.env?.OPENAI_API_KEY || !process?.env?.ANTHROPIC_API_KEY,
        "OPENAI_API_KEY and ANTHROPIC_API_KEY are both required for this test",
      );

      await awaitBootstrapTest(page);
      await page.getByTestId("side_nav_options_all-templates").click();
      await page.getByRole("heading", { name: "Simple Agent" }).first().click();
      await page.waitForSelector('[data-testid="canvas_controls_dropdown"]', {
        timeout: 30000,
      });

      // Configure OpenAI first, then switch to Anthropic
      await selectGptModel(page);
      await selectAnthropicModel(page);

      // Model dropdown must reflect the Anthropic selection after the switch
      await expect(
        page.getByTestId("value-dropdown-model_model"),
      ).toContainText("claude", { timeout: 5000 });

      const messageCountBefore = await sendMessageInPlayground(
        page,
        "You MUST use the Calculator tool. Compute 987 multiplied by 654 using the tool. Do not answer from memory.",
      );

      await expect(page.getByTestId("div-chat-message")).toHaveCount(
        messageCountBefore + 1,
        { timeout: 60000 },
      );

      await expect(page.getByText(/Finished in/i)).toBeVisible({
        timeout: 60000,
      });

      await expect(
        page.getByText(/Called tool/i).first(),
      ).toBeVisible({ timeout: 10000 });

      await page.getByText(/Called tool/i).first().click();

      await expect(
        page.locator('[data-state="open"]').first(),
      ).toBeVisible({ timeout: 5000 });
    },
  );
});
