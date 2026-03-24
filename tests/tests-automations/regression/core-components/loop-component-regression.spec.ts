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
// UI / Canvas tests — verify component rendering and handles
// =============================================================================

test(
  "Loop component — renders on canvas with title and run button",
  { tag: ["@release", "@regression", "@components"] },
  async ({ page }) => {
    await addLoopComponent(page);

    // Node must be visible on the canvas
    await expect(page.getByTestId("title-Loop")).toBeVisible();

    // Run button must be present
    await expect(page.getByTestId("button_run_loop")).toBeVisible();

    // Exactly one node on the canvas
    await expect(page.locator(".react-flow__node")).toHaveCount(1);
  },
);

test(
  "Loop component — has correct input and output handles",
  { tag: ["@release", "@regression", "@components"] },
  async ({ page }) => {
    await addLoopComponent(page);

    // Input handles (left side)
    // inputs — receives the full list to iterate over
    await expect(
      page.getByTestId("handle-loopcomponent-shownode-inputs-left"),
    ).toBeVisible();
    // item — feedback port: receives the processed item to advance the loop
    await expect(
      page.getByTestId("handle-loopcomponent-shownode-item-left"),
    ).toBeVisible();

    // Output handles (right side)
    // item — emits the current item in the iteration
    await expect(
      page.getByTestId("handle-loopcomponent-shownode-item-right"),
    ).toBeVisible();
    // done — emits True when all items have been processed
    await expect(
      page.getByTestId("handle-loopcomponent-shownode-done-right"),
    ).toBeVisible();
  },
);

test(
  "Loop component — output inspection buttons are present for item and done ports",
  { tag: ["@release", "@regression", "@components"] },
  async ({ page }) => {
    await addLoopComponent(page);

    // Both output inspection triggers must be visible in the node footer
    await expect(
      page.getByTestId("output-inspection-item-loopcomponent"),
    ).toBeVisible();
    await expect(
      page.getByTestId("output-inspection-done-loopcomponent"),
    ).toBeVisible();
  },
);

test(
  "Loop component — run without connections shows build failed notification",
  { tag: ["@regression", "@components"] },
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
