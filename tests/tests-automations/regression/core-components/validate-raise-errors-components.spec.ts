import {
  expect,
  test,
  type PageWithErrorHooks,
} from "../../../fixtures/fixtures";
import { addCustomComponent } from "../../../helpers/flows/add-custom-component";
import { adjustScreenView } from "../../../helpers/ui/adjust-screen-view";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";
import { ensureCustomComponentButton } from "../../../helpers/ui/ensure-custom-component-button";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { deleteFlow } from "../../../helpers/flows/delete-flow";

/**
 * §8.4 Error Handling — a Custom Component whose Python code raises an exception
 * at build time must surface that exact message to the user. Validates the
 * observability guarantee that a broken component tells the user WHY it broke,
 * rather than swallowing the error or crashing the editor.
 *
 * Distinct from the tool-mode error path (agent-tool-error-handling.spec.ts,
 * where exceptions become ToolMessage content) and the invalid-replace frontend
 * crash (general-bugs-frontend-crashing-on-invalid-replace.spec.ts).
 */
test.describe("Core Components — Component That Raises a Python Error", () => {
  let createdFlowId: string | null = null;

  test.afterEach(async ({ page, request }) => {
    if (createdFlowId) {
      await page.goto("/");
      await deleteFlow(request, createdFlowId, {
        headers: { Authorization: await getAuthToken(request) },
      });
      createdFlowId = null;
    }
  });

  test("user should be able to see errors on popups when raise an error",
    { tag: ["@stable", "@release", "@regression", "@workspace", "@components"] },
    async ({ page }) => {
      // This test's whole subject is a run that FAILS: the component below does
      // `raise ValueError`, and the assertion is that the message reaches the UI.
      // The hatch has been unnecessary until now only because the fixture could
      // not see a v2 run at all (#1162), and it is still not load bearing today —
      // a v2 verdict is advisory. It is added ahead of the flip (#1165) because
      // the alternative is discovering it as a red `@stable @release` spec.
      //
      // Measured on 1.12.0.dev10: the run does emit
      // `event_type=error / "THIS IS A TEST ERROR MESSAGE"`, but the fixture sees
      // it only when the stream closes before the test ends. As written it does
      // not (`read failed (stream aborted?)`, 3/3) — so the flip would make this
      // spec fail INTERMITTENTLY, which is the worst version of the outcome.
      (page as PageWithErrorHooks).allowFlowErrors();

      const customComponentCodeWithRaiseErrorMessage = `
# from langflow.field_typing import Data
from langflow.custom import Component
from langflow.io import MessageTextInput, Output
from langflow.schema import Data


class CustomComponent(Component):
    display_name = "Custom Component"
    description = "Use as a template to create your own component."
    documentation: str = "https://docs.langflow.org/components-custom-components"
    icon = "code"
    name = "CustomComponent"

    inputs = [
        MessageTextInput(
            name="input_value",
            display_name="Input Value",
            info="This is a custom component Input",
            value="Hello, World!",
            tool_mode=True,
        ),
    ]

    outputs = [
        Output(display_name="Output", name="output", method="build_output"),
    ]

    def build_output(self) -> Data:
        msg = "THIS IS A TEST ERROR MESSAGE"
        raise ValueError(msg)
        data = Data(value=self.input_value)
        self.status = data
        return data
    `;

      await test.step("Create a blank flow and capture its id for cleanup", async () => {
        await awaitBootstrapTest(page);

        const creationResponsePromise = page.waitForResponse(
          (resp) =>
            resp.url().includes("/api/v1/flows") &&
            resp.request().method() === "POST" &&
            resp.status() === 201,
          { timeout: 15000 },
        );
        await page.getByTestId("blank-flow").click();
        const creationResponse = await creationResponsePromise;
        createdFlowId = ((await creationResponse.json()) as { id: string }).id;
        expect(createdFlowId).toBeTruthy();
      });

      await test.step("Add a Custom Component to the canvas", async () => {
        await ensureCustomComponentButton(page);
        await addCustomComponent(page);
        await adjustScreenView(page, { numberOfZoomOut: 1 });
        await expect(
          page.getByTestId("title-Custom Component"),
        ).toBeVisible({ timeout: 15000 });
      });

      await test.step("Replace the component code with one that raises a ValueError", async () => {
        await page.getByTestId("title-Custom Component").click();
        await page.getByTestId("code-button-modal").last().click();

        await page.locator(".ace_content").click();
        await page.keyboard.press(`ControlOrMeta+A`);
        await page
          .locator("textarea")
          .fill(customComponentCodeWithRaiseErrorMessage);

        await page.getByText("Check & Save").last().click();
      });

      await test.step("Run the component and confirm the exact error message surfaces", async () => {
        await page.getByTestId("button_run_custom component").click();

        await expect(
          page.getByText("THIS IS A TEST ERROR MESSAGE").first(),
        ).toBeVisible({ timeout: 30000 });
      });
    },
  );
});
