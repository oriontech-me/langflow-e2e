import { expect, test } from "../../../fixtures/fixtures";
import { adjustScreenView } from "../../../helpers/ui/adjust-screen-view";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";
import { ensureCustomComponentButton } from "../../../helpers/ui/ensure-custom-component-button";
import { addCustomComponent } from "../../../helpers/flows/add-custom-component";
import {
  trackCreatedFlows,
  type FlowTracker,
} from "../../../helpers/flows/track-created-flows";

// Every flow THIS page creates, captured from its POST /api/v1/flows → 201
// responses and deleted id-scoped in afterEach (the shared cleanup of #1108).
//
// It used to capture ONE id, read off the canvas URL. That missed two flows per
// run and #1301 counted them: the flow `awaitBootstrapTest` creates on its way
// through the templates modal was never captured at all, and a run that died
// before reaching the URL read captured nothing — 5 orphan "New Flow"s survived 4
// solo runs. Capturing the creation responses covers both, and is what the rest
// of the suite already does.
let flows: FlowTracker | undefined;

test.beforeEach(async ({ page }) => {
  flows = trackCreatedFlows(page);
});

test.afterEach(async ({ request }) => {
  if (!flows) return;
  await flows.cleanup(request);
  flows.dispose();
  flows = undefined;
});

test("user must be able to stop a building from the canvas",
  // Quarantine lifted in #1301. The `div-generic-node` click timing out at 20s was
  // never a node that would not take a click — measured on nightly 1.12.0.dev23,
  // 0 of 26 attempts had one — it was the ADD being swallowed, so there was no
  // node at all (9 of 10 first clicks produced none within 40s). The add now goes
  // through `addCustomComponent`, which re-issues the click once and otherwise
  // fails naming the swallowed add.
  { tag: ["@stable", "@release", "@workspace", "@components"] },
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
      //
      // The overlay is waited out FIRST, and the 10s budget this carried was too
      // tight — both measured under #1301 on nightly 1.12.0.dev23. On a
      // blank-flow entry the `flow-builder-welcome-panel` covers the canvas and
      // `canvas_controls_dropdown` is not even in the DOM until it clears: the
      // overlay was up on 3 of 3 entries, and the controls appeared at ~1s on one
      // and ~10.6s on another. At 10s that failed 2 of 3 solo runs on a freshly
      // created instance — at the step BEFORE the swallowed add this issue is
      // about, which is why it reads as an unrelated failure. Waiting the overlay
      // out explicitly keeps the attribution: a stuck overlay fails as the
      // overlay, not as controls that "never appeared". 30s is the budget
      // `setupBlankFlow` already uses for this same observable.
      const welcomeOverlay = page.locator(
        '[data-testid="flow-builder-welcome-panel"]',
      );
      if (await welcomeOverlay.isVisible().catch(() => false)) {
        await expect(welcomeOverlay).toBeHidden({ timeout: 30000 });
      }

      await expect(page.getByTestId("canvas_controls_dropdown")).toBeVisible({
        timeout: 30000,
      });

      // The canvas is mounted at /flow/{id}; kept as a step barrier, not as the
      // teardown's source of truth — cleanup reads the creation responses now
      // (see the tracker note at the top), which is what covers a run that dies
      // before this line.
      await page.waitForURL(/\/flow\/[^/?#]+/, { timeout: 10000 });

      await ensureCustomComponentButton(page);
      await addCustomComponent(page);
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

      // The code modal must be GONE before the canvas is touched again.
      // `adjustScreenView` clicks `canvas_controls_dropdown`, and while the modal
      // is open its Radix overlay (`fixed inset-0 z-50`) intercepts every pointer
      // event on the canvas — the click is on a button Playwright reports as
      // "visible, enabled and stable", so it retries until the 20 s actionability
      // budget expires instead of failing on something nameable. Measured under
      // #1301 on nightly 1.12.0.dev23: 1 of 3 combined runs died here with 41
      // retries of "subtree intercepts pointer events", at the step AFTER the
      // swallowed add this issue is about, which is why it read as the same bug.
      await expect(page.locator('[role="dialog"][data-state="open"]')).toHaveCount(
        0,
        { timeout: 30000 },
      );

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
