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
  "the system must delete the handles from advanced fields when the code is updated",
  { tag: ["@stable", "@release", "@components"] },
  async ({ page }) => {
    trackCreatedFlows(page);
    await awaitBootstrapTest(page);

    await page.getByTestId("blank-flow").click();

    await expect(page.getByTestId("canvas_controls_dropdown")).toBeVisible({
      timeout: 30000,
    });

    await page.getByTestId("sidebar-search-input").click();
    await page.getByTestId("sidebar-search-input").fill("if else");

    await expect(page.getByTestId("flow_controlsIf-Else")).toBeVisible({
      timeout: 10000,
    });
    await page.getByTestId("flow_controlsIf-Else").hover();
    await page.getByTestId("add-component-button-if-else").click();

    await adjustScreenView(page, { numberOfZoomOut: 3 });

    // dev46 node-inspector model: select the node, open the inspector panel
    // (parameters-button), and add the advanced `true_case_message` field to the
    // node body via `inspector-add-<field>` (the modern equivalent of the old
    // `show<field>` toggle). The inspect-panel on/off feature was removed
    // upstream, so there is nothing to disable/re-enable anymore.
    await page.getByTestId("title-If-Else").click();
    await openAdvancedOptions(page);
    await page.getByTestId("inspector-add-true_case_message").click();
    await closeAdvancedOptions(page);

    await page.getByTestId("sidebar-search-input").click();
    await page.getByTestId("sidebar-search-input").fill("chat input");
    await expect(page.getByTestId("input_outputChat Input")).toBeVisible({
      timeout: 10000,
    });
    await page
      .getByTestId("input_outputChat Input")
      .dragTo(page.locator('//*[@id="react-flow-id"]'), {
        targetPosition: { x: 200, y: 100 },
      });

    await adjustScreenView(page);

    // Chat Input is added minimized; connect from its collapsed "Chat Message"
    // output handle (noshownode) — no need to expand the node, this test only
    // uses it as a connection source for the If-Else `case true` input.
    await page
      .getByTestId("handle-chatinput-noshownode-chat message-source")
      .click();

    await page
      .getByTestId("handle-conditionalrouter-shownode-case true-left")
      .click();

    // Connected state, read directly off the node body (the dev46 inspector
    // panel does not duplicate field widgets): the case-true handle exists, its
    // field widget shows one read-only "Receiving input" placeholder, and one
    // lock icon decorates the connected edge.
    await expect(
      page.getByTestId("handle-conditionalrouter-shownode-case true-left"),
    ).toHaveCount(1);
    await expect(page.getByPlaceholder("Receiving input")).toHaveCount(1);
    await expect(page.getByTestId("icon-lock")).toHaveCount(1);

    // Re-save the component's default code; the advanced field config is
    // re-evaluated and the now-orphaned handle (with its edge, placeholder, and
    // lock icon) is dropped.
    await page.getByTestId("title-If-Else").click();

    await page.getByTestId("code-button-modal").last().click();

    await page.getByTestId("checkAndSaveBtn").last().click();

    await expect(
      page.getByTestId("handle-conditionalrouter-shownode-case true-left"),
    ).toHaveCount(0);
    await expect(page.getByPlaceholder("Receiving input")).toHaveCount(0);
    await expect(page.getByTestId("icon-lock")).toHaveCount(0);
  },
);
