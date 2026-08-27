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
  { tag: ["@release", "@components", "@api", "@ui-ux"] },

  async ({ page }) => {
    trackCreatedFlows(page);
    await awaitBootstrapTest(page);

    await page.waitForSelector('[data-testid="blank-flow"]', {
      timeout: 3000,
    });

    await page.getByTestId("blank-flow").click();
    await page.waitForSelector('[data-testid="sidebar-search-input"]', {
      timeout: 3000,
    });

    await page.getByTestId("sidebar-search-input").click();
    await page.getByTestId("sidebar-search-input").fill("api request");

    await page.waitForSelector('[data-testid="data_sourceAPI Request"]', {
      timeout: 3000,
    });
    await page
      .getByTestId("data_sourceAPI Request")
      .dragTo(page.locator('//*[@id="react-flow-id"]'));
    await page.mouse.up();
    await page.mouse.down();
    await adjustScreenView(page);

    await page.waitForSelector(
      '[data-testid="handle-apirequest-shownode-url-left"]',
      {
        timeout: 3000,
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
