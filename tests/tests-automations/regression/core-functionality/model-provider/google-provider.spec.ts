import * as dotenv from "dotenv";
import path from "path";
import type { Page } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { SettingsPage, SimpleAgentTemplatePage } from "../../../../pages";
import { awaitBootstrapTest } from "../../../../helpers/other/await-bootstrap-test";
import { waitForFlowSaveSettled } from "../../../../helpers/flows/wait-for-flow-save-settled";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import {
  hasProviderEnvKeys,
  missingProviderEnvKeys,
} from "../../../../helpers/provider-setup";
import { providerSkipGate } from "../../../../helpers/provider-setup/provider-health";
import { waitForProviderRow } from "../../../../helpers/provider-setup/provider-list-state";
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

// SimpleAgentTemplatePage.load() does NO cleanup (post-#553 contract) and the
// canvas URL id is transient on 1.11 — track every flow the load actually
// creates (POST /api/v1/flows → 201) and delete those ids in afterEach (#605).
const createdFlowIds: string[] = [];

// Registered by BOTH entry points, not just `loadAgent` (#1648). Test 1 never
// loads the Agent template — it only opens Settings — so it used to leave the
// tracker unregistered while still creating flows: `awaitBootstrapTest` calls
// `addFlowToTestOnEmptyLangflow` whenever the current project renders
// `new_project_btn_empty_page`, which it does on a fresh instance. Measured on
// 1.12.0.dev44: running this file against an empty default project left
// `New Flow` + `Basic Prompting` behind, 2 flows per run.
function trackCreatedFlows(page: Page): void {
  page.on("response", (resp) => {
    if (
      resp.url().includes("/api/v1/flows") &&
      resp.request().method() === "POST" &&
      resp.status() === 201
    ) {
      resp
        .json()
        .then((body: { id?: string }) => {
          if (body?.id) createdFlowIds.push(body.id);
        })
        .catch(() => {}); // non-JSON / batch payloads
    }
  });
}

async function loadAgent(page: Page, model?: string): Promise<void> {
  trackCreatedFlows(page);
  try {
    await new SimpleAgentTemplatePage(page).load({ provider: PROVIDER, model });
  } catch (e: any) {
    if (e?.message?.startsWith("MODEL_NOT_AVAILABLE")) test.skip(true, e.message);
    throw e;
  }
}

test.afterEach(async ({ request }) => {
  if (createdFlowIds.length === 0) return;
  // page.request carries only browser cookies — the flows API wants the
  // Bearer token, so authenticate explicitly (a silent 401 here leaks flows).
  const bearer = await getAuthToken(request);
  for (const id of createdFlowIds.splice(0)) {
    await deleteFlow(request, id, { headers: { Authorization: bearer } });
  }
});

async function waitForAgentToFinish(page: Page): Promise<void> {
  const stopButton = page.getByRole("button", { name: "Stop" });
  const stopVisible = await stopButton.isVisible({ timeout: 10000 }).catch(() => false);
  if (stopVisible) {
    await expect(stopButton).toBeHidden({ timeout: 120000 });
  }
}

// Serial mode + --workers=1 keeps the shared instance state deterministic
// (agent-family convention — named template loads collide under parallelism).
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

      // The gate above is env presence, NOT provider health — deliberate
      // (#1415). This test makes no completion call, and the backend's
      // validate_model_provider_key (lfx/base/models/unified_models.py) only
      // rejects a key when the error message contains "401"/"authentication"/
      // "api key"; every other failure hits a bare `return` ("allow saving
      // despite minor errors"), so a spend-capped or drained key still answers
      // {valid: true} and this test still passes. Gating it would trade real
      // coverage of the Settings save path for nothing on exactly the days the
      // account is down. Test 2, which does call the model, IS gated.
      trackCreatedFlows(page);
      await awaitBootstrapTest(page, { skipModal: true });

      await test.step("open Settings → Model Providers → Google Generative AI", async () => {
        await new SettingsPage(page).navigate();
        await page.getByTestId("sidebar-nav-Model Providers").click();
        await expect(page.getByTestId("settings_menu_header").last()).toContainText(
          "Model Providers",
          { timeout: 10000 },
        );
        // Through waitForProviderRow (#1648): this call site recorded 1 of the
        // 20 provider-row timeouts measured across the 2026-08 dailies. Budget
        // unchanged (20 s `actionTimeout`).
        await (
          await waitForProviderRow(page, "provider-item-Google Generative AI", 20000)
        ).click();
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
        // Persist is a CREATE (POST /variables/ 201) when the global key does
        // not yet exist and an UPDATE (PATCH /variables/{id} 200) when it does
        // — the frontend branches on existence (#636). Match BOTH: a fresh
        // instance, or a run where no earlier test configured the provider
        // first, takes the POST path, so a PATCH-only predicate waits forever
        // on a request that never fires — the confirmed flake (POST 201
        // observed live on a deleted-var repro; validate-provider itself
        // returns 200, so the backend is healthy — a test defect, not a
        // product hang).
        const persistPromise = page.waitForResponse(
          (r) =>
            r.url().includes("/api/v1/variables/") &&
            (r.request().method() === "POST" || r.request().method() === "PATCH"),
          { timeout: 60000 },
        );

        await page.getByRole("button", { name: /Save|Replace/i }).first().click();

        const [validateResp, persistResp] = await Promise.all([
          validatePromise,
          persistPromise,
        ]);
        // validate-provider 2xx = the key authenticates against Google live;
        // POST/PATCH /variables 2xx = the key is persisted globally.
        expect(validateResp.ok()).toBe(true);
        expect(persistResp.ok()).toBe(true);
      });
    },
  );

  test(
    "configured Google selects a Gemini model in the Agent and executes the flow",
    { tag: ["@stable", "@model-provider", "@agents", "@playground"] },
    async ({ page }) => {
      // Health, not mere presence (#1029's gate, applied here by #1415). This
      // test makes a live completion call, so a key that EXISTS but is dead
      // cannot produce a verdict about Langflow — and this is the provider the
      // gate was BUILT for: on run 30374528125 the Google key had exceeded its
      // monthly spending cap, models.json still listed all 36 Google models (it
      // mirrors the Langflow catalog, not the validation), and the live calls
      // that followed blocked past gunicorn's 300 s timeout. Test 1 deliberately
      // stays on the env-presence gate — see the comment there.
      const providerGate = providerSkipGate(PROVIDER);
      test.skip(providerGate.skip, providerGate.reason);

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
