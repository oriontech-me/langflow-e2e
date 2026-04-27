import type { Page } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { adjustScreenView } from "../../../../helpers/ui/adjust-screen-view";
import { awaitBootstrapTest } from "../../../../helpers/other/await-bootstrap-test";
import { cleanAllFlows } from "../../../../helpers/flows/clean-all-flows";
import { zoomOut } from "../../../../helpers/ui/zoom-out";

type SetupOptions = { selectDataOutput?: boolean };

async function setupMockDataFlow(
  page: Page,
  { selectDataOutput = false }: SetupOptions = {},
): Promise<void> {
  await awaitBootstrapTest(page);
  await expect(page.getByTestId("blank-flow")).toBeVisible({ timeout: 30000 });
  await page.getByTestId("blank-flow").click();

  // Add Chat Output
  await page.getByTestId("sidebar-search-input").fill("chat output");
  await expect(page.getByTestId("input_outputChat Output")).toBeVisible({
    timeout: 30000,
  });
  await page
    .getByTestId("input_outputChat Output")
    .hover()
    .then(async () => {
      await page.getByTestId("add-component-button-chat-output").click();
    });

  // Zoom out before dragging so the canvas target is not off-screen
  await zoomOut(page, 2);

  // Add Mock Data (section: data_source → testid prefix "data_source")
  await page.getByTestId("sidebar-search-input").fill("mock data");
  await expect(page.getByTestId("data_sourceMock Data")).toBeVisible({
    timeout: 30000,
  });
  await page
    .getByTestId("data_sourceMock Data")
    .dragTo(page.locator('//*[@id="react-flow-id"]'), {
      targetPosition: { x: 100, y: 100 },
    });

  await adjustScreenView(page);

  await expect(page.locator(".react-flow__node")).toHaveCount(2, {
    timeout: 10000,
  });

  if (selectDataOutput) {
    // Default output is the Table (DataFrame) output; switch to JSON output.
    // Scope to the Mock Data node via its React Flow container (.react-flow__node).
    // div-generic-node only holds the node header; outputs are rendered in a sibling div outside it.
    // Uses ^= (starts-with) so the selector survives if Langflow sets data.node.key in the future
    // (test ID pattern: dropdown-output-${data.node.key?.toLowerCase() ?? "undefined"}).
    // "title-Mock Data" is data-testid set by NodeName as `"title-" + display_name`.
    // Item label in 1.10.x: "Result\nJSON" (was "Result\nData" in earlier versions).
    const mockDataNode = page
      .locator(".react-flow__node")
      .filter({ has: page.getByTestId("title-Mock Data") });
    await mockDataNode.locator('[data-testid^="dropdown-output-"]').click();
    const dataItem = mockDataNode
      .locator('[data-testid^="dropdown-item-output-"]')
      .filter({ hasText: "JSON" });
    await expect(dataItem).toBeVisible({ timeout: 5000 });
    await dataItem.click();
  }

  // Connect the selected Mock Data output → Chat Output input
  await page
    .getByTestId("handle-mockdatagenerator-shownode-result-right")
    .click();
  await page
    .getByTestId("handle-chatoutput-noshownode-inputs-target")
    .click();

  await expect(page.locator(".react-flow__edge")).toHaveCount(1, {
    timeout: 8000,
  });
}

async function runNoInputFlow(page: Page): Promise<void> {
  await page.getByTestId("button-send").click();
  await expect(page.getByTestId("button-stop")).toBeVisible({
    timeout: 30000,
  });
  await expect(page.getByTestId("button-stop")).toBeHidden({
    timeout: 60000,
  });
  // The AI response message is stored asynchronously after the build stream ends.
  // Wait for both the empty user-trigger and the AI response to appear in the DOM.
  await expect(page.getByTestId("div-chat-message")).toHaveCount(2, {
    timeout: 15000,
  });
}

test.describe("Playground Output – Structured Data", () => {
  test.afterEach(async ({ page }) => {
    await page.goto("/");
    await cleanAllFlows(page);
  });

  test(
    "playground must render JSON Data output as a code block",
    { tag: ["@stable", "@release", "@regression", "@playground"] },
    async ({ page }) => {
      await test.step(
        "Set up Mock Data (data_output) → Chat Output flow and open playground",
        async () => {
          await setupMockDataFlow(page, { selectDataOutput: true });
          await page.getByTestId("playground-btn-flow-io").click();
          await expect(page.getByTestId("button-send")).toBeVisible({
            timeout: 15000,
          });
        },
      );

      await test.step(
        "Run flow and verify JSON output renders as a code block containing expected keys",
        async () => {
          await runNoInputFlow(page);

          // Chat Output serialises Data via _serialize_data → ```json\n...\n```
          // react-markdown renders this as a <code> element inside a div-chat-message.
          const chatMessage = page
            .getByTestId("div-chat-message")
            .filter({ has: page.locator("code") });
          await expect(chatMessage).toBeVisible({ timeout: 10000 });

          const text = await chatMessage.innerText();
          // "records": is the top-level key in the Mock Data JSON serialisation
          expect(text).toContain('"records"');
        },
      );
    },
  );

  test(
    "playground must render DataFrame output as a markdown table",
    { tag: ["@stable", "@release", "@regression", "@playground"] },
    async ({ page }) => {
      await test.step(
        "Set up Mock Data (dataframe_output) → Chat Output flow and open playground",
        async () => {
          await setupMockDataFlow(page);
          await page.getByTestId("playground-btn-flow-io").click();
          await expect(page.getByTestId("button-send")).toBeVisible({
            timeout: 15000,
          });
        },
      );

      await test.step(
        "Run flow and verify DataFrame renders as a markdown table",
        async () => {
          await runNoInputFlow(page);

          // Chat Output serialises DataFrame via safe_convert → df.to_markdown(index=False)
          // react-markdown with remarkGfm renders markdown tables as <table> elements
          const chatMessage = page
            .getByTestId("div-chat-message")
            .filter({ has: page.locator("table") });
          await expect(chatMessage).toBeVisible({ timeout: 10000 });
        },
      );
    },
  );
});
