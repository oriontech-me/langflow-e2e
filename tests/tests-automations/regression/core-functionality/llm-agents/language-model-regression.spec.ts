import * as dotenv from "dotenv";
import path from "path";
import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { awaitBootstrapTest } from "../../../../helpers/other/await-bootstrap-test";
import { initialGPTsetup } from "../../../../helpers/other/initialGPTsetup";
import { setupGoogle } from "../../../../helpers/provider-setup/setup-google";
import { hideInspectorPanel } from "../../../../helpers/ui/hide-inspector-panel";
import { waitForFlowSaveSettled } from "../../../../helpers/flows/wait-for-flow-save-settled";

// Language Model component execution and provider management (QA-CHECKLIST
// §7.5 "Language Model component — configuration"). Hardened for @stable
// (issue #505):
// - the multi-provider tests use Google instead of Anthropic — same contract
//   (a second provider answers; a switch persists), and the suite holds a
//   funded GOOGLE_API_KEY (no Anthropic credits available; Save/validation
//   requires a real funded key). They skip without the env key — the
//   daily-stable workflow needs the GOOGLE_API_KEY secret for them to run
//   in CI (flagged on the PR).
// - the "Manage Model Providers" test lost its if-wrapping: every step is a
//   hard assertion against live-scouted testids.

if (!process.env.CI) {
  dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });
}

test.describe("Language Model Component Regression", () => {
  // Each test opens the Basic Prompting template, which creates a flow. The
  // canvas URL carries a TRANSIENT id on 1.11 (deleting it 404s), so capture
  // the real id from the page's own POST /api/v1/flows/ response and delete
  // just that flow afterwards (targeted — never cleanAllFlows, which would
  // nuke parallel workers' flows).
  const createdFlowIds: string[] = [];

  const openBasicPrompting = async (page: any) => {
    await awaitBootstrapTest(page);
    await page.getByTestId("side_nav_options_all-templates").click();
    const flowCreated = page
      .waitForResponse(
        (r: any) =>
          r.url().includes("/api/v1/flows/") &&
          r.request().method() === "POST" &&
          r.status() < 300,
        { timeout: 30000 },
      )
      .then(async (r: any) => (await r.json()).id as string)
      .catch(() => undefined);
    await page.getByRole("heading", { name: "Basic Prompting" }).click();
    await page.waitForURL(/\/flow\/[^/?#]+/, { timeout: 30000 });
    const flowId = await flowCreated;
    if (flowId) createdFlowIds.push(flowId);
  };

  test.afterEach(async ({ request }) => {
    // page.request carries only browser cookies — the flows API wants the
    // Bearer token, so authenticate explicitly (a silent 401 here leaks flows).
    if (createdFlowIds.length === 0) return;
    const bearer = await getAuthToken(request);
    while (createdFlowIds.length > 0) {
      const id = createdFlowIds.pop();
      await request
        .delete(`/api/v1/flows/${id}`, { headers: { Authorization: bearer } })
        .catch(() => {});
    }
  });

  test(
    "language model must respond with OpenAI provider",
    { tag: ["@stable", "@release", "@components", "@model-provider"] },
    async ({ page }) => {
      test.skip(
        !process?.env?.OPENAI_API_KEY,
        "OPENAI_API_KEY required to run this test",
      );

      await openBasicPrompting(page);

      await initialGPTsetup(page);
      // The model selection autosaves with a debounce — running before the
      // save settles builds the template's DEFAULT model (observed live:
      // gpt-5.5-pro instead of the selected one).
      await waitForFlowSaveSettled(page);

      await page.getByTestId("button_run_chat output").click();
      await page.waitForSelector("text=built successfully", { timeout: 30000 });

      await page.getByRole("button", { name: "Playground", exact: true }).click();
      await page.getByTestId("new-chat").click();
      await page.waitForSelector('[data-testid="input-chat-playground"]', {
        timeout: 30000,
      });

      await page.getByTestId("input-chat-playground").last().fill("What is 2+2?");
      await page.getByTestId("button-send").last().click();

      const stopBtn = page.getByRole("button", { name: "Stop" });
      if (await stopBtn.isVisible({ timeout: 10000 }).catch(() => false)) {
        await expect(stopBtn).toBeHidden({ timeout: 120000 });
      }
      await page.waitForSelector('[data-testid="div-chat-message"]', {
        timeout: 60000,
      });

      await expect(page.getByTestId("div-chat-message").last()).toContainText(/4/, {
        timeout: 15000,
      });
    },
  );

  test(
    "language model must respond with Google provider",
    { tag: ["@stable", "@release", "@components", "@model-provider"] },
    async ({ page }) => {
      test.skip(
        !process?.env?.GOOGLE_API_KEY,
        "GOOGLE_API_KEY required to run this test",
      );

      await openBasicPrompting(page);

      await setupGoogle(page);
      // Same autosave-debounce guard as the OpenAI test above.
      await waitForFlowSaveSettled(page);

      await page.getByTestId("button_run_chat output").click();
      await page.waitForSelector("text=built successfully", { timeout: 30000 });

      await page.getByRole("button", { name: "Playground", exact: true }).click();
      await page.getByTestId("new-chat").click();
      await page.waitForSelector('[data-testid="input-chat-playground"]', {
        timeout: 30000,
      });

      await page.getByTestId("input-chat-playground").last().fill("Say hello.");
      await page.getByTestId("button-send").last().click();

      const stopBtn = page.getByRole("button", { name: "Stop" });
      if (await stopBtn.isVisible({ timeout: 10000 }).catch(() => false)) {
        await expect(stopBtn).toBeHidden({ timeout: 120000 });
      }
      await page.waitForSelector('[data-testid="div-chat-message"]', {
        timeout: 60000,
      });

      const responseText = await page
        .getByTestId("div-chat-message")
        .last()
        .innerText();
      expect(responseText.trim().length).toBeGreaterThan(1);
    },
  );

  test(
    "language model provider switch from OpenAI to Google must persist",
    { tag: ["@stable", "@release", "@components", "@model-provider"] },
    async ({ page }) => {
      test.skip(
        !process?.env?.OPENAI_API_KEY || !process?.env?.GOOGLE_API_KEY,
        "OPENAI_API_KEY and GOOGLE_API_KEY required to run this test",
      );

      await openBasicPrompting(page);

      await initialGPTsetup(page);
      await setupGoogle(page);
      await waitForFlowSaveSettled(page);

      // The Basic Prompting flow has a single Language Model node, so the
      // page-level model_model trigger is unambiguous (the node-scoped nested
      // locator detaches after setupGoogle re-renders the node).
      await expect(
        page.locator('[data-testid="model_model"]').first(),
      ).toContainText(/gemini/i, { timeout: 15000 });
    },
  );

  test(
    "model provider dialog opens from the Language Model node",
    { tag: ["@stable", "@release", "@components", "@workspace", "@model-provider"] },
    async ({ page }) => {
      await openBasicPrompting(page);

      await page.waitForSelector('[data-testid="canvas_controls_dropdown"]', {
        timeout: 30000,
      });

      const languageModelNode = page
        .locator(".react-flow__node")
        .filter({ hasText: "Language Model" })
        .first();
      await expect(languageModelNode).toBeVisible({ timeout: 15000 });
      await languageModelNode.click();

      // The selected node's Inspector Panel overlaps the dropdown on 1.11.x —
      // close it so the click is not intercepted (setup-google convention).
      await hideInspectorPanel(page);

      const modelDropdown = page.locator('[data-testid="model_model"]').first();
      await expect(modelDropdown).toBeVisible({ timeout: 10000 });
      await modelDropdown.click();

      await page.getByTestId("manage-model-providers").click();

      await expect(page.getByTestId("provider-item-OpenAI")).toBeVisible({
        timeout: 10000,
      });

      await page.keyboard.press("Escape");
    },
  );
});
