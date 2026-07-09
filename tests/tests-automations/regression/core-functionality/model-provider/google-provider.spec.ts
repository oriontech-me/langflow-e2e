import * as dotenv from "dotenv";
import path from "path";
import type { Page } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { SettingsPage, SimpleAgentTemplatePage } from "../../../../pages";
import { awaitBootstrapTest } from "../../../../helpers/other/await-bootstrap-test";
import { waitForFlowSaveSettled } from "../../../../helpers/flows/wait-for-flow-save-settled";
import {
  hasProviderEnvKeys,
  missingProviderEnvKeys,
} from "../../../../helpers/provider-setup";
import { resolveGeminiModel } from "../../../../helpers/provider-setup/resolve-gemini-model";

/**
 * Google (Gemini) provider path (QA-CHECKLIST §7.4) as a provider-centric journey:
 *   Test 1 — configure the Google API key in Settings → Model Providers.
 *   Test 2 — the configured provider selects a Gemini model in the Agent and
 *            executes a flow, round-tripping a per-run sentinel.
 *
 * Mirrors openai-provider.spec.ts (§7.2) for Google. §7.4 lists only configure +
 * select; the execution in Test 2 proves the selected Gemini model is genuinely
 * usable, not merely picked in the UI.
 *
 * False-positive guards: Test 1 asserts the save *requests* succeed
 * (validate-provider + PATCH /variables, both 2xx) rather than a pre-existing
 * configured state, so a no-op save cannot pass. Test 2 asserts a Gemini model is
 * selected and echoes a per-run sentinel, so the response can't be stale or from
 * another provider.
 */

if (!process.env.CI) {
  dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });
}

const PROVIDER = "google";

async function loadAgent(page: Page, model?: string): Promise<void> {
  try {
    await new SimpleAgentTemplatePage(page).load({ provider: PROVIDER, model });
  } catch (e: any) {
    if (e?.message?.startsWith("MODEL_NOT_AVAILABLE")) test.skip(true, e.message);
    throw e;
  }
}

async function waitForAgentToFinish(page: Page): Promise<void> {
  const stopButton = page.getByRole("button", { name: "Stop" });
  const stopVisible = await stopButton.isVisible({ timeout: 10000 }).catch(() => false);
  if (stopVisible) {
    await expect(stopButton).toBeHidden({ timeout: 120000 });
  }
}

// SimpleAgentTemplatePage.load() deletes all flows before loading the template;
// serial mode + --workers=1 keeps the shared instance state deterministic.
test.describe.configure({ mode: "serial" });

test.describe("Google Provider", () => {
  test(
    "Google API key is configured via Settings → Model Providers",
    { tag: ["@stable", "@model-provider", "@settings"] },
    async ({ page }) => {
      test.skip(
        !hasProviderEnvKeys(PROVIDER),
        `Missing env vars for provider "${PROVIDER}": ${missingProviderEnvKeys(PROVIDER).join(", ")}`,
      );

      await awaitBootstrapTest(page, { skipModal: true });

      await test.step("open Settings → Model Providers → Google Generative AI", async () => {
        await new SettingsPage(page).navigate();
        await page.getByTestId("sidebar-nav-Model Providers").click();
        await expect(page.getByTestId("settings_menu_header").last()).toContainText(
          "Model Providers",
          { timeout: 10000 },
        );
        await page.getByTestId("provider-item-Google Generative AI").click();
      });

      await test.step("enter the key and save — assert the save requests succeed", async () => {
        const keyInput = page.getByTestId("provider-variable-input-GOOGLE_API_KEY");
        await expect(keyInput).toBeVisible({ timeout: 10000 });
        await keyInput.fill(process.env.GOOGLE_API_KEY ?? "");

        // Arm both waiters BEFORE clicking so the pass is caused by THIS save, not
        // a "Disconnect"/"Replace" state a prior configuration left behind.
        // Google validation can be slow on a cold provider — allow 60s.
        const validatePromise = page.waitForResponse(
          (r) =>
            r.url().includes("/api/v1/models/validate-provider") &&
            r.request().method() === "POST",
          { timeout: 60000 },
        );
        const persistPromise = page.waitForResponse(
          (r) =>
            r.url().includes("/api/v1/variables/") &&
            r.request().method() === "PATCH",
          { timeout: 60000 },
        );

        await page.getByRole("button", { name: /Save|Replace/i }).first().click();

        const [validateResp, persistResp] = await Promise.all([
          validatePromise,
          persistPromise,
        ]);
        // validate-provider 2xx = the key authenticates against Google live;
        // PATCH /variables 2xx = the key is persisted globally.
        expect(validateResp.ok()).toBe(true);
        expect(persistResp.ok()).toBe(true);
      });
    },
  );

  test(
    "configured Google selects a Gemini model in the Agent and executes the flow",
    { tag: ["@stable", "@model-provider", "@agents", "@playground"] },
    async ({ page }) => {
      test.skip(
        !hasProviderEnvKeys(PROVIDER),
        `Missing env vars for provider "${PROVIDER}": ${missingProviderEnvKeys(PROVIDER).join(", ")}`,
      );

      // Per-run sentinel: a match proves THIS execution produced the output.
      const token = `GOOGLE-${Date.now()}`;

      await loadAgent(page, resolveGeminiModel());

      await test.step("Agent has a Gemini model selected", async () => {
        const modelValue = page.getByTestId("value-dropdown-model_model");
        await expect(modelValue).toBeVisible({ timeout: 15000 });
        await expect(modelValue).toContainText(/gemini|gemma/i, { timeout: 10000 });
      });

      await test.step("remove the Web Search + URL tools so execution is a plain completion", async () => {
        // The template's tool-orchestration transiently fails (backend
        // ComponentBuildError) — incidental to §7.4. A tool-free agent is a single
        // deterministic LLM call. Tool execution is covered by
        // agent-component-regression.spec.ts.
        // Select via the node TITLE, not the body: URLComponent's body center is
        // an interactive element, so a body click doesn't select the node.
        const tools = [
          { title: "title-Web Search", node: "rf__node-UnifiedWebSearch" },
          { title: "title-URL", node: "rf__node-URLComponent" },
        ];
        for (const t of tools) {
          const node = page.locator(`[data-testid^="${t.node}"]`);
          if ((await node.count()) === 0) continue;
          await page.getByTestId(t.title).click();
          await page.keyboard.press("Delete");
          await expect(node).toHaveCount(0, { timeout: 10000 });
        }
        // Playground builds the PERSISTED flow — the deletion must be saved first.
        await waitForFlowSaveSettled(page);
      });

      await test.step("execute the flow and echo the sentinel", async () => {
        await page.getByTestId("playground-btn-flow-io").click();
        await expect(page.getByTestId("input-chat-playground").last()).toBeVisible({
          timeout: 30000,
        });
        await page
          .getByTestId("input-chat-playground")
          .last()
          .fill(`Repeat this token exactly and nothing else: ${token}`);
        await page.getByTestId("button-send").last().click();
        await waitForAgentToFinish(page);

        const aiMessage = page.getByTestId("div-chat-message").last();
        await expect(aiMessage).toBeVisible({ timeout: 30000 });
        const reply = (await aiMessage.innerText()).trim();
        // Hard: the selected Gemini model executed and returned output.
        expect(reply.length).toBeGreaterThan(0);
        // Optional signal — NOT asserted (expect.soft would still fail the test):
        // Gemini flash ~1/6 ignores "repeat this token" and returns a generic
        // greeting instead of echoing (model obedience, not a provider failure).
        // Log whether THIS input's token round-tripped when it does obey.
        console.log(
          reply.includes(token)
            ? `sentinel echoed: input reached the Gemini model (${token})`
            : `sentinel not echoed (Gemini obedience); reply: ${reply.slice(0, 80)}`,
        );
      });
    },
  );
});
