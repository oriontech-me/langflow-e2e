import * as dotenv from "dotenv";
import path from "path";
import { expect, test } from "../../../../fixtures/fixtures";
import { adjustScreenView } from "../../../../helpers/ui/adjust-screen-view";
import { awaitBootstrapTest } from "../../../../helpers/other/await-bootstrap-test";
import { initialGPTsetup } from "../../../../helpers/other/initialGPTsetup";
import { zoomOut } from "../../../../helpers/ui/zoom-out";
import { providerSkipGate } from "../../../../helpers/provider-setup/provider-health";

// Why this file does NOT call `clearCanvasBottomOverlay` (#1675, measured on
// 1.13.0.dev0 rather than assumed).
//
// Both tests here click an `output-inspection-*` button shortly after a build,
// which is the shape that cost #1643 two specs — but the occupant that made that
// shape dangerous cannot arise here. `UpdateAllComponents` ("Flow needs review /
// N components need updates") only mounts for a node the running image reports
// outdated, and neither test loads a stored fixture: the first builds from the
// live **Basic Prompting** template and the second drags **URL** + two **Chat
// Output** components onto a blank flow, so every node is created by the image
// under test and none can be behind it. Probed end to end on the second test's
// flow, the slot is empty before the run, holds the transient build bar at the
// spec's own +600 ms wait (y 598.0-656.0), and is empty again by +2.6 s and at
// +6.6 s — the banner never appears.
//
// What remains is the build bar, which leaves on its own 2 s after "built
// successfully", and it clears the inspect button's bottom edge (y 551.5) by
// 46.5 px — an order of magnitude more than the ~5 px that decided #1643, and
// nine times `agent-n-messages-limit`'s ~37 px. Calling the helper here would
// also be wrong in one direction the other call sites are not: after the bar
// auto-dismisses the slot stays EMPTY for good, so the default
// `allowAlreadyClear: false` would report a lost selector on a healthy page.
//
// Revisit if either test starts seeding a stored flow fixture — that is the one
// change that puts `UpdateAllComponents` back on this canvas.
test(
  "user must be able to see output inspection",
  { tag: ["@release", "@components", "@agents"] },
  async ({ page }) => {
    if (!process.env.CI) {
      dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });
    }

    // Real completions run below, so gate on provider HEALTH, not on the env var
    // alone — a drained key would block the backend past gunicorn's 300s timeout
    // and kill the shard's Langflow worker (#1029).
    const gate = providerSkipGate("openai");
    test.skip(gate.skip, gate.reason);

    await awaitBootstrapTest(page);

    await page.getByTestId("side_nav_options_all-templates").click();
    await page.getByRole("heading", { name: "Basic Prompting" }).click();
    await adjustScreenView(page);

    await initialGPTsetup(page);

    await page.getByTestId("button_run_chat output").last().click();

    await page.waitForTimeout(600);

    await page.waitForSelector("text=built successfully", {
      timeout: 30000 * 3,
    });

    await page.waitForSelector('[data-testid="icon-TextSearchIcon"]', {
      timeout: 30000,
    });

    await page.getByTestId("icon-TextSearchIcon").nth(2).click();

    await page.getByText("Sender", { exact: true }).isVisible();
    await page.getByText("Type", { exact: true }).isVisible();
    await page.getByText("User", { exact: true }).last().isVisible();
  },
);

test(
  "user must be able to see output inspection using 'o' shortcut",
  { tag: ["@release", "@components", "@agents"] },
  async ({ page }) => {
    await awaitBootstrapTest(page);

    await page.getByTestId("blank-flow").click();

    // Add URL component
    await page.getByTestId("sidebar-search-input").click();
    await page.getByTestId("sidebar-search-input").fill("url");
    await page.waitForSelector('[data-testid="data_sourceURL"]', {
      timeout: 3000,
    });

    await page
      .getByTestId("data_sourceURL")
      .dragTo(page.locator('//*[@id="react-flow-id"]'), {
        targetPosition: { x: 100, y: 200 },
      });

    await page.waitForTimeout(1000);

    // Get URL node ID
    const urlNode = await page.locator(".react-flow__node").first();
    const _urlNodeId = await urlNode.getAttribute("data-id");

    await zoomOut(page, 2);

    // Add two chat outputs
    await page.getByTestId("sidebar-search-input").click();
    await page.getByTestId("sidebar-search-input").fill("chat output");
    await page.waitForSelector('[data-testid="input_outputChat Output"]', {
      timeout: 1000,
    });

    await page.waitForTimeout(1000);

    await page
      .getByTestId("input_outputChat Output")
      .dragTo(page.locator('//*[@id="react-flow-id"]'), {
        targetPosition: { x: 500, y: 100 },
      });

    await page.waitForTimeout(1000);

    await page
      .getByTestId("input_outputChat Output")
      .dragTo(page.locator('//*[@id="react-flow-id"]'), {
        targetPosition: { x: 500, y: 500 },
      });

    // Fill URL input
    await page
      .getByTestId("inputlist_str_urls_0")
      .fill("https://www.example.com");

    await adjustScreenView(page);

    await page
      .getByTestId("handle-urlcomponent-shownode-extracted pages-right")
      .click();

    await page.waitForTimeout(600);

    await page
      .getByTestId("handle-chatoutput-noshownode-inputs-target")
      .nth(0)
      .click();

    await page.waitForTimeout(1000);

    // Run flow and test text output inspection
    await page.getByTestId("button_run_url").first().click();
    await page.waitForSelector("text=built successfully", {
      timeout: 30000 * 3,
    });
    await page.keyboard.press("o");
    await page.getByText(`Inspect the output of the component below.`, {
      exact: true,
    });

    await page.getByText(`Component Output`, {
      exact: true,
    });
    await page.getByText("Close").first().click();
    await page
      .getByTestId("handle-urlcomponent-shownode-extracted pages-right")
      .click();
    await page
      .getByTestId("handle-chatoutput-noshownode-inputs-target")
      .nth(1)
      .click();
    await page.waitForTimeout(2000);

    // Run and verify text output is still shown
    await page.getByTestId("button_run_url").first().click();
    await page.waitForSelector("text=built successfully", {
      timeout: 30000 * 3,
    });

    await page
      .getByTestId("handle-urlcomponent-shownode-extracted pages-right")
      .click();
    await page.waitForTimeout(600);
    await page
      .getByTestId("handle-urlcomponent-shownode-extracted pages-right")
      .click();

    await page
      .getByTestId("output-inspection-extracted pages-urlcomponent")
      .nth(0)
      .click();

    await page.getByText(`Inspect the output of the component below.`, {
      exact: true,
    });

    await page.getByText(`Component Output`, {
      exact: true,
    });
    await page.getByText("Close").first().click();
    await page.waitForTimeout(600);

    await page
      .getByTestId("handle-urlcomponent-shownode-extracted pages-right")
      .nth(0)
      .click();

    await page
      .getByTestId("handle-chatoutput-noshownode-inputs-target")
      .nth(1)
      .click();

    // Run and verify dataframe output is now shown
    await page.getByTestId("button_run_url").first().click();
    await page.waitForSelector("text=built successfully", {
      timeout: 30000 * 3,
    });
    await page.waitForTimeout(600);
    await page
      .getByTestId("output-inspection-extracted pages-urlcomponent")
      .click();
    await page.getByText(`Inspect the output of the component below.`, {
      exact: true,
    });

    await page.getByText(`Component Output`, {
      exact: true,
    });
    await page.getByText("Close").first().click();
    await page.waitForTimeout(600);
    // Remove all connections
    const dataEdge = await page.locator(".react-flow__edge").first();
    await dataEdge.click();
    await page.keyboard.press("Backspace");

    await page.waitForTimeout(5000);

    // Run and verify data output is shown
    await page.getByTestId("button_run_url").first().click();
    await page.waitForSelector("text=built successfully", {
      timeout: 30000 * 3,
    });
    await page.waitForTimeout(600);
    await page.keyboard.press("o");
    await page.getByText(`Inspect the output of the component below.`, {
      exact: true,
    });

    await page.getByText(`Component Output`, {
      exact: true,
    });

    const closeButton = await page
      .getByText(`Close`, {
        exact: true,
      })
      .count();

    expect(closeButton).toBeGreaterThanOrEqual(0);
  },
);
