import * as dotenv from "dotenv";
import path from "path";
import { test } from "../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";
import { initialGPTsetup } from "../../../helpers/other/initialGPTsetup";
import { providerSkipGate } from "../../../helpers/provider-setup/provider-health";

test(
  "refresh dropdown list",
  { tag: ["@release", "@components"] },
  async ({ page }) => {
    if (!process.env.CI) {
      dotenv.config({ path: path.resolve(__dirname, "../../../.env") });
    }

    // Gate on provider HEALTH, not on the env var alone — a drained key would
    // block the backend past gunicorn's 300s timeout and kill the shard's
    // Langflow worker (#1029).
    // NOTE (#1029 audit): the gate names Anthropic but the test configures the
    // node with `initialGPTsetup` (OpenAI). The mismatch predates this change and
    // is preserved deliberately — this is an unvalidated inherited spec with no
    // `@stable`, so it runs nowhere today and a silent provider swap would be an
    // unreviewed behavior change. Fixing the gate to name the provider the test
    // actually drives belongs to whoever validates this spec.
    const gate = providerSkipGate("anthropic");
    test.skip(gate.skip, gate.reason);

    await page.goto("/");
    await awaitBootstrapTest(page);

    await page.getByTestId("side_nav_options_all-templates").click();
    await page
      .getByRole("heading", { name: "Portfolio Website Code Generator" })
      .click();

    await page.waitForSelector('[data-testid="canvas_controls_dropdown"]', {
      timeout: 100000,
    });

    await initialGPTsetup(page, {
      skipAdjustScreenView: true,
    });

    await page.waitForTimeout(3000);

    await page.getByText("Loading Options").isVisible({ timeout: 5000 });
  },
);
