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

    try {
      await page.waitForSelector('[data-testid="blank-flow"]', {
        timeout: 30000,
      });

      await page.getByTestId("blank-flow").click();

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
      // Best-effort cleanup of the 2 flows created by the test.
      // Uses the API for speed and to avoid cascading UI failures.
      try {
        const headers = { Authorization: await getAuthToken(request) };
        const listRes = await request.get("/api/v1/flows/", { headers });
        if (listRes.ok()) {
          const body = await listRes.json();
          const items = (Array.isArray(body) ? body : body?.items ?? []).slice(
            0,
            2,
          );
          for (const f of items) {
            await request.delete(`/api/v1/flows/${f.id}`, { headers });
          }
        }
      } catch {
        // Cleanup is best-effort — do not mask original test failure.
      }
    }
  },
);
