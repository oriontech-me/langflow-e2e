import type { Page } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";
import { adjustScreenView } from "../../../helpers/ui/adjust-screen-view";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { deleteFlow } from "../../../helpers/flows/delete-flow";
import { ensureCustomComponentButton } from "../../../helpers/ui/ensure-custom-component-button";

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
  "User should be able to use components as tool",
  { tag: ["@release", "@stable", "@components"] },
  async ({ page }) => {
    trackCreatedFlows(page);
    await awaitBootstrapTest(page);
    await page.getByTestId("blank-flow").click();
    await page.waitForSelector('[data-testid="disclosure-data sources"]', {
      timeout: 3000,
      state: "visible",
    });

    await page.getByTestId("disclosure-data sources").click();
    await page.waitForSelector('[data-testid="data_sourceURL"]', {
      timeout: 3000,
      state: "visible",
    });
    await page
      .getByTestId("data_sourceURL")
      .hover()
      .then(async () => {
        await page.getByTestId("add-component-button-url").click();
      });

    await page.getByTestId("generic-node-title-arrangement").click();

    await page
      .getByTestId("generic-node-title-arrangement")
      .dragTo(page.locator('//*[@id="react-flow-id"]'));

    await page.keyboard.press("ControlOrMeta+Shift+m");

    await page.waitForSelector("text=toolset", {
      timeout: 5000,
      state: "visible",
    });

    expect(await page.getByText("toolset").count()).toBeGreaterThan(0);

    await page.keyboard.press("ControlOrMeta+Shift+m");

    await page.waitForSelector("text=toolset", {
      timeout: 5000,
      state: "hidden",
    });

    expect(await page.getByText("toolset").count()).toBe(0);

    await page.getByTestId("tool-mode-button").click();

    await page.waitForSelector("text=toolset", {
      timeout: 5000,
      state: "visible",
    });

    expect(await page.getByText("toolset").count()).toBeGreaterThan(0);

    await page.getByTestId("tool-mode-button").click();

    await page.waitForSelector("text=toolset", {
      timeout: 5000,
      state: "hidden",
    });

    expect(await page.getByText("toolset").count()).toBe(0);

    await page.getByTestId("tool-mode-button").click();

    await page.waitForSelector("text=toolset", {
      timeout: 5000,
      state: "visible",
    });

    expect(await page.getByText("toolset").count()).toBeGreaterThan(0);

    await page.getByTestId("tool-mode-button").click();

    await page.waitForSelector("text=toolset", {
      timeout: 5000,
      state: "hidden",
    });

    expect(await page.getByText("toolset").count()).toBe(0);

    await page.getByTestId("tool-mode-button").click();

    await page.waitForSelector("text=toolset", {
      timeout: 5000,
      state: "visible",
    });

    expect(await page.getByText("toolset").count()).toBeGreaterThan(0);

    await page.getByTestId("tool-mode-button").click();

    await page.waitForSelector("text=toolset", {
      timeout: 5000,
      state: "hidden",
    });

    expect(await page.getByText("toolset").count()).toBe(0);

    await page.getByTestId("tool-mode-button").click();

    await page.waitForSelector("text=toolset", {
      timeout: 5000,
      state: "visible",
    });

    await page.getByTestId("disclosure-data sources").click();

    await page.getByTestId("disclosure-models & agents").click();

    await adjustScreenView(page, { numberOfZoomOut: 4 });

    await page.waitForSelector('[data-testid="models_and_agentsAgent"]', {
      timeout: 3000,
      state: "visible",
    });
    await page
      .getByTestId("models_and_agentsAgent")
      .dragTo(page.locator('//*[@id="react-flow-id"]'), {
        targetPosition: { x: 50, y: 500 },
      });
    await adjustScreenView(page);

    // Move the Agent node a bit

    await page
      .getByTestId("handle-urlcomponent-shownode-toolset-right")
      .first()
      .click();

    await page.getByTestId("handle-agent-shownode-tools-left").first().click();

    expect(await page.locator(".react-flow__edge").count()).toBeGreaterThan(0);

    await page.getByTestId("button_run_url").click();
    await expect(page.getByTestId("node_duration_url")).toBeVisible({
      timeout: 30000,
    });

    await page.getByTestId("output-inspection-toolset-urlcomponent").click();

    expect(await page.getByTestId("tool_name").count()).toBeGreaterThan(0);

    expect(await page.getByTestId("tool_description").count()).toBeGreaterThan(
      0,
    );

    expect(await page.getByTestId("tool_tags").count()).toBeGreaterThan(0);
    await page.getByText("Close").last().click();

    await ensureCustomComponentButton(page);
    await page.getByTestId("sidebar-custom-component-button").click();

    await page.getByTestId("title-Custom Component").click();

    await page.getByTestId("tool-mode-button").click();

    await page.waitForSelector(
      '[data-testid="output-inspection-toolset-customcomponent"]',
      {
        timeout: 100000,
      },
    );

    await page.waitForTimeout(1000);

    await page.getByTestId("button_run_custom component").click();

    await expect(
      page.getByTestId("node_duration_custom component"),
    ).toBeVisible({ timeout: 30000 });

    await page
      .getByTestId("output-inspection-toolset-customcomponent")
      .last()
      .click();

    expect(await page.getByTestId("tool_name").count()).toBeGreaterThan(0);

    expect(await page.getByTestId("tool_description").count()).toBe(0);

    expect(await page.getByTestId("tool_tags").count()).toBe(0);
  },
);
