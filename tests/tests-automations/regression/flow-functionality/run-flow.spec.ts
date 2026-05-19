import * as dotenv from "dotenv";
import path from "path";
import { expect, test } from "../../../fixtures/fixtures";
import { adjustScreenView } from "../../../helpers/ui/adjust-screen-view";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { zoomOut } from "../../../helpers/ui/zoom-out";

test(
  "user should be able to use Run Flow without any issues",
  { tag: ["@stable", "@release", "@workspace", "@api", "@regression"] },
  async ({ page, request }) => {
    if (!process.env.CI) {
      dotenv.config({ path: path.resolve(__dirname, "../../../.env") });
    }

    await awaitBootstrapTest(page);

    // Track the IDs of the 2 flows we create so cleanup can target ONLY
    // those via the API, not example/starter flows or flows belonging to
    // sibling specs running in parallel.
    const createdFlowIds: string[] = [];
    const captureFlowIdFromUrl = async () => {
      // `waitForURL` enforces the URL matches, so the subsequent match() is
      // guaranteed — no need for a runtime null check.
      await page.waitForURL(/\/flow\/[0-9a-f-]+/i, { timeout: 15000 });
      const id = page.url().match(/\/flow\/([0-9a-f-]+)/i)![1];
      createdFlowIds.push(id);
    };

    try {
      await page.waitForSelector('[data-testid="blank-flow"]', {
        timeout: 30000,
      });

      await page.getByTestId("blank-flow").click();
      await captureFlowIdFromUrl();

      await page.getByTestId("sidebar-search-input").click();
      await page.getByTestId("sidebar-search-input").fill("chat output");
      await page.waitForSelector('[data-testid="input_outputChat Output"]', {
        timeout: 30000,
      });

      await page
        .getByTestId("input_outputChat Output")
        .hover()
        .then(async () => {
          await page.getByTestId("add-component-button-chat-output").click();
        });

      await zoomOut(page, 2);

      await page.getByTestId("sidebar-search-input").click();
      await page.getByTestId("sidebar-search-input").fill("chat input");
      await page.waitForSelector('[data-testid="input_outputChat Input"]', {
        timeout: 30000,
      });

      await page
        .getByTestId("input_outputChat Input")
        .dragTo(page.locator('//*[@id="react-flow-id"]'), {
          targetPosition: { x: 100, y: 100 },
        });

      await page.getByTestId("sidebar-search-input").click();
      await page.getByTestId("sidebar-search-input").fill("text output");
      await page.waitForSelector('[data-testid="input_outputText Output"]', {
        timeout: 30000,
      });

      await page
        .getByTestId("input_outputText Output")
        .dragTo(page.locator('//*[@id="react-flow-id"]'), {
          targetPosition: { x: 300, y: 300 },
        });

      await adjustScreenView(page);

      await page
        .getByTestId("handle-chatinput-noshownode-chat message-source")
        .click();

      await page.getByTestId("handle-textoutput-shownode-inputs-left").click();

      await page
        .getByTestId("handle-textoutput-shownode-output text-right")
        .click();
      await page
        .getByTestId("handle-chatoutput-noshownode-inputs-target")
        .click();

      await page.getByTestId("icon-ChevronLeft").click();

      await expect(page.getByText("New Flow")).toBeVisible({ timeout: 10000 });
      await page.getByTestId("new-project-btn").click();

      await page.getByTestId("blank-flow").click();
      await captureFlowIdFromUrl();

      await page.getByTestId("sidebar-search-input").click();
      await page.getByTestId("sidebar-search-input").fill("run flow");
      await page.waitForSelector('[data-testid="flow_controlsRun Flow"]', {
        timeout: 30000,
      });

      await page
        .getByTestId("flow_controlsRun Flow")
        .hover()
        .then(async () => {
          await page.getByTestId("add-component-button-run-flow").click();
        });

      await page
        .getByTestId("value-dropdown-dropdown_str_flow_name_selected")
        .click();

      await page.getByTestId("refresh-dropdown-list-flow_name_selected").click();

      await page.waitForSelector("text=Loading", { timeout: 30000 });
      await page.waitForSelector("text=Select an option", { timeout: 30000 });

      await page
        .getByTestId("value-dropdown-dropdown_str_flow_name_selected")
        .click();

      await page.getByTestId("dropdown-option-0-container").click();

      await page.getByTestId(/^textarea_str_chatinput.*/).click();
      await page
        .getByTestId(/^textarea_str_chatinput.*/)
        .fill("THIS IS A TEST FOR RUN FLOW COMPONENT");

      await page.getByTestId("button_run_run flow").click();
      await page.waitForSelector("text=built successfully", {
        timeout: 30000,
      });

      // Wait for and click the output inspection button using partial match
      await page.waitForSelector('[data-testid^="output-inspection-"]', {
        timeout: 30000,
      });

      await page.locator('[data-testid^="output-inspection-"]').first().click();

      const value = page.getByPlaceholder("Empty");

      await expect(value).toHaveValue("THIS IS A TEST FOR RUN FLOW COMPONENT");
    } finally {
      // API-based cleanup scoped to the IDs we captured during creation.
      // Parallelism-safe: the previous implementation listed all flows and
      // sliced the top 2 positionally, which could (a) delete example or
      // starter flows that the listing returns before user flows, or
      // (b) under `fullyParallel`, delete flows another worker just
      // created. Iterating the captured IDs eliminates both classes of
      // collateral damage. It also sidesteps the brittle object-form
      // fallback (`body?.items` vs the actual `body.flows` shape used in
      // `helpers/flows/clean-all-flows.ts`) since we no longer need to
      // list at all.
      try {
        const headers = { Authorization: await getAuthToken(request) };
        for (const id of createdFlowIds) {
          try {
            await request.delete(`/api/v1/flows/${id}`, { headers });
          } catch {
            // Best-effort per-flow — do not mask the original test failure.
          }
        }
      } catch {
        // Cleanup is best-effort — do not mask the original test failure.
      }
    }
  },
);
