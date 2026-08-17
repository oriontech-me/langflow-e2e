import type { Page } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";
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

// A full custom component: declares its own display_name, a named input, and a
// named output. None of these strings exist in the default scaffold, so the
// on-canvas assertions below can only pass if Check & Save compiled THIS code
// into the node.
const FULL_COMPONENT_CODE = `
from langflow.custom import Component
from langflow.io import MessageTextInput, Output
from langflow.schema.message import Message


class CustomComponent(Component):
    display_name = "My Full Component"
    description = "A fully authored custom component."
    icon = "custom_components"
    name = "MyFullComponent"

    inputs = [
        MessageTextInput(name="input_value", display_name="My Input", value="Hello, World!"),
    ]
    outputs = [
        Output(display_name="My Output", name="output", method="build_output"),
    ]

    def build_output(self) -> Message:
        return Message(text=self.input_value)`;

// Quarantine lifted (#1365). The flake was the add being discarded while the
// RBAC permission query was in flight — the click was accepted on an enabled
// button and dropped, so `code-button-modal` never had a node to belong to
// (LE-2176). Fixed upstream by langflow#14523, which gates the affordance:
// measured on 2026-08-17, the button reads `disabled=false` through the whole
// permission window on 1.12.0.dev25 and `disabled=true` on 1.12.0.dev30. See
// the fuller note on `customComponentAdd.spec.ts`, the sibling that shared this
// cause and this locator.
test(
  "a full custom component built from code exposes its declared interface",
  { tag: ["@stable", "@release", "@components"] },
  async ({ page }) => {
    trackCreatedFlows(page);

    await awaitBootstrapTest(page);

    await expect(page.getByTestId("blank-flow")).toBeVisible({ timeout: 10000 });
    await page.getByTestId("blank-flow").click();

    await expect(page.getByTestId("canvas_controls_dropdown")).toBeVisible({
      timeout: 10000,
    });

    await test.step("add a custom component and open its code editor", async () => {
      // Requires LANGFLOW_ALLOW_CUSTOM_COMPONENTS=true — with the feature off
      // (the nightly image default) this button is not rendered. See spec doc.
      await page.getByTestId("sidebar-custom-component-button").click();

      const codeButton = page.getByTestId("code-button-modal").last();
      await expect(codeButton).toBeVisible({ timeout: 10000 });
      await codeButton.click();
    });

    await test.step("replace the scaffold with a full component and save", async () => {
      await page.locator(".ace_content").click();
      await page.keyboard.press("ControlOrMeta+A");
      await page.locator("textarea").fill(FULL_COMPONENT_CODE);
      await page.getByText("Check & Save").last().click();
    });

    await test.step("the node materializes the code-declared interface", async () => {
      // Declared display_name drives the node title.
      await expect(page.getByTestId("title-My Full Component")).toBeVisible({
        timeout: 10000,
      });
      // Declared input rendered as a labeled field.
      await expect(page.getByTestId("title-my input")).toBeVisible({
        timeout: 10000,
      });
      // Declared output produced a real output handle.
      await expect(
        page.getByTestId("handle-myfullcomponent-shownode-my output-right"),
      ).toBeVisible({ timeout: 10000 });
      // The compiled component is runnable.
      await expect(
        page.getByTestId("button_run_my full component"),
      ).toBeVisible({ timeout: 10000 });
    });
  },
);
