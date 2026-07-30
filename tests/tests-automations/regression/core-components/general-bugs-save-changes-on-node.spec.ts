import { type Page } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { adjustScreenView } from "../../../helpers/ui/adjust-screen-view";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";
import { renameFlow } from "../../../helpers/flows/rename-flow";
import {
  trackCreatedFlows,
  type FlowTracker,
} from "../../../helpers/flows/track-created-flows";

// This file had no teardown of any kind, so every run left the blank flow it
// creates behind (#1154). Captured by id from the creation responses and deleted
// id-scoped — never a name or wipe sweep, which would kill flows other parallel
// workers are driving (#553). Shared implementation (#1108), so the fix lands in
// one place rather than as another hand-copied local variant.
let flows: FlowTracker | undefined;

test.beforeEach(({ page }) => {
  flows = trackCreatedFlows(page);
});

test.afterEach(async ({ request }) => {
  const tracker = flows;
  // Null out BEFORE awaiting — see the identical block in
  // `flow-functionality/flow-rename-header.spec.ts` for why `flows?.` alone is
  // not enough once a file has more than one test.
  flows = undefined;
  // Default (log and continue), not `strict`: there was no teardown to preserve
  // the contract of, and failing an otherwise-green test on a cleanup blip would
  // be a new one.
  await tracker?.cleanup(request);
});

async function verifyTextareaValue(
  page: Page,
  value: string,
  flowName: string,
) {
  await page
    .getByTestId("textarea_str_input_value")
    .waitFor({ state: "visible" });
  await page.getByTestId("textarea_str_input_value").fill(value);

  await expect(page.getByTestId("textarea_str_input_value")).toHaveValue(value);

  await page.waitForTimeout(500);

  await page.getByTestId("icon-ChevronLeft").first().click();

  await page.waitForSelector('[data-testid="list-card"]', {
    timeout: 5000,
    state: "visible",
  });

  await page.waitForTimeout(500);
  await page.getByText(flowName).first().click();

  await page.waitForSelector('[data-testid="textarea_str_input_value"]', {
    timeout: 5000,
    state: "visible",
  });

  await page.waitForTimeout(500);
  const inputValue = await page
    .getByTestId("textarea_str_input_value")
    .inputValue();
  expect(inputValue).toBe(value);
}

test(
  "any changes on the node must be saved on user interaction",
  { tag: ["@release", "@components"] },
  async ({ page }) => {
    const randomValues = Array.from({ length: 4 }, () =>
      Math.random().toString(36).substring(2, 8),
    );

    const randomFlowName = Math.random().toString(36).substring(2, 8);

    await awaitBootstrapTest(page);
    await page.getByTestId("blank-flow").click();
    await adjustScreenView(page);

    await renameFlow(page, { flowName: randomFlowName });

    await page.getByTestId("sidebar-search-input").click();
    await page.getByTestId("sidebar-search-input").fill("text output");

    await page
      .getByTestId("input_outputText Output")
      .waitFor({ state: "visible" });
    await page.getByTestId("add-component-button-text-output").click();

    await page.waitForSelector('[data-testid="title-Text Output"]', {
      timeout: 5000,
      state: "visible",
    });

    await page.getByTestId("app-header").first().click();

    for (const value of randomValues) {
      try {
        await verifyTextareaValue(page, value, randomFlowName);
      } catch (error) {
        console.error(`Failed to verify value: ${value}`, error);
        throw error;
      }
    }
  },
);
