import type { Page } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { adjustScreenView } from "../../../helpers/ui/adjust-screen-view";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";
import {
  closeAdvancedOptions,
  openAdvancedOptions,
} from "../../../helpers/ui/open-advanced-options";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { deleteFlow } from "../../../helpers/flows/delete-flow";
import { dragComponentFromSidebar } from "../../../helpers/flows/add-component-from-sidebar";
import { openBlankFlowFromModal } from "../../../helpers/flows/open-blank-flow-from-modal";

// Capture every flow THIS page creates from its POST /api/v1/flows → 201
// responses and delete them id-scoped in afterEach (repo convention, #490/#681).
const createdFlowIds: string[] = [];

function trackCreatedFlows(page: Page): void {
  page.on("response", (resp) => {
    if (
      resp.url().includes("/api/v1/flows") &&
      resp.request().method() === "POST" &&
      resp.status() === 201
    ) {
      resp
        .json()
        .then((body: { id?: string }) => {
          if (body?.id) createdFlowIds.push(body.id);
        })
        .catch(() => {});
    }
  });
}

test.afterEach(async ({ request }) => {
  if (createdFlowIds.length === 0) return;
  const bearer = await getAuthToken(request);
  for (const id of createdFlowIds.splice(0)) {
    await deleteFlow(request, id, {
      headers: { Authorization: bearer },
    }).catch(() => {});
  }
});

test(
  "user must see on handle click the possibility connections",
  { tag: ["@stable", "@release", "@components", "@api", "@ui-ux"] },

  async ({ page }) => {
    trackCreatedFlows(page);
    await awaitBootstrapTest(page);

    await expect(page.getByTestId("blank-flow")).toBeVisible({
      timeout: 30000,
    });

    // Entry through the shared primitive, not a bare click: the blank-flow click
    // IS a flow creation and the backend can refuse it with 400 "flow must be
    // unique" while the modal stays open over the editor (#1468). The helper
    // re-issues the click and only returns once the modal is gone.
    await openBlankFlowFromModal(page);

    // Readiness barrier before ANY sidebar interaction — this is what #1623 was.
    // On a blank-flow entry the `flow-builder-welcome` onboarding overlay covers
    // the canvas and leaves `sidebar-search-input` in the DOM but NOT visible,
    // which is the exact shape the 2026-08-27 daily reported ("10 x locator
    // resolved to hidden"). Measured on nightly 1.12.0.dev40: the overlay was
    // visible at the moment of the click in 6 of 6 entries, the input hidden in
    // 6 of 6, and the input turned visible within ~100 ms of the overlay
    // clearing every time. Idle it clears in 140-790 ms, so the old 3000 ms wait
    // was the entire margin; holding the editor's mount GETs for 4 s reproduced
    // the daily's error byte-for-byte, 2 of 2. The overlay is waited out FIRST
    // and explicitly so a stuck overlay fails AS the overlay rather than as a
    // sidebar that never appeared (#1301's attribution lesson), and 30 s is the
    // budget `setupBlankFlow` already uses for the canvas barrier.
    const welcomeOverlay = page.locator(
      '[data-testid="flow-builder-welcome-panel"]',
    );
    if (await welcomeOverlay.isVisible().catch(() => false)) {
      await expect(welcomeOverlay).toBeHidden({ timeout: 30000 });
    }
    await expect(page.getByTestId("canvas_controls_dropdown")).toBeVisible({
      timeout: 30000,
    });

    // Drag through the shared primitive, not a bare fill + dragTo: Langflow drops
    // the sidebar add outright a measurable fraction of the time — the gesture is
    // accepted, no node is created and no flow write follows (#1304/#1320/#1335)
    // — and the bare version here surfaced that as
    // `handle-apirequest-shownode-url-left` never appearing, which is how
    // attempts 1 and 2 of the same daily died and what the 2026-08-25 run
    // recorded as flaky. The helper owns the search fill and its #1518 reset
    // repair, requires a node id that was NOT on the canvas before, and re-issues
    // the drag once when none appeared. A longer wait cannot fix a gesture the
    // app never registered.
    await dragComponentFromSidebar(
      page,
      "api request",
      "data_sourceAPI Request",
    );

    await adjustScreenView(page);

    // Post-condition rather than the place a failure lands: the helper above
    // already guarantees a new node, so this budget is only ever paid by a real
    // regression in the node's handles.
    await page.waitForSelector(
      '[data-testid="handle-apirequest-shownode-url-left"]',
      {
        timeout: 30000,
      },
    );
    await page.getByTestId("handle-apirequest-shownode-url-left").click();

    await page.waitForTimeout(500);

    await expect(page.getByTestId("icon-ListFilter").first()).toBeVisible();

    await page
      .getByTestId("icon-X")
      .first()
      .hover()
      .then(async () => {
        await page
          .getByText("Remove filter", {
            exact: false,
          })
          .first()
          .isVisible();
      });

    await expect(page.getByTestId("disclosure-input & output")).toBeVisible();
    await expect(page.getByTestId("disclosure-models & agents")).toBeVisible();
    await expect(page.getByTestId("disclosure-llm operations")).toBeVisible();
    await expect(page.getByTestId("disclosure-data sources")).toBeVisible();

    await page.getByTestId("sidebar-options-trigger").click();
    await page
      .getByTestId("sidebar-legacy-switch")
      .isVisible({ timeout: 5000 });
    await page.getByTestId("sidebar-legacy-switch").click();
    await page.getByTestId("sidebar-options-trigger").click();

    await expect(page.getByTestId("input_outputChat Input")).toBeVisible();
    await expect(page.getByTestId("input_outputChat Output")).toBeVisible();
    await expect(
      page.getByTestId("models_and_agentsPrompt Template"),
    ).toBeVisible();
    await expect(
      page.getByTestId("langchain_utilitiesCSV Agent"),
    ).toBeVisible();
    await expect(
      page.getByTestId("langchain_utilitiesConversationChain"),
    ).toBeVisible();

    await expect(
      page.getByTestId("langchain_utilitiesPrompt Hub"),
    ).toBeVisible();

    await page.getByTestId("sidebar-options-trigger").click();
    await page.getByTestId("sidebar-beta-switch").isVisible({ timeout: 5000 });
    await page.getByTestId("sidebar-beta-switch").click();
    await expect(page.getByTestId("sidebar-beta-switch")).not.toBeChecked();
    await page.getByTestId("sidebar-options-trigger").click();

    await expect(
      page.getByTestId("langchain_utilitiesPrompt Hub"),
    ).not.toBeVisible();

    await page.getByTestId("sidebar-filter-reset").click();

    await expect(page.getByTestId("input_outputChat Input")).not.toBeVisible();
    await expect(page.getByTestId("input_outputChat Output")).not.toBeVisible();
    await expect(
      page.getByTestId("models_and_agentsPrompt Template"),
    ).not.toBeVisible();
    await expect(
      page.getByTestId("agentsTool Calling Agent"),
    ).not.toBeVisible();
    await expect(
      page.getByTestId("langchain_utilitiesConversationChain"),
    ).not.toBeVisible();
    await expect(page.getByTestId("logicCondition")).not.toBeVisible();

    await openAdvancedOptions(page);

    // dev46: add the advanced `headers` field to the node body via the inspector
    // (replaces the old show<field> toggle), then connect from its input handle.
    await page.getByTestId("inspector-add-headers").click();
    await closeAdvancedOptions(page);
    await page.getByTestId("handle-apirequest-shownode-headers-left").click();

    await expect(page.getByTestId("disclosure-data sources")).toBeVisible();
    await expect(page.getByTestId("disclosure-llm operations")).toBeVisible();
    await expect(page.getByTestId("disclosure-processing")).toBeVisible();

    await expect(page.getByTestId("data_sourceAPI Request")).toBeVisible();
    await expect(page.getByTestId("datastaxAstra DB")).toBeVisible();
    await expect(page.getByTestId("flow_controlsSub Flow")).toBeVisible();

    await page.getByTestId("sidebar-options-trigger").click();
    await page.getByTestId("sidebar-beta-switch").isVisible({ timeout: 5000 });
    await page.getByTestId("sidebar-beta-switch").click();
    await expect(page.getByTestId("sidebar-beta-switch")).toBeChecked();
    await page.getByTestId("sidebar-options-trigger").click();

    await expect(page.getByTestId("flow_controlsSub Flow")).toBeVisible();

    // dev46 split the monolithic "Data Operations" component into granular ops;
    // assert a processing component that is compatible with the Data-typed
    // `headers` input and present under the beta filter.
    await expect(page.getByTestId("processingCreate Data")).toBeVisible();

    await page.getByTestId("icon-X").first().click();

    await expect(page.getByTestId("data_sourceAPI Request")).not.toBeVisible();
    await expect(page.getByTestId("datastaxAstra DB")).not.toBeVisible();
    await expect(page.getByTestId("flow_controlsSub Flow")).not.toBeVisible();

    await expect(page.getByTestId("processingSplit Text")).not.toBeVisible();
  },
);
