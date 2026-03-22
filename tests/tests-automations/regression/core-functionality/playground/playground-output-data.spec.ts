import type { Page } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { adjustScreenView } from "../../../../helpers/ui/adjust-screen-view";
import { awaitBootstrapTest } from "../../../../helpers/other/await-bootstrap-test";
import { cleanAllFlows } from "../../../../helpers/flows/clean-all-flows";
import { zoomOut } from "../../../../helpers/ui/zoom-out";

/**
 * Mock Data has 3 outputs all with display_name "Result".
 * Only 1 handle is visible at a time: handle-mockdatagenerator-shownode-result-right
 * Default selected output is dataframe_output (DataFrame).
 * To switch output, use the dropdown trigger (dropdown-output-undefined) and select by index:
 *   nth(0) → dataframe_output (DataFrame)
 *   nth(1) → message_output  (Message)
 *   nth(2) → data_output     (Data → ```json code block)
 * Confirmed via diagnostic: item texts are "Result\nDataFrame", "Result\nMessage", "Result\nData"
 *
 * NOTE: dropdown-output-undefined testid reflects data.node.key being undefined in the component.
 */

async function setupMockDataFlow(
  page: Page,
  selectDataOutput: boolean = false,
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

  // Switch to data_output when needed (default is dataframe_output)
  if (selectDataOutput) {
    await page.getByTestId("dropdown-output-undefined").click();
    // data_output is at index 2: "Result\nData"
    await page
      .getByTestId("dropdown-item-output-undefined-result")
      .nth(2)
      .click();
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
  // No-input playground: button-send = "Run Flow", button-stop appears while building
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

test.describe("Playground Output – Structured Data (IDs B0 + B0b)", () => {
  test.afterEach(async ({ page }) => {
    await page.goto("/");
    await cleanAllFlows(page);
  });

  test(
    "playground must render JSON Data output as a code block",
    { tag: ["@release", "@regression", "@playground"] },
    async ({ page }) => {
      await test.step(
        "Set up Mock Data (data_output) → Chat Output flow and open playground",
        async () => {
          await setupMockDataFlow(page, true);
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
          // The empty user-trigger message is also a div-chat-message, so we filter
          // specifically for the one that contains a <code> element.
          const chatMessage = page
            .getByTestId("div-chat-message")
            .filter({ has: page.locator("code") });
          await expect(chatMessage).toBeVisible({ timeout: 10000 });

          const text = await chatMessage.innerText();
          expect(text).toContain("records");
        },
      );
    },
  );

  test(
    "playground must render DataFrame output as a markdown table",
    { tag: ["@release", "@regression", "@playground"] },
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
