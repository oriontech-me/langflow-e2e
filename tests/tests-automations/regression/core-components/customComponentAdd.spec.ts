import { expect, test } from "../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";

test(
  "custom component code button should be pink when adding custom component",
  { tag: ["@release", "@components"] },

  async ({ page }) => {
    await awaitBootstrapTest(page);

    await expect(page.getByTestId("blank-flow")).toBeVisible({
      timeout: 10000,
    });
    await page.getByTestId("blank-flow").click();

    await expect(page.getByTestId("canvas_controls_dropdown")).toBeVisible({
      timeout: 10000,
    });

    await page.getByTestId("sidebar-custom-component-button").click();

    const codeButton = page.getByTestId("code-button-modal").last();

    await expect(codeButton).toBeVisible({ timeout: 10000 });
    await expect(codeButton).toHaveClass(/animate-pulse-pink/);

    await codeButton.click();

    const customComponentCode = `
from langflow.custom import Component
from langflow.io import MessageTextInput, Output
from langflow.schema import Data
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
        return data`;

    await page.locator(".ace_content").click();
    await page.keyboard.press(`ControlOrMeta+A`);
    await page.locator("textarea").fill(customComponentCode);

    await page.getByText("Check & Save").last().click();

    await expect(codeButton).not.toHaveClass(/animate-pulse-pink/, {
      timeout: 10000,
    });
  },
);
