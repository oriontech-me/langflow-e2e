import type { Page } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";
import { adjustScreenView } from "../../../helpers/ui/adjust-screen-view";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { deleteFlow } from "../../../helpers/flows/delete-flow";

// Capture every flow THIS page creates from its POST /api/v1/flows → 201
// responses and delete them id-scoped in afterEach. awaitBootstrapTest runs
// first, so a bare page.url() capture races the bootstrap flow's stale id
// (#490/#681); the response ids are authoritative and worker-safe.
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
  "a component in Tool Mode can be grouped with its Agent consumer",
  { tag: ["@stable", "@release", "@components"] },
  async ({ page }) => {
    trackCreatedFlows(page);

    await awaitBootstrapTest(page);
    await page.getByTestId("blank-flow").click();

    await test.step("add a URL component and enable Tool Mode", async () => {
      await page.waitForSelector('[data-testid="disclosure-data sources"]', {
        timeout: 10000,
        state: "visible",
      });
      await page.getByTestId("disclosure-data sources").click();
      await page.waitForSelector('[data-testid="data_sourceURL"]', {
        timeout: 10000,
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

      // Tool Mode: the component's output collapses into a single `toolset` handle.
      await page.keyboard.press("ControlOrMeta+Shift+m");
      await page.waitForSelector("text=toolset", {
        timeout: 10000,
        state: "visible",
      });
      expect(await page.getByText("toolset").count()).toBeGreaterThan(0);
    });

    await test.step("add an Agent and wire the toolset into its tools input", async () => {
      await page.getByTestId("disclosure-data sources").click();
      await page.getByTestId("disclosure-models & agents").click();
      await adjustScreenView(page, { numberOfZoomOut: 4 });
      await page.waitForSelector('[data-testid="models_and_agentsAgent"]', {
        timeout: 10000,
        state: "visible",
      });
      await page
        .getByTestId("models_and_agentsAgent")
        .dragTo(page.locator('//*[@id="react-flow-id"]'), {
          targetPosition: { x: 50, y: 500 },
        });
      await adjustScreenView(page);

      await page
        .getByTestId("handle-urlcomponent-shownode-toolset-right")
        .first()
        .click();
      await page
        .getByTestId("handle-agent-shownode-tools-left")
        .first()
        .click();
      expect(await page.locator(".react-flow__edge").count()).toBeGreaterThan(0);
    });

    await test.step("select both nodes and group them", async () => {
      await adjustScreenView(page, { numberOfZoomOut: 2 });
      // Shift+drag a rubber-band selection over the whole canvas (a plain drag
      // pans; Shift makes it a box-select — the §7.2 "Select all (Shift+drag)").
      const rf = await page
        .locator('//*[@id="react-flow-id"]')
        .boundingBox();
      if (!rf) throw new Error("react-flow canvas not found");
      await page.keyboard.down("Shift");
      await page.mouse.move(rf.x + 8, rf.y + 8);
      await page.mouse.down();
      await page.mouse.move(rf.x + rf.width - 8, rf.y + rf.height - 8, {
        steps: 15,
      });
      await page.mouse.up();
      await page.keyboard.up("Shift");

      await expect
        .poll(
          async () =>
            page.evaluate(
              () =>
                document.querySelectorAll(".react-flow__node.selected").length,
            ),
          { timeout: 5000 },
        )
        .toBe(2);

      await page.keyboard.press("ControlOrMeta+g");
    });

    await test.step("a single Group node is created without an invalid-selection error", async () => {
      // The group materialized: title + run button.
      await expect(page.getByTestId("title-Group")).toBeVisible({
        timeout: 10000,
      });
      await expect(page.getByTestId("button_run_group")).toBeVisible({
        timeout: 10000,
      });

      // Grouping was accepted — the "Invalid selection" guard did NOT fire.
      await expect(
        page.getByText("Invalid selection", { exact: false }),
      ).toHaveCount(0);

      // The two nodes collapsed into the single group node.
      await expect(page.getByTestId("div-generic-node")).toHaveCount(1);

      // The group absorbed the Tool-Mode component: its `urls` input surfaces as
      // a group input — it only exists because the URL component is inside.
      await expect(
        page.getByTestId("handle-groupnode-shownode-urls-left"),
      ).toBeVisible({ timeout: 10000 });
    });
  },
);
