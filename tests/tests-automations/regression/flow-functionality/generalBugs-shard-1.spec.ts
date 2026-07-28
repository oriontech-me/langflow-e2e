import * as dotenv from "dotenv";
import path from "path";
import { test } from "../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";
import { initialGPTsetup } from "../../../helpers/other/initialGPTsetup";
import { providerSkipGate } from "../../../helpers/provider-setup/provider-health";

test(
  "should delete rows from table message",
  { tag: ["@release"] },
  async ({ page }) => {
    // A real build runs below, so gate on provider HEALTH rather than on
    // the mere presence of the env var: a key that exists but is drained blocks
    // the backend past gunicorn's 300s timeout and kills the shard's Langflow
    // worker (#1029).
    const gate = providerSkipGate("openai");
    test.skip(gate.skip, gate.reason);
    if (!process.env.CI) {
      dotenv.config({ path: path.resolve(__dirname, "../../../.env") });
    }
    await awaitBootstrapTest(page);

    await page.getByTestId("side_nav_options_all-templates").click();
    await page.getByRole("heading", { name: "Basic Prompting" }).click();
    await initialGPTsetup(page);

    await page.getByTestId("button_run_chat output").click();
    await page.waitForSelector("text=built successfully", { timeout: 30000 });

    await page.getByTestId("user-profile-settings").click();

    await page.waitForSelector('text="Settings"');
    await page.getByText("Settings").last().click();

    await page.waitForSelector('text="Messages"');
    await page.getByText("Messages").last().click();

    await page.waitForSelector(".ag-checkbox-input");
    await page.locator(".ag-checkbox-input").first().click();

    await page.waitForSelector('[data-testid="icon-Trash2"]:first-child');
    await page.getByTestId("icon-Trash2").first().click();

    await page.waitForSelector("text=No Data Available", { timeout: 30000 });
    await page.getByText("No Data Available").isVisible();
  },
);
