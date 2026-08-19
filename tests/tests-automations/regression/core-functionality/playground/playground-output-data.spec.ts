import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { adjustScreenView } from "../../../../helpers/ui/adjust-screen-view";
import { createFlow } from "../../../../helpers/flows/create-flow";
import { fillSidebarSearch } from "../../../../helpers/flows/fill-sidebar-search";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { openFlowById } from "../../../../helpers/flows/open-flow-by-id";
import { zoomOut } from "../../../../helpers/ui/zoom-out";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";

type SetupOptions = { selectDataOutput?: boolean };

/**
 * Creates the empty canvas this spec builds on, through the REST API and under a
 * per-run unique name (#1479).
 *
 * NOT `New Flow -> Blank Flow`, which is how this spec used to start and is what
 * made it flake: that path asks the backend for the name `New Flow`, the same one
 * every other parallel worker asks for at the same moment.
 * `POST /api/v1/flows/` deduplicates a taken name with a `SELECT` and only then
 * inserts, with no transaction across the two, so two simultaneous creations both
 * read the name as free and the loser violates `UNIQUE(user_id, name)` and comes
 * back `400 {"detail":"Name must be unique"}`. Measured on 1.12.0.dev30 straight
 * against the API: 10 of 20 requests fail at 2 concurrent creations of one name,
 * 30 of 40 at 4 — the dedup survives no concurrency at all. `use-add-flow.ts` then
 * shows a toast and never retries under another name, so the app stays on the home
 * screen; the spec waited 30 s for an editor that was never opened, which is the
 * `Loading...` home both failing dailies captured.
 *
 * A unique name removes the collision at its source, so there is nothing to repair
 * here and nothing that could mask a real create failure. This is the answer #588
 * already reached for the same upstream race ("we cannot fix the backend here") and
 * shipped as `createFlow`; this spec had simply never been migrated to it.
 *
 * Not `setupBlankFlow`, which wraps the same create: that helper enters the editor
 * by clicking the flow's card on the home grid, a step it took because
 * `page.goto('/flow/{id}')` right after an API create was observed redirecting back
 * to the list on `release-1.10.0`. `openFlowById` (#1214) goes by URL — a full
 * document load, so there is no SPA hop for a stale router cache to lose (#1005) —
 * and it also waits for the canvas AND for the header to report writable, which the
 * card click does not. The home grid is the more exposed of the two under parallel
 * workers: it is where other workers' residual cards intercept the open button
 * (#580/#588). Same create, fewer shared surfaces, and it matches what the two most
 * recent specs of this shape do (`ui-ux/sidebar-add-component`, `sidebar-search-and-filter`).
 */
async function createEmptyFlow(
  request: APIRequestContext,
  token: string,
): Promise<string> {
  return createFlow(
    request,
    {
      name: `playground-output-data-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      description: "Empty canvas for the Playground structured-output tests",
      data: { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
      is_component: false,
    },
    { headers: { Authorization: token } },
  );
}

async function setupMockDataFlow(
  page: Page,
  request: APIRequestContext,
  { selectDataOutput = false }: SetupOptions = {},
): Promise<string> {
  const token = await getAuthToken(request);
  const flowId = await createEmptyFlow(request, token);
  await openFlowById(page, flowId);

  // Add Chat Output. `fillSidebarSearch` confirms the sidebar actually kept the
  // typed term before waiting for its row: the sidebar can remount ~100-215 ms
  // after the fill and take the term with it, and since 1.12 a row only exists in
  // the DOM under a filter, so the row wait would die as `element(s) not found`
  // with nothing in flight to wait for (#1468).
  await fillSidebarSearch(page, "chat output", "input_outputChat Output");
  await page
    .getByTestId("input_outputChat Output")
    .hover()
    .then(async () => {
      await page.getByTestId("add-component-button-chat-output").click();
    });

  // Zoom out before dragging so the canvas target is not off-screen
  await zoomOut(page, 2);

  // Add Mock Data (section: data_source → testid prefix "data_source")
  await fillSidebarSearch(page, "mock data", "data_sourceMock Data");
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
  // The id comes from the create call, not from the URL: it is known before the
  // editor is ever opened, so a setup that fails midway still has an id to clean
  // up (the afterEach keeps its URL fallback for the same reason).
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
    //
    // Fall back to the id in the current URL when setup threw before returning
    // it: the flow was already created (we navigated to /flow/<id>) but the
    // fragile drag/connect steps failed, so createdFlowId is still unset. Without
    // this, a partial setup failure would orphan the flow it created.
    const flowId =
      createdFlowId ?? page.url().match(/\/flow\/([0-9a-f-]+)/i)?.[1];
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
    await deleteFlow(page.request, flowId, { headers });
  });

  test(
    "playground must render JSON Data output as a code block",
    { tag: ["@stable", "@release", "@regression", "@playground"] },
    async ({ page, request }) => {
      await test.step(
        "Set up Mock Data (data_output) → Chat Output flow and open playground",
        async () => {
          createdFlowId = await setupMockDataFlow(page, request, {
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

  // Quarantined at triage on the 2026-08-17/18 dailies (PR #1481) and restored
  // here (#1479). The triage read the failure as "the Chat Output sidebar row
  // never enters the DOM"; both dailies' `error-context` are byte-identical and
  // show the HOME screen with `Loading...`, so the browser was never in the
  // editor and no row could exist. The cause is the flow-create name race
  // documented on `createEmptyFlow` above, and it hit whichever test ran — it was
  // the JSON one in 1 of 32 measured runs of this file, so quarantining only this
  // test never removed the exposure.
  test(
    "playground must render DataFrame output as a markdown table",
    { tag: ["@stable", "@release", "@regression", "@playground"] },
    async ({ page, request }) => {
      await test.step(
        "Set up Mock Data (dataframe_output) → Chat Output flow and open playground",
        async () => {
          createdFlowId = await setupMockDataFlow(page, request);
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
