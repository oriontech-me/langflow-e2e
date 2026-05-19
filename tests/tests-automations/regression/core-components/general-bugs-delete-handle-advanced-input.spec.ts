import { expect, test } from "../../../fixtures/fixtures";
import { adjustScreenView } from "../../../helpers/ui/adjust-screen-view";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";
import {
  closeAdvancedOptions,
  disableInspectPanel,
  enableInspectPanel,
  openAdvancedOptions,
} from "../../../helpers/ui/open-advanced-options";

test(
  "the system must delete the handles from advanced fields when the code is updated",
  { tag: ["@release", "@components", "@stable"] },
  async ({ page }) => {
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

    await disableInspectPanel(page);

    await openAdvancedOptions(page);

    await page.getByTestId("showtrue_case_message").click();
    await closeAdvancedOptions(page);

    await page.getByTestId("sidebar-search-input").click();
    await page.getByTestId("sidebar-search-input").fill("text input");
    await expect(page.getByTestId("input_outputText Input")).toBeVisible({
      timeout: 10000,
    });
    await page
      .getByTestId("input_outputText Input")
      .dragTo(page.locator('//*[@id="react-flow-id"]'), {
        targetPosition: { x: 200, y: 100 },
      });

    await adjustScreenView(page);

    await page
      .getByTestId("handle-textinput-shownode-output text-right")
      .click();

    await page
      .getByTestId("handle-conditionalrouter-shownode-case true-left")
      .click();

    await page.getByTestId("title-If-Else").click();

    await openAdvancedOptions(page);

    await expect(page.getByPlaceholder("Receiving input")).toHaveCount(2);

    await closeAdvancedOptions(page);

    await page.getByTestId("title-If-Else").click();

    await page.getByTestId("code-button-modal").last().click();

    await page.getByTestId("checkAndSaveBtn").last().click();

    await openAdvancedOptions(page);

    await expect(page.getByPlaceholder("Receiving input")).toHaveCount(0);
    await expect(page.getByTestId("icon-lock")).toHaveCount(0);

    await closeAdvancedOptions(page);

    await enableInspectPanel(page);
  },
);
