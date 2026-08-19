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
 * Id of the flow the current test created, recorded by `setupMockDataFlow` the
 * moment `POST /api/v1/flows/` returns — BEFORE the editor is opened and before
 * any of the canvas steps that can throw. That ordering is the whole point: while
 * this lived in the `describe` and was assigned from the helper's return value, a
 * setup that failed anywhere after the create left it unset and the teardown had
 * nothing to delete but whatever the URL happened to hold — which on the very
 * redirect-to-the-list this file's `createEmptyFlow` note describes is not the
 * flow at all, so the run orphaned it. Measured on 1.12.0.dev30 with a throw
 * injected between the create and `openFlowById`: the account goes 27 -> 28 flows
 * with the id recorded on return, and 27 -> 27 with it recorded here.
 *
 * Module scope rather than `describe` scope only because the helper lives here.
 * Each Playwright worker is its own process, so this is per-worker state — the two
 * tests below never share it even when they run in parallel.
 */
let createdFlowId: string | undefined;

/**
 * Creates the empty canvas this spec builds on, through the REST API and under a
 * per-run unique name (#1479).
 *
 * NOT `New Flow -> Blank Flow`, which is how this spec used to start: that path
 * asks the backend for the name `New Flow`, the same one every other parallel
 * worker asks for at the same moment. `POST /api/v1/flows/` deduplicates a taken
 * name with a `SELECT` and only then inserts, with no transaction across the two,
 * so two simultaneous creations both read the name as free and the loser violates
 * `UNIQUE(user_id, name)` and comes back `400 {"detail":"Name must be unique"}`.
 * Measured on 1.12.0.dev30 straight against the API: 10 of 20 requests fail at 2
 * concurrent creations of one name, 30 of 40 at 4 — the dedup survives no
 * concurrency at all. `use-add-flow.ts` then shows a toast and never retries under
 * another name, so the app never leaves the home screen. On this file, 4 lanes x 4
 * repeats produced 7 `Name must be unique` backend errors and 1 failed test on the
 * old path, and 0 of each on this one.
 *
 * **That is exposure removed, NOT the diagnosis of the two dailies #1479 was filed
 * for.** The first version of this change claimed the name race was what those
 * dailies hit; the claim is withdrawn, and the reasoning behind it is recorded here
 * because it is the kind that gets reused. It rested on the failing attempts'
 * `error-context` — the home screen with `Loading...`, byte-identical on both days
 * — read as "the editor never opened". Playwright writes that snapshot from
 * `didFinishTest`, i.e. AFTER the `afterEach`, and this spec's `afterEach` calls
 * `page.goto("/")`: the home snapshot is therefore what teardown produces for ANY
 * failure of this file, and byte-identical is what a deterministic teardown
 * navigation looks like, not corroboration. Measured twice on the repo's own
 * Playwright 1.58.2, the second time on THIS spec: a test failing on
 * `data:text/html,<h1>DURING</h1>` with an `afterEach` that navigates to
 * `<h1>TEARDOWN</h1>` writes TEARDOWN into `error-context.md`; and a throw injected
 * here between the create and `openFlowById` — with the browser still on
 * `about:blank`, having never loaded a Langflow page at all — produced an
 * `error-context` showing the home screen with `Loading...`, i.e. the dailies'
 * snapshot, from a failure that provably never reached any screen. The
 * failure-time artefacts are `test-failed-1.png` (taken from
 * `didFinishTestFunction`, before the hooks) and the first-retry trace.
 *
 * The stack says the opposite of that snapshot: both dailies failed at the Chat
 * Output ROW wait, which is only reachable after `sidebar-search-input` was visible
 * AND filled inside the 20 s `actionTimeout` — and that testid exists upstream in
 * exactly one place: `pages/FlowPage/components/flowSidebarComponent/components/searchInput.tsx`,
 * i.e. the editor. The browser WAS in the editor, so #1468's
 * sidebar remount remains the open explanation for those two days; that is what
 * `fillSidebarSearch` below is the measured barrier for, and why it is adopted here
 * rather than incidentally.
 *
 * A unique name is still how this flow should be created: it removes the collision
 * at its source, so there is nothing to repair and nothing that could mask a real
 * create failure. It is the answer #588 already reached for the same upstream race
 * ("we cannot fix the backend here"), shipped as `createFlow` and imported by 27
 * other files; this spec had simply never been migrated to it.
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
): Promise<void> {
  const token = await getAuthToken(request);
  // Record the id on the line that produces it — see `createdFlowId` above for why
  // handing it back at the end of this function was not good enough.
  const flowId = await createEmptyFlow(request, token);
  createdFlowId = flowId;
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

  // Nothing is returned: the id the teardown needs was recorded at create time
  // (`createdFlowId`), not here, so that a setup failing at any of the steps above
  // still leaves the `afterEach` a flow to delete.
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
  test.afterEach(async ({ page }) => {
    // Delete ONLY the flow this test created — never a global cleanAllFlows().
    // The suite runs fullyParallel against a single shared auto_login user, so a
    // global cleanup here races sibling tests: it deletes their in-flight flow
    // mid-build, the output never renders, and the run "does not settle" (#465).
    // Scoped deletion by id is collision-free. (The broader suite-wide hazard —
    // other specs still calling the global cleanAllFlows — is tracked in #515.)
    //
    // The URL fallback is belt-and-braces, and it is worth saying which: since the
    // id is recorded the moment the create returns (`createdFlowId` above), a
    // partial setup failure no longer depends on it — that is what the fallback
    // used to be for, and it could not do the job, because the one failure mode it
    // was written against (a create that succeeded, then a redirect back to the
    // list) leaves no `/flow/<id>` in the URL either. It is kept because it costs a
    // regex and it can only ever name a flow this worker itself opened, so a future
    // edit that reintroduces a UI-side create still cleans up after itself.
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
          await setupMockDataFlow(page, request, { selectDataOutput: true });
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
  // here (#1479). The triage's reading — "the Chat Output sidebar row never enters
  // the DOM" — stands: the failure is at the row wait, which is reachable only from
  // inside the editor, and the home screen in the `error-context` does not say
  // otherwise (that snapshot is taken after this file's `afterEach` navigates; see
  // `createEmptyFlow` above). What the quarantine did not do is remove the
  // exposure: both tests share `setupMockDataFlow`, and the sibling JSON test —
  // never quarantined — failed once in 32 runs of this file measured on the old
  // setup. Restored because that setup now goes through `fillSidebarSearch`,
  // #1468's measured barrier for the sidebar remount, and creates the flow under a
  // unique name; re-validated per CONTRIBUTING.md.
  test(
    "playground must render DataFrame output as a markdown table",
    { tag: ["@stable", "@release", "@regression", "@playground"] },
    async ({ page, request }) => {
      await test.step(
        "Set up Mock Data (dataframe_output) → Chat Output flow and open playground",
        async () => {
          await setupMockDataFlow(page, request);
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
