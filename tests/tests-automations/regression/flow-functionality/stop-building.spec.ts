import { expect, test } from "../../../fixtures/fixtures";
import { adjustScreenView } from "../../../helpers/ui/adjust-screen-view";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";
import { deleteFlow } from "../../../helpers/flows/delete-flow";

// Flow created by the test (blank-flow → /flow/{id}); captured so afterEach can
// delete only this one via the API. Targeted (not cleanAllFlows) so the teardown
// is safe under parallel runs, and idempotent if capture never happened.
let createdFlowId: string | undefined;

test.afterEach(async ({ page }) => {
  if (!createdFlowId) return;
  const login = await page.request.get("/api/v1/auto_login");
  const headers: Record<string, string> = {};
  if (login.ok()) {
    const body = await login.json();
    if (body?.access_token) headers.Authorization = `Bearer ${body.access_token}`;
  }
  await deleteFlow(page.request, createdFlowId, { headers });
  createdFlowId = undefined;
});

test("user must be able to stop a building from the canvas",
  { tag: ["@release", "@workspace", "@components"] },
  async ({ page }) => {
    await awaitBootstrapTest(page);

    await test.step("open blank flow and add custom component to canvas", async () => {
      await expect(page.getByTestId("blank-flow")).toBeVisible({
        timeout: 10000,
      });
      await page.getByTestId("blank-flow").click();

      // Readiness gate: the canvas controls confirm the editor has mounted
      // before we reach for the sidebar. Anchoring on this (instead of a tight
      // waitForSelector) lets the button click auto-wait for visibility and
      // avoids the "sidebar-custom-component-button hidden" flake.
      await expect(page.getByTestId("canvas_controls_dropdown")).toBeVisible({
        timeout: 10000,
      });

      // Canvas mounted at /flow/{id} — wait for the URL to settle before
      // reading it, so teardown reliably captures the id (a bare page.url()
      // here can race the navigation and miss it, leaking the flow).
      await page.waitForURL(/\/flow\/[^/?#]+/, { timeout: 10000 });
      createdFlowId = page.url().split("/flow/")[1]?.split(/[/?#]/)[0];

      await page.getByTestId("sidebar-custom-component-button").click();
      await adjustScreenView(page);
    });

    await test.step("add chat output component via sidebar", async () => {
      await page.getByTestId("sidebar-search-input").fill("chat output");

      await expect(page.getByTestId("input_outputChat Output")).toBeVisible({
        timeout: 10000,
      });

      await page
        .getByTestId("input_outputChat Output")
        .dragTo(page.locator('//*[@id="react-flow-id"]'), {
          targetPosition: { x: 400, y: 400 },
        });

      await adjustScreenView(page);
    });

    await test.step("inject 60-second sleep into custom component code", async () => {
      await page.getByTestId("div-generic-node").nth(1).click();

      await page.getByTestId("more-options-modal").click();

      await page.getByTestId("expand-button-modal").click();

      await page.getByTestId("div-generic-node").nth(0).click();

      await page.getByTestId("code-button-modal").nth(0).click();

      const waitTimeoutCode = `
# from langflow.field_typing import Data
from langflow.custom import Component
from langflow.io import MessageTextInput, Output
from langflow.schema import Data
from time import sleep
from langflow.schema.message import Message

class CustomComponent(Component):
    display_name = "Custom Component"
    description = "Use as a template to create your own component."
    documentation: str = "https://docs.langflow.org/components-custom-components"
    icon = "custom_components"
    name = "CustomComponent"

    inputs = [
        MessageTextInput(name="input_value", display_name="Input Value", value="Hello, World!"),
    ]

    outputs = [
        Output(display_name="Output", name="output", method="build_output"),
    ]

    def build_output(self) -> Message:
        data = Data(value=self.input_value)
        self.status = data
        sleep(60)
        return data`;

      await page.locator(".ace_content").click();
      await page.keyboard.press(`ControlOrMeta+A`);
      await page.locator("textarea").fill(waitTimeoutCode);

      await page.getByText("Check & Save").last().click();
      await adjustScreenView(page, { numberOfZoomOut: 2 });
    });

    await test.step("connect custom component output to chat output input", async () => {
      await page
        .getByTestId("handle-customcomponent-shownode-output-right")
        .first()
        .click();
      await page
        .getByTestId("handle-chatoutput-shownode-inputs-left")
        .first()
        .click();
      await expect(page.locator(".react-flow__edge")).toHaveCount(1, {
        timeout: 8000,
      });
    });

    await test.step("run the flow from the canvas terminal node", async () => {
      await expect(page.getByTestId("button_run_chat output")).toBeVisible({
        timeout: 10000,
      });

      await page.getByTestId("button_run_chat output").click();
    });

    await test.step("stop the build from the canvas", async () => {
      await expect(page.getByTestId("stop_building_button").last()).toBeVisible({
        timeout: 30000,
      });

      await page.getByTestId("stop_building_button").last().click();
    });

    await test.step("assert build stopped confirmation", async () => {
      await expect(page.getByText("build stopped")).toBeVisible({
        timeout: 30000,
      });
    });
  },
);
