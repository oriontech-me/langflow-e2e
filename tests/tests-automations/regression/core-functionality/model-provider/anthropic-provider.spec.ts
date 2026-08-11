import * as dotenv from "dotenv";
import path from "path";
import fs from "fs";
import type { Page } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { SettingsPage, SimpleAgentTemplatePage } from "../../../../pages";
import { awaitBootstrapTest } from "../../../../helpers/other/await-bootstrap-test";
import { waitForFlowSaveSettled } from "../../../../helpers/flows/wait-for-flow-save-settled";
import { hideInspectorPanel } from "../../../../helpers/ui/hide-inspector-panel";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import {
  hasProviderEnvKeys,
  missingProviderEnvKeys,
} from "../../../../helpers/provider-setup";
import { providerSkipGate } from "../../../../helpers/provider-setup/provider-health";

/**
 * Anthropic (Claude) provider path (QA-CHECKLIST §7.3) as a provider-centric journey:
 *   Test 1 — configure the Anthropic API key in Settings → Model Providers.
 *   Test 2 — the configured provider selects a Claude model in the Agent and
 *            executes a flow, round-tripping a per-run sentinel.
 *   Test 3 — switch between Claude model families (Haiku → Sonnet → Opus); the
 *            switched-to Sonnet executes, Opus is selection-only (cost).
 *
 * Completes the provider family: openai-provider.spec.ts (§7.2),
 * google-provider.spec.ts (§7.4), ollama-provider.spec.ts (§7.6).
 *
 * False-positive guards: Test 1 asserts the save *requests* succeed
 * (validate-provider + POST|PATCH /variables, both 2xx) rather than a
 * pre-existing configured state, so a no-op save cannot pass. Test 2 asserts a
 * Claude model is selected and the run returns output. Test 3 asserts the
 * dropdown value changes to each exact target model name — a switch that
 * silently keeps the previous model selected fails the exact-name assert.
 */

if (!process.env.CI) {
  dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });
}

const PROVIDER = "anthropic";

type ClaudeFamily = "haiku" | "sonnet" | "opus";

// Resolve a Claude model per family from models.json, preferring current
// non-dated names. Returns undefined when the family is absent from the
// collected catalog — callers skip with a reason.
function resolveClaudeModel(family: ClaudeFamily): string | undefined {
  const jsonPath = path.resolve(
    __dirname,
    "../../../../helpers/provider-setup/data/models.json",
  );
  if (!fs.existsSync(jsonPath)) return undefined;
  const models = JSON.parse(fs.readFileSync(jsonPath, "utf-8")) as Array<{
    provider: string;
    model: string;
  }>;
  const claude = models
    .filter((m) => m.provider === PROVIDER)
    .map((m) => m.model)
    .filter((m) => m.includes(family));
  // Prefer undated names (claude-sonnet-5) over dated snapshots
  // (claude-sonnet-4-20250514); within those, the catalog lists newest first.
  return claude.find((m) => !/\d{8}/.test(m)) ?? claude[0];
}

// Flows created during template load are tracked here and deleted by id in
// afterEach — SimpleAgentTemplatePage.load() does NO cleanup (post-#553
// contract), and the app can fire more than one flows POST during load (only
// one persists; deleting a transient id 404s harmlessly — deleteFlow treats
// 404 as done).
const createdFlowIds: string[] = [];

async function loadAgent(page: Page, model?: string): Promise<void> {
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
  try {
    await new SimpleAgentTemplatePage(page).load({ provider: PROVIDER, model });
  } catch (e: any) {
    if (e?.message?.startsWith("MODEL_NOT_AVAILABLE")) test.skip(true, e.message);
    throw e;
  }
}

test.afterEach(async ({ request }) => {
  if (createdFlowIds.length === 0) return;
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

// The template's Web Search + URL tool orchestration transiently fails
// (backend ComponentBuildError) — incidental to §7.3. A tool-free agent is a
// single deterministic LLM call; tool execution is covered by
// agent-component-regression.spec.ts. Select via the node TITLE, not the body:
// URLComponent's body center is an interactive element.
async function removeToolNodes(page: Page): Promise<void> {
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
}

// Sends the sentinel prompt in the Playground and asserts a non-empty AI
// reply. The sentinel echo is logged, not asserted (family convention — the
// hard non-empty check plus the model-selection assert pin the execution).
async function runPlaygroundSentinel(page: Page, token: string): Promise<void> {
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
  // Hard: the selected Claude model executed and returned output.
  expect(reply.length).toBeGreaterThan(0);
  console.log(
    reply.includes(token)
      ? `sentinel echoed: input reached the Claude model (${token})`
      : `sentinel not echoed; reply: ${reply.slice(0, 80)}`,
  );
}

// Switches the Agent's model via the model_model dropdown and asserts the
// selected value shows the exact target model name (a stale dropdown fails).
async function switchModel(page: Page, model: string): Promise<void> {
  await hideInspectorPanel(page);
  await page.getByTestId("model_model").click();
  const option = page.locator('[data-testid$="-option"]', {
    hasText: new RegExp(`^${model}$`),
  });
  await option.waitFor({ state: "visible", timeout: 10000 });
  await option.click();
  await expect(page.getByTestId("value-dropdown-model_model")).toContainText(
    model,
    { timeout: 10000 },
  );
}

// SimpleAgentTemplatePage.load() deletes all flows before loading the template;
// serial mode + --workers=1 keeps the shared instance state deterministic.
test.describe.configure({ mode: "serial" });

test.describe("Anthropic Provider", () => {
  test(
    "Anthropic API key is configured via Settings → Model Providers",
    { tag: ["@stable", "@model-provider", "@settings"] },
    async ({ page }) => {
      // Env presence, NOT provider health — deliberate (#1415). This test makes
      // no completion call, and the backend's validate_model_provider_key
      // (lfx/base/models/unified_models.py) only rejects a key when the error
      // message contains "401"/"authentication"/"api key"; every other failure
      // hits a bare `return` ("allow saving despite minor errors"), so a drained
      // account still answers {valid: true} and this test still passes. Measured
      // on the 2026-07-27 daily: Anthropic was dry, this test passed, Test 2
      // hard-failed. Gating it would trade real coverage of the Settings save
      // path for nothing on exactly the days the account is down.
      test.skip(
        !hasProviderEnvKeys(PROVIDER),
        `Missing env vars for provider "${PROVIDER}": ${missingProviderEnvKeys(PROVIDER).join(", ")}`,
      );

      await awaitBootstrapTest(page, { skipModal: true });

      await test.step("open Settings → Model Providers → Anthropic", async () => {
        await new SettingsPage(page).navigate();
        await page.getByTestId("sidebar-nav-Model Providers").click();
        await expect(page.getByTestId("settings_menu_header").last()).toContainText(
          "Model Providers",
          { timeout: 10000 },
        );
        await page.getByTestId("provider-item-Anthropic").click();
      });

      await test.step("enter the key and save — assert the save requests succeed", async () => {
        const keyInput = page.getByTestId(
          "provider-variable-input-ANTHROPIC_API_KEY",
        );
        await expect(keyInput).toBeVisible({ timeout: 10000 });
        await keyInput.fill(process.env.ANTHROPIC_API_KEY ?? "");

        // Arm both waiters BEFORE clicking so the pass is caused by THIS save,
        // not a "Disconnect"/"Replace" state a prior configuration left behind.
        const validatePromise = page.waitForResponse(
          (r) =>
            r.url().includes("/api/v1/models/validate-provider") &&
            r.request().method() === "POST",
          { timeout: 60000 },
        );
        // POST on first configure, PATCH on re-save of the existing variable.
        const persistPromise = page.waitForResponse(
          (r) =>
            r.url().includes("/api/v1/variables/") &&
            ["POST", "PATCH"].includes(r.request().method()),
          { timeout: 60000 },
        );

        await page.getByRole("button", { name: /Save|Replace/i }).first().click();

        const [validateResp, persistResp] = await Promise.all([
          validatePromise,
          persistPromise,
        ]);
        // validate-provider 2xx = the key authenticates against Anthropic live;
        // POST|PATCH /variables 2xx = the key is persisted globally.
        expect(validateResp.ok()).toBe(true);
        expect(persistResp.ok()).toBe(true);
      });
    },
  );

  test(
    "configured Anthropic selects a Claude model in the Agent and executes the flow",
    { tag: ["@stable", "@model-provider", "@agents", "@playground"] },
    async ({ page }) => {
      // Health, not mere presence (#1029's gate, applied here by #1415). This
      // test makes a live completion call, so a key that EXISTS but is dead
      // cannot produce a verdict about Langflow. Measured on the 2026-07-27
      // daily (run 30261409427), where the Anthropic account was drained: THIS
      // test hard-failed 3/3 while Test 1 passed — see the comment on Test 1.
      // Test 3 carries the same gate; Test 1 deliberately does not.
      const providerGate = providerSkipGate(PROVIDER);
      test.skip(providerGate.skip, providerGate.reason);

      // Per-run sentinel: a match proves THIS execution produced the output.
      const token = `ANTHROPIC-${Date.now()}`;

      await loadAgent(page, resolveClaudeModel("haiku"));

      await test.step("Agent has a Claude model selected", async () => {
        const modelValue = page.getByTestId("value-dropdown-model_model");
        await expect(modelValue).toBeVisible({ timeout: 15000 });
        await expect(modelValue).toContainText(/claude/i, { timeout: 10000 });
      });

      await test.step("remove the Web Search + URL tools so execution is a plain completion", async () => {
        await removeToolNodes(page);
      });

      await test.step("execute the flow and echo the sentinel", async () => {
        await runPlaygroundSentinel(page, token);
      });
    },
  );

  test(
    "switches between Claude model families (Haiku → Sonnet → Opus)",
    { tag: ["@stable", "@model-provider", "@agents", "@playground"] },
    async ({ page }) => {
      // Same live-completion gate as Test 2 — the switch is proven by executing
      // on the switched-to Sonnet model, so a dead key wedges this one too.
      const providerGate = providerSkipGate(PROVIDER);
      test.skip(providerGate.skip, providerGate.reason);

      const haiku = resolveClaudeModel("haiku");
      const sonnet = resolveClaudeModel("sonnet");
      const opus = resolveClaudeModel("opus");
      test.skip(
        !haiku || !sonnet || !opus,
        `Claude family missing from models.json (haiku=${haiku}, sonnet=${sonnet}, opus=${opus}) — run collect-models.spec.ts`,
      );

      const token = `ANTHROPIC-SWITCH-${Date.now()}`;

      await test.step("load the Agent with the Haiku model selected", async () => {
        await loadAgent(page, haiku);
        await expect(page.getByTestId("value-dropdown-model_model")).toContainText(
          haiku!,
          { timeout: 15000 },
        );
      });

      await test.step("remove the Web Search + URL tools so execution is a plain completion", async () => {
        await removeToolNodes(page);
      });

      await test.step("switch Haiku → Sonnet via the model dropdown", async () => {
        await switchModel(page, sonnet!);
        // The Playground builds the persisted flow — the switch must be saved.
        await waitForFlowSaveSettled(page);
      });

      await test.step("execute after the switch — the Sonnet model responds", async () => {
        await runPlaygroundSentinel(page, token);
        await page.keyboard.press("Escape"); // close the playground modal
      });

      await test.step("switch Sonnet → Opus — selection only (cost)", async () => {
        await switchModel(page, opus!);
      });
    },
  );
});
