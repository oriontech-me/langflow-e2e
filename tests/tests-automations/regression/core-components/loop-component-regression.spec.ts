import type { APIRequestContext, Page } from "@playwright/test";
import { readFileSync } from "fs";
import { expect, test } from "../../../fixtures/fixtures";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { adjustScreenView } from "../../../helpers/ui/adjust-screen-view";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";
import { deleteFlow } from "../../../helpers/flows/delete-flow";
import { setupLanguageModelOpenAI } from "../../../helpers/provider-setup/setup-language-model-openai";

// Run tests serially to avoid "flow must be unique" 400 errors from parallel autosaves
test.describe.configure({ mode: "serial" });

// Ids of the flows each test creates; teardown deletes only these via the API
// (scoped) — never a global cleanAllFlows, which wipes flows other parallel
// workers are actively building mid-run (#515).
const createdFlowIds: string[] = [];

test.afterEach(async ({ page }) => {
  const ids = createdFlowIds.splice(0);
  if (ids.length === 0) return;
  // Delete ONLY the flows this test created (scoped teardown, #515). Navigate
  // off the editor first so the unmounted flow page stops polling a flow we are
  // about to delete, then pass an explicit auth header — page.request is
  // unauthenticated under AUTO_LOGIN and would 401 otherwise. Not swallowed: a
  // failed cleanup surfaces instead of silently leaking the flow (#547).
  await page.goto("/");
  const authHeader = await getAuthToken(page.request);
  const opts = authHeader
    ? { headers: { Authorization: authHeader } }
    : undefined;
  for (const id of ids) {
    await deleteFlow(page.request, id, opts);
  }
});

// Helper: create a blank flow and add the Loop component to the canvas.
// After this call the component node is visible and the inspector is open.
async function addLoopComponent(page: Page) {
  await awaitBootstrapTest(page);
  // Capture the id from the flow-creation POST, NOT from the canvas URL: the URL
  // id is a transient client-side handle on this Langflow version and does not
  // match the persisted flow (deleting it 404s and silently leaks the real one).
  const flowCreation = page.waitForResponse(
    (resp) =>
      resp.url().includes("/api/v1/flows") &&
      resp.request().method() === "POST" &&
      resp.status() === 201,
    { timeout: 30000 },
  );
  await page.getByTestId("blank-flow").click();
  const created = (await (await flowCreation).json()) as { id?: string };
  if (!created.id) {
    throw new Error("blank-flow creation returned no flow id");
  }
  createdFlowIds.push(created.id);
  await page.waitForURL(/\/flow\//, { timeout: 30000 });
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
    test.skip(
      !process.env.OPENAI_API_KEY,
      "OPENAI_API_KEY required to execute the Language Model component in the Research Translation Loop template",
    );

    // Override the global 5-minute cap: this flow makes 2 sequential LLM calls
    // (one per ArXiv paper) which can take 3-4 minutes on CI infrastructure.
    test.setTimeout(8 * 60 * 1000);

    // The template loads with an unconfigured Language Model which triggers a
    // background auto-build that immediately fails with "A model selection is
    // required". Allow those pre-setup flow errors so the fixture doesn't kill
    // the test before we have a chance to configure the provider.
    (page as any).allowFlowErrors();

    await awaitBootstrapTest(page);

    // Load the Research Translation Loop template
    await page.getByTestId("side_nav_options_all-templates").click();
    await page.waitForSelector('[data-testid="template-research-translation-loop"]', {
      timeout: 10000,
    });
    // Capture the id from the template-instantiation POST so teardown can delete
    // only this flow (scoped, #515).
    const flowCreation = page.waitForResponse(
      (resp) =>
        resp.url().includes("/api/v1/flows") &&
        resp.request().method() === "POST" &&
        resp.status() === 201,
      { timeout: 30000 },
    );
    await page.getByTestId("template-research-translation-loop").click();
    const createdTemplate = (await (await flowCreation).json()) as { id?: string };
    if (!createdTemplate.id) {
      throw new Error("template instantiation returned no flow id");
    }
    createdFlowIds.push(createdTemplate.id);
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

    // --- Setup before any node interaction ---
    // Configure the Language Model with OpenAI BEFORE touching other nodes.
    // Any interaction (e.g., editing int_int_max_results) can trigger a background
    // auto-build; if the provider is not yet configured that build fails with
    // "A model selection is required" and the fixture would abort the test.
    await page.getByTestId("title-Language Model").click();
    await setupLanguageModelOpenAI(page);

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

    // The AI response streams into a "chat-message-AI-{content}" element. Wait for
    // it to appear (the ArXiv fetch + first LLM call can take a while), then poll
    // its text until the aggregated output mentions "title".
    //
    // `toContainText` RE-EVALUATES as tokens stream in, so it never samples a
    // partially-streamed response — the root cause of the flake tracked in #356.
    // Previously the test read `textContent()` once, right after the message first
    // became non-empty (i.e. on the first streamed token), and intermittently saw
    // 0 occurrences of "title" before the rest of the response had arrived. The
    // 240s budget covers 2 sequential LLM calls plus live ArXiv fetches; `.last()`
    // re-resolves on each poll, so it tracks the final aggregated message.
    //
    // The Parser feeds "Title: {title}\nSummary: {summary}" into the LLM; finding
    // "title" at least once confirms a full iteration completed (Parser → LLM →
    // Loop done). We match >= 1 occurrence (not >= 2) because the LLM response is
    // free-form and may echo "title" in only one of the N responses — the
    // deterministic per-iteration count is covered by the exit-condition test below.
    const botMessage = page.locator('[data-testid^="chat-message-AI-"]').last();
    await expect(botMessage).toBeVisible({ timeout: 240000 });
    await expect(botMessage).toContainText(/title/i, { timeout: 240000 });
  },
);

// =============================================================================
// Exit condition — Loop terminates after the input DataFrame is exhausted
// =============================================================================

const LOOP_FLOW_PATH = "tests/assets/flows/loop-exit-condition.json";

// Builds a fresh flow body from the asset, sets Create List `texts` to control
// N, and randomizes the name so re-runs do not clash on the unique constraint.
function buildFlowBody(texts: string[]): {
  flow: Record<string, unknown>;
  name: string;
} {
  const flow = JSON.parse(readFileSync(LOOP_FLOW_PATH, "utf-8"));
  for (const node of flow.data.nodes) {
    const t = node?.data?.node?.template;
    if (t && "texts" in t) {
      t.texts.value = texts;
    }
  }
  const name = `loop-exit-condition-${Math.random().toString(36).slice(2, 10)}`;
  flow.name = name;
  return { flow, name };
}

// Creates the flow server-side via POST /api/v1/flows/ using Playwright's
// request context. Avoids the drag-drop upload race observed with
// simulateDragAndDrop and aligns with the pattern used by the api/flows specs
// (request context + getAuthToken). Returns the new flow id so callers can
// target scoped cleanup or deep-link if needed.
async function createFlowFromAsset(
  request: APIRequestContext,
  flow: Record<string, unknown>,
): Promise<string> {
  const authToken = await getAuthToken(request);
  const res = await request.post("/api/v1/flows/", {
    headers: authToken ? { Authorization: authToken } : {},
    data: flow,
  });
  if (res.status() !== 201) {
    const body = (await res.text()).slice(0, 200);
    throw new Error(`POST /api/v1/flows/ failed: status ${res.status()}: ${body}`);
  }
  const body = (await res.json()) as { id: string };
  return body.id;
}

async function runFlowAndReadDoneCount(
  page: Page,
  request: APIRequestContext,
  texts: string[],
): Promise<number> {
  const { flow } = buildFlowBody(texts);
  const flowId = await createFlowFromAsset(request, flow);
  createdFlowIds.push(flowId);

  // Open the flow from the home page (deep-linking /flow/{id} intermittently
  // redirects to the flows list when the React owned-flows cache is stale at boot).
  // Target the exact card by flow id and open it with a dispatched click: a plain
  // name click (or .first()) is intercepted when residual cards left by other
  // specs/workers on the shared home grid overlap the target's absolute-inset
  // open button (#580 watch-list), and dispatchEvent bypasses that hit-test
  // interception.
  await page.goto("/");
  const openButton = page.locator(
    `[data-testid="list-card-open-button"][aria-labelledby*="${flowId}"]`,
  );
  await openButton.waitFor({ state: "visible", timeout: 30000 });
  await openButton.dispatchEvent("click");
  await page.waitForURL(/\/flow\//, { timeout: 30000 });
  await page.waitForSelector('[data-testid="title-Loop"]', { timeout: 30000 });
  await adjustScreenView(page);

  await page.getByTestId("button_run_loop").click();
  await page.waitForSelector("text=built successfully", { timeout: 60000 });

  // The done output renders as a paginated treegrid (DataFrame view). Read
  // the pagination summary "1 to N of N. Page 1 of 1" — robust to row sorting
  // and avoids brittle DOM-row counting under virtualization.
  await page.getByTestId("output-inspection-done-loopcomponent").click();
  await page.waitForSelector('[role="dialog"]', { timeout: 10000 });

  const dialog = page.locator('[role="dialog"]');
  const summaryText = await dialog
    .locator("text=/\\d+ to \\d+ of \\d+\\. Page \\d+ of \\d+/")
    .first()
    .textContent();
  await page.keyboard.press("Escape");

  const match = summaryText?.match(/of (\d+)\./);
  if (!match) {
    throw new Error(
      `Could not parse row count from done output dialog summary: ${summaryText}`,
    );
  }
  return Number(match[1]);
}

test(
  "Loop component — stops after exhausting input DataFrame and emits aggregated done",
  { tag: ["@stable", "@regression", "@components"] },
  async ({ page, request }) => {
    test.setTimeout(2 * 60 * 1000);

    let count: number | undefined;

    await test.step("N=3: loop iterates 3 times and done aggregates 3 items", async () => {
      await awaitBootstrapTest(page, { skipModal: true });
      count = await runFlowAndReadDoneCount(page, request, ["a", "b", "c"]);
      expect(count).toBe(3);
    });

    await test.step("N=1: edge case — single iteration aggregates 1 item", async () => {
      count = await runFlowAndReadDoneCount(page, request, ["only"]);
      expect(count).toBe(1);
    });
  },
);
