import { expect, test } from "../../../fixtures/fixtures";
import { adjustScreenView } from "../../../helpers/ui/adjust-screen-view";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";

// Run tests serially to avoid "flow must be unique" 400 errors from parallel autosaves
test.describe.configure({ mode: "serial" });

// Helper: create a blank flow and add the Loop component to the canvas.
// After this call the component node is visible and the inspector is open.
async function addLoopComponent(page: any) {
  await awaitBootstrapTest(page);
  await page.getByTestId("blank-flow").click();
  await page.getByTestId("sidebar-search-input").fill("Loop");
  await page.waitForSelector('[data-testid="add-component-button-loop"]', {
    timeout: 10000,
    state: "attached",
  });
  await page.getByTestId("flow_controlsLoop").hover();
  await page.getByTestId("add-component-button-loop").click();
  await adjustScreenView(page);
  await page.waitForSelector('[data-testid="title-Loop"]', {
    timeout: 15000,
  });
}

// =============================================================================
// UI / Canvas — rendering, handles and output inspection in a single test
// =============================================================================

test(
  "Loop component — renders correctly with all handles and output inspection buttons",
  { tag: ["@stable", "@release", "@components"] },
  async ({ page }) => {
    await addLoopComponent(page);

    // Node must be visible on the canvas with its run button
    await expect(page.getByTestId("title-Loop")).toBeVisible();
    await expect(page.getByTestId("button_run_loop")).toBeVisible();
    await expect(page.locator(".react-flow__node")).toHaveCount(1);

    // Input handles (left side)
    // inputs — receives the DataFrame to iterate over
    await expect(
      page.getByTestId("handle-loopcomponent-shownode-inputs-left"),
    ).toBeVisible();
    // item — feedback port: receives the processed item to advance the loop
    await expect(
      page.getByTestId("handle-loopcomponent-shownode-item-left"),
    ).toBeVisible();

    // Output handles (right side)
    // item — emits the current item in each iteration
    await expect(
      page.getByTestId("handle-loopcomponent-shownode-item-right"),
    ).toBeVisible();
    // done — emits aggregated DataFrame when all items are processed
    await expect(
      page.getByTestId("handle-loopcomponent-shownode-done-right"),
    ).toBeVisible();

    // Output inspection buttons must be present in the node footer
    await expect(
      page.getByTestId("output-inspection-item-loopcomponent"),
    ).toBeVisible();
    await expect(
      page.getByTestId("output-inspection-done-loopcomponent"),
    ).toBeVisible();
  },
);

// =============================================================================
// Error path — run without connections
// =============================================================================

test(
  "Loop component — run without connections shows build failed notification",
  { tag: ["@stable", "@release", "@components"] },
  async ({ page }) => {
    // The Loop component requires at least an `inputs` connection to execute.
    // Running it standalone (no connections) is an expected error path —
    // the component must show a build-failed notification and NOT crash.
    (page as any).allowFlowErrors();

    await addLoopComponent(page);

    await page.getByTestId("button_run_loop").click();

    // Standalone execution → build fails; the notification must appear
    await page.waitForSelector("text=Flow build failed", { timeout: 30000 });
    await expect(page.getByText("Flow build failed")).toBeVisible();

    // The run button must still be accessible after the failure
    await expect(page.getByTestId("button_run_loop")).toBeVisible();

    // The node must remain intact on the canvas
    await expect(page.getByTestId("title-Loop")).toBeVisible();
    await expect(page.locator(".react-flow__node")).toHaveCount(1);
  },
);


// =============================================================================
// Wiring + Iteration — Research Translation Loop template: wiring and real execution
// =============================================================================

test(
  "Loop component — Research Translation Loop template: full wiring and iterates over 2 ArXiv papers",
  { tag: ["@stable", "@release", "@components", "@templates", "@playground"] },
  async ({ page }) => {
    // Override the global 5-minute cap: this flow makes 2 sequential LLM calls
    // (one per ArXiv paper) which can take 3-4 minutes on CI infrastructure.
    test.setTimeout(8 * 60 * 1000);

    await awaitBootstrapTest(page);

    // Load the Research Translation Loop template
    await page.getByTestId("side_nav_options_all-templates").click();
    await page.waitForSelector('[data-testid="template-research-translation-loop"]', {
      timeout: 10000,
    });
    await page.getByTestId("template-research-translation-loop").click();
    await page.waitForSelector('[data-testid="title-Loop"]', { timeout: 15000 });
    await adjustScreenView(page);

    // --- Wiring checks ---
    await expect(page.getByTestId("title-Loop")).toBeVisible();
    await expect(page.getByTestId("button_run_loop")).toBeVisible();

    // At least one edge must exist (the template wires Loop in a cycle)
    await expect(page.locator(".react-flow__edge").first()).toBeVisible({
      timeout: 8000,
    });

    // Input handles: inputs (DataFrame from ArXiv) and item (LLM feedback)
    await expect(
      page.getByTestId("handle-loopcomponent-shownode-inputs-left"),
    ).toBeVisible();
    await expect(
      page.getByTestId("handle-loopcomponent-shownode-item-left"),
    ).toBeVisible();

    // Output handles: item (current iteration) and done (aggregated result)
    await expect(
      page.getByTestId("handle-loopcomponent-shownode-item-right"),
    ).toBeVisible();
    await expect(
      page.getByTestId("handle-loopcomponent-shownode-done-right"),
    ).toBeVisible();

    // --- Iteration execution ---
    // Limit ArXiv to 2 results so the loop runs exactly 2 iterations.
    // The template default is 3; we reduce to 2 to keep the test fast (2 LLM calls).
    await page.getByTestId("int_int_max_results").click({ clickCount: 3 });
    await page.getByTestId("int_int_max_results").fill("2");

    // Open the Playground and send a query — ArXiv is a public API, no key needed
    await page.getByTestId("playground-btn-flow-io").click();
    await page.waitForSelector('[data-testid="input-chat-playground"]', {
      timeout: 10000,
    });
    await page.getByTestId("input-chat-playground").fill("transformer neural networks");
    await page.getByTestId("button-send").click();

    // The AI response element appears as soon as the flow starts streaming.
    // Testid pattern: "chat-message-AI-{content}"
    await page.waitForSelector('[data-testid^="chat-message-AI-"]', {
      timeout: 240000,
    });

    // Verify the response contains at least 2 "Title" occurrences.
    // The Parser formats every paper as "Title: {title}\nSummary: {summary}" before
    // sending it to the LLM — so 2 ArXiv papers produce at least 2 "Title" mentions
    // in the aggregated response, confirming the loop iterated twice.
    const botMessage = page.locator('[data-testid^="chat-message-AI-"]').last();
    await expect(botMessage).toBeVisible();
    await expect(botMessage).not.toBeEmpty({ timeout: 240000 });
    const responseText = await botMessage.textContent() ?? "";
    const titleCount = (responseText.match(/title/gi) ?? []).length;
    expect(titleCount).toBeGreaterThanOrEqual(2);
  },
);
