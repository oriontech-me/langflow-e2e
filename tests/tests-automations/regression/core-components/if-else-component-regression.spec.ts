import type { Page } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { adjustScreenView } from "../../../helpers/ui/adjust-screen-view";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";
import { zoomOut } from "../../../helpers/ui/zoom-out";

// Builds: If-Else (operator=equals) + two Text Output components, one renamed
// to `textoutputfalse` so the True/False branches can be inspected
// independently by testid. Direct-value path: `input_text` and `match_text`
// are typed into the If-Else inspector popovers — no ChatInput/Playground
// involved, mirroring `general-bugs-reset-flow-run.spec.ts` which validated
// that the canvas node-status icons (`node_duration_*` vs
// `node_status_icon_*_inactive`) are the most reliable assertion surface for
// conditional routing.
async function buildIfElseRoutingFlow(page: Page): Promise<void> {
  await awaitBootstrapTest(page);
  await expect(page.getByTestId("blank-flow")).toBeVisible({ timeout: 30000 });
  await page.getByTestId("blank-flow").click();

  // If-Else
  await page.getByTestId("sidebar-search-input").click();
  await page.getByTestId("sidebar-search-input").fill("if else");
  await expect(page.getByTestId("flow_controlsIf-Else")).toBeVisible({
    timeout: 10000,
  });
  await page.getByTestId("flow_controlsIf-Else").hover();
  await page.getByTestId("add-component-button-if-else").click();

  await zoomOut(page, 3);

  // Text Output (will be wired to True branch — default name `text output`)
  await page.getByTestId("sidebar-search-input").click();
  await page.getByTestId("sidebar-search-input").fill("text output");
  await expect(page.getByTestId("input_outputText Output")).toBeVisible({
    timeout: 10000,
  });
  await page
    .getByTestId("input_outputText Output")
    .dragTo(page.locator('//*[@id="react-flow-id"]'), {
      targetPosition: { x: 100, y: 100 },
    });

  await adjustScreenView(page);

  // Second Text Output — will be wired to False branch and renamed to
  // `textoutputfalse` so the False-branch status icon has a stable testid.
  await page.getByTestId("sidebar-search-input").click();
  await page.getByTestId("sidebar-search-input").fill("text output");
  await expect(page.getByTestId("input_outputText Output")).toBeVisible({
    timeout: 10000,
  });
  await page
    .getByTestId("input_outputText Output")
    .dragTo(page.locator('//*[@id="react-flow-id"]'), {
      targetPosition: { x: 200, y: 400 },
    });

  await adjustScreenView(page);

  // Rename the second Text Output to `textoutputfalse`
  await page.getByTestId("generic-node-title-arrangement").last().click();
  await page.getByTestId("panel-description").hover();
  await page
    .getByTestId("panel-description")
    .getByTestId("edit-name-description-button")
    .click();
  await page.getByTestId("inspection-panel-name").fill("textoutputfalse");
  await page
    .getByTestId("panel-description")
    .getByTestId("save-name-description-button")
    .click();

  // Connect True → first Text Output
  await page
    .getByTestId("handle-conditionalrouter-shownode-true-right")
    .click();
  await page
    .getByTestId("handle-textoutput-shownode-inputs-left")
    .first()
    .click();

  // Connect False → second Text Output (textoutputfalse)
  await page
    .getByTestId("handle-conditionalrouter-shownode-false-right")
    .click();
  await page
    .getByTestId("handle-textoutput-shownode-inputs-left")
    .last()
    .click();
}

test(
  "If-Else routes matching input through the True branch and skips the False branch",
  { tag: ["@regression", "@components"] },
  async ({ page }) => {
    await buildIfElseRoutingFlow(page);

    // Match: input_text === match_text → True branch should build.
    await page.getByTestId("popover-anchor-input-input_text").fill("hello");
    await page.getByTestId("popover-anchor-input-match_text").fill("hello");

    await page.getByTestId("button_run_text output").click();
    await expect(page.locator("text=built successfully")).toBeVisible({
      timeout: 30000,
    });

    await expect(page.getByTestId("node_duration_text output")).toHaveCount(1);
    await expect(
      page.getByTestId("node_status_icon_textoutputfalse_inactive"),
    ).toHaveCount(1);
  },
);

test(
  "If-Else routes non-matching input through the False branch and skips the True branch",
  { tag: ["@regression", "@components"] },
  async ({ page }) => {
    await buildIfElseRoutingFlow(page);

    // No match: input_text !== match_text → False branch should build.
    await page.getByTestId("popover-anchor-input-input_text").fill("world");
    await page.getByTestId("popover-anchor-input-match_text").fill("hello");

    await page.getByTestId("button_run_textoutputfalse").click();
    await expect(page.locator("text=built successfully")).toBeVisible({
      timeout: 30000,
    });

    await expect(
      page.getByTestId("node_duration_textoutputfalse"),
    ).toHaveCount(1);
    await expect(
      page.getByTestId("node_status_icon_text output_inactive"),
    ).toHaveCount(1);
  },
);
