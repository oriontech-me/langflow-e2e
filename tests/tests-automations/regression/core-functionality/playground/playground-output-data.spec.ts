import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { adjustScreenView } from "../../../../helpers/ui/adjust-screen-view";
import { awaitBootstrapTest } from "../../../../helpers/other/await-bootstrap-test";
import { zoomOut } from "../../../../helpers/ui/zoom-out";

type SetupOptions = { selectDataOutput?: boolean };

async function setupMockDataFlow(
  page: Page,
  { selectDataOutput = false }: SetupOptions = {},
): Promise<string> {
  await awaitBootstrapTest(page);
  await expect(page.getByTestId("blank-flow")).toBeVisible({ timeout: 30000 });
  await page.getByTestId("blank-flow").click();

  // Add Chat Output
  // Sidebar mounts after blank-flow.click() navigates — wait before filling
  // to avoid the same race as #278 (in setup-playground.ts).
  await expect(page.getByTestId("sidebar-search-input")).toBeVisible({
    timeout: 30000,
  });
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

  // Return this flow's id so the test can delete ONLY its own flow on teardown
  // (see the afterEach note on why a global cleanAllFlows races sibling tests).
  // Creating the blank flow navigates to /flow/<id>; the id is stable by now.
  const flowId = page.url().match(/\/flow\/([0-9a-f-]+)/i)?.[1];
  if (!flowId) {
    throw new Error(`Could not extract flow id from URL: ${page.url()}`);
  }
  return flowId;
}

async function runNoInputFlow(
  page: Page,
  outputContent: Locator,
): Promise<void> {
  await page.getByTestId("button-send").click();
  // Wait directly for the rendered output content, NOT for the button-stop
  // transition (#465). Two reasons the stop button is an unreliable gate:
  //   1. `div-chat-message` mounts early as a loading placeholder while the
  //      build streams (bot-message.tsx renders a pulsing icon before content
  //      arrives), so the bare message div is not a build-complete signal.
  //   2. On cold nightly backends the Send→Stop→Hidden transition stayed
  //      visible past 60s (build not settled in time), then passed on retry —
  //      a recurring flake (5×). Earlier the opposite race also bit us: on
  //      instant Mock Data flows the transition completed in <100ms, faster
  //      than Playwright's auto-wait poll (#279).
  // The output content element (a chat message that actually contains the
  // table/code) only appears once the build has produced its result, so it is
  // the true completion signal for these no-input Mock Data flows. Timeout is
  // generous to absorb cold-backend build latency.
  await expect(outputContent).toBeVisible({ timeout: 90000 });
  // Best-effort: once the output is present the build is effectively done.
  // Let the stop button clear so downstream steps start from an idle state,
  // but never fail the run on a stuck stop-button transition (#465). This is a
  // settle, not an assertion — hence `waitFor` + swallow rather than `expect`.
  await page
    .getByTestId("button-stop")
    .waitFor({ state: "hidden", timeout: 15000 })
    .catch(() => {});
}

test.describe("Playground Output – Structured Data", () => {
  // Id of the flow the current test created, set by setupMockDataFlow. Each
  // Playwright worker is its own process, so this is per-worker state — the two
  // tests below never share it even when they run in parallel.
  let createdFlowId: string | undefined;

  test.afterEach(async ({ page }) => {
    // Delete ONLY the flow this test created — never a global cleanAllFlows().
    // The suite runs fullyParallel against a single shared auto_login user, so a
    // global cleanup here races sibling tests: it deletes their in-flight flow
    // mid-build, the output never renders, and the run "does not settle" (#465).
    // Scoped deletion by id is collision-free. (The broader suite-wide hazard —
    // other specs still calling the global cleanAllFlows — is tracked in #515.)
    const flowId = createdFlowId;
    createdFlowId = undefined;
    if (!flowId) return;

    // Navigate off the editor first so the unmounted flow page stops polling the
    // flow we are about to delete (avoids spurious 4xx during teardown).
    await page.goto("/");

    // Obtain a bearer token via auto_login (no credentials required in dev/test),
    // mirroring clean-all-flows.ts, then delete just this one flow.
    const loginRes = await page.request.get("/api/v1/auto_login");
    let headers: Record<string, string> = {};
    if (loginRes.ok()) {
      const body = await loginRes.json();
      if (body?.access_token) {
        headers = { Authorization: `Bearer ${body.access_token}` };
      }
    }
    await page.request
      .delete(`/api/v1/flows/${flowId}`, { headers })
      .catch(() => {});
  });

  test(
    "playground must render JSON Data output as a code block",
    { tag: ["@stable", "@release", "@regression", "@playground"] },
    async ({ page }) => {
      await test.step(
        "Set up Mock Data (data_output) → Chat Output flow and open playground",
        async () => {
          createdFlowId = await setupMockDataFlow(page, {
            selectDataOutput: true,
          });
          await page.getByTestId("playground-btn-flow-io").click();
          await expect(page.getByTestId("button-send")).toBeVisible({
            timeout: 15000,
          });
        },
      );

      await test.step(
        "Run flow and verify JSON output renders as a code block containing expected keys",
        async () => {
          // Chat Output serialises Data via _serialize_data → ```json\n...\n```
          // react-markdown renders this as a <code> element inside a div-chat-message.
          const chatMessage = page
            .getByTestId("div-chat-message")
            .filter({ has: page.locator("code") });
          await runNoInputFlow(page, chatMessage);
          await expect(chatMessage).toBeVisible({ timeout: 30000 });

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
          createdFlowId = await setupMockDataFlow(page);
          await page.getByTestId("playground-btn-flow-io").click();
          await expect(page.getByTestId("button-send")).toBeVisible({
            timeout: 15000,
          });
        },
      );

      await test.step(
        "Run flow and verify DataFrame renders as a markdown table",
        async () => {
          // Chat Output serialises DataFrame via safe_convert → df.to_markdown(index=False)
          // react-markdown with remarkGfm renders markdown tables as <table> elements
          const chatMessage = page
            .getByTestId("div-chat-message")
            .filter({ has: page.locator("table") });
          await runNoInputFlow(page, chatMessage);
          await expect(chatMessage).toBeVisible({ timeout: 30000 });
        },
      );
    },
  );
});
