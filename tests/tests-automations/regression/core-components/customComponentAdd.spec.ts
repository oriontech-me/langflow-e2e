import type { Page } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { deleteFlow } from "../../../helpers/flows/delete-flow";
import { ensureCustomComponentButton } from "../../../helpers/ui/ensure-custom-component-button";

// Capture every flow THIS page creates from its POST /api/v1/flows → 201
// responses and delete them id-scoped in afterEach. awaitBootstrapTest runs
// first, so a bare page.url() capture races the bootstrap flow's stale id
// (#490/#681); the response ids are authoritative and worker-safe. Without this
// each run leaked a "New Flow".
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

// Quarantine lifted (#1365 / #1423). The recurrent flake — `code-button-modal`
// ABSENT at the 10 s mark after the custom component is added — was the add
// itself being discarded, not the modal being late: the flow editor accepted the
// click on `sidebar-custom-component-button` and dropped it while the RBAC
// permission query was in flight (LE-2176). Fixed upstream by langflow#14523,
// which gates the affordance instead of only the mutation path.
//
// Measured on 2026-08-17, sampling the button every 500 ms with
// `POST /api/v1/authz/me/permissions` delayed 3 s: on 1.12.0.dev25 it reads
// `disabled=false` for the whole window (enabled, and swallowing), on
// 1.12.0.dev30 `disabled=true` for the whole window. That is why the bare click
// below is safe again and was not rewired onto `addCustomComponent()` — a
// click now waits out the window through Playwright's own actionability check
// rather than being dropped. If this flakes again, the retry helper is the fix,
// and the first thing to re-measure is that `disabled` sample.
test(
  "custom component code button should be pink when adding custom component",
  { tag: ["@release", "@components", "@stable"] },

  async ({ page }) => {
    trackCreatedFlows(page);
    await awaitBootstrapTest(page);

    await expect(page.getByTestId("blank-flow")).toBeVisible({
      timeout: 10000,
    });
    await page.getByTestId("blank-flow").click();

    await expect(page.getByTestId("canvas_controls_dropdown")).toBeVisible({
      timeout: 10000,
    });

    await ensureCustomComponentButton(page);
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
