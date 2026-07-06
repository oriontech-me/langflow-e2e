import * as dotenv from "dotenv";
import path from "path";
import fs from "fs";
import type { Page } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { SimpleAgentTemplatePage, type LoadSimpleAgentOptions } from "../../../../pages";
import { waitForFlowSaveSettled } from "../../../../helpers/flows/wait-for-flow-save-settled";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import {
  hasProviderEnvKeys,
  missingProviderEnvKeys,
  providerConfigMap,
  type Provider,
} from "../../../../helpers/provider-setup";
import type { ProviderRecord } from "../../../../helpers/provider-setup/collect-models";

/**
 * Agent tool name validation (QA-CHECKLIST §6.4 "Tool with invalid name —
 * validation prevents execution with clear message").
 *
 *   Test 1 — rename the URL tool's slug to a name with characters no provider
 *            accepts (`invalid tool name!!`): the run never executes — the
 *            Playground surfaces a clear invalid-function-name error.
 *   Test 2 — causal control: the SAME rename flow with a VALID custom name
 *            executes normally, so Test 1's failure is attributable to the
 *            invalid characters, not to the rename machinery.
 *
 * Where the "validation" lives on 1.11 (scouted on 1.11.0.dev33): Langflow has
 * NO edit-time validation — the tools modal accepts the name (normalizing only
 * case and spaces; `!` passes through) and the backend assigns it verbatim to
 * the LangChain tool. The block comes from the provider's request validation
 * (deterministic HTTP 400 before any inference). See the spec doc's Scope note.
 */

if (!process.env.CI) {
  dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });
}

const INVALID_TOOL_NAME = "invalid tool name!!";
const VALID_TOOL_NAME = "fetch_content_renamed";
// A task the agent answers directly — no tool call needed. Test 1 fails before
// any model call regardless; Test 2 completes in a single cheap turn.
const TASK = "Reply with exactly: hello from the control test";
// Provider wording for a rejected function name — Google ("Invalid function
// name…", INVALID_ARGUMENT) and OpenAI ("string does not match pattern").
const INVALID_NAME_ERROR = /invalid function name|does not match pattern|INVALID_ARGUMENT/i;

interface ModelRecord {
  provider: string;
  model: string;
}

interface TestTarget {
  label: string;
  options: LoadSimpleAgentOptions;
  skipReason?: string;
}

function getProviderSkipReasons(): Map<string, string> {
  const jsonPath = path.resolve(
    __dirname,
    "../../../../helpers/provider-setup/data/providers.json",
  );
  if (!fs.existsSync(jsonPath)) {
    console.warn("providers.json not found — run collect-models.spec.ts first. Skipping provider pre-validation.");
    return new Map();
  }
  const records = JSON.parse(fs.readFileSync(jsonPath, "utf-8")) as ProviderRecord[];
  const reasons = new Map<string, string>();
  for (const r of records) {
    if (r.status === "inactive") {
      reasons.set(r.provider, `Provider "${r.provider}" inactive — ${r.error}`);
    }
  }
  return reasons;
}

function getModelsFromJson(): ModelRecord[] {
  const jsonPath = path.resolve(
    __dirname,
    "../../../../helpers/provider-setup/data/models.json",
  );
  if (!fs.existsSync(jsonPath)) {
    console.warn("models.json not found — run collect-models.spec.ts first.");
    return [];
  }
  return JSON.parse(fs.readFileSync(jsonPath, "utf-8")) as ModelRecord[];
}

function getTestTargets(): TestTarget[] {
  const skipReasons = getProviderSkipReasons();

  if (process.env.MODEL_TEST_ID) {
    const model = process.env.MODEL_TEST_ID;
    const allModels = getModelsFromJson();
    const record = allModels.find((m) => m.model === model);
    if (!record) {
      console.warn(`MODEL_TEST_ID="${model}" not found in models.json — provider cannot be inferred.`);
      return [{ label: `model:${model}`, options: { model } }];
    }
    const provider = record.provider as Provider;
    return [{
      label: `${provider} / ${model}`,
      options: { provider, model },
      skipReason: skipReasons.get(provider),
    }];
  }

  const allModels = getModelsFromJson();
  if (allModels.length === 0) {
    const fallbackProvider = Object.keys(providerConfigMap)[0] as Provider;
    console.warn("models.json not found or empty — run collect-models.spec.ts first.");
    return [{
      label: `provider:${fallbackProvider} (fallback)`,
      options: { provider: fallbackProvider },
      skipReason: skipReasons.get(fallbackProvider),
    }];
  }

  let models = allModels;
  if (process.env.MODEL_TEST_PROVIDER) {
    models = models.filter((m) => m.provider === process.env.MODEL_TEST_PROVIDER);
  } else if (process.env.ALL_MODELS !== "true") {
    const seen = new Set<string>();
    models = models.filter((m) => {
      if (seen.has(m.provider)) return false;
      seen.add(m.provider);
      return true;
    });
  }

  return models.map((m) => ({
    label: `${m.provider} / ${m.model}`,
    options: { provider: m.provider as Provider, model: m.model },
    skipReason: skipReasons.get(m.provider),
  }));
}

async function loadAgent(page: Page, options: LoadSimpleAgentOptions): Promise<void> {
  try {
    await new SimpleAgentTemplatePage(page).load(options);
  } catch (e: any) {
    if (e?.message?.startsWith("MODEL_NOT_AVAILABLE")) test.skip(true, e.message);
    throw e;
  }
}

// Rename the URL tool through its actions modal. The modal normalizes spaces
// to underscores; the grid's slug cell displays the uppercased form and the
// flow document persists the lowercased form.
async function renameUrlTool(page: Page, newName: string): Promise<void> {
  await page
    .locator('[data-testid^="rf__node-URLComponent"]')
    .getByTestId("button_open_actions")
    .click();
  await expect(page.getByTestId("btn_close_tools_modal")).toBeVisible({
    timeout: 15000,
  });

  const nameCell = page.locator('[role="dialog"] .ag-cell[col-id="name"]').first();
  await nameCell.dblclick();
  const input = page.getByTestId("input_update_name");
  await expect(input).toBeVisible({ timeout: 10000 });
  await input.fill(newName);
  await input.press("Enter");

  // The slug cell reflecting the new value proves the grid committed the edit.
  const normalized = newName.trim().replace(/\s+/g, "_");
  const slugCell = page.locator('[role="dialog"] .ag-cell[col-id="name_1"]').first();
  await expect(slugCell).toContainText(
    new RegExp(normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
    { timeout: 10000 },
  );

  await page.keyboard.press("Escape");
  await expect(page.getByTestId("btn_close_tools_modal")).toBeHidden({
    timeout: 10000,
  });
}

// The rename only matters if it reached the persisted flow document — a lost
// edit would make the control test vacuous. Polls the flows API for the URL
// node's tools_metadata name (autosave may lag the UI commit).
// The canvas URL's flow id can be TRANSIENT on 1.11 (GET by that id 404s), so
// the flow is resolved from the flows list instead — SimpleAgentTemplatePage
// wipes all flows on load, so exactly one flow with a URLComponent exists.
async function expectPersistedToolName(
  _page: Page,
  request: APIRequestContext,
  expected: string,
): Promise<void> {
  const bearer = await getAuthToken(request);
  await expect
    .poll(
      async () => {
        const res = await request.get(`/api/v1/flows/?remove_example_flows=true&header_flows=false`, {
          headers: { Authorization: bearer },
        });
        if (res.status() !== 200) return `GET flows -> ${res.status()}`;
        const flows = await res.json();
        const urlNodes = (Array.isArray(flows) ? flows : [])
          .flatMap((f: any) => f.data?.nodes ?? [])
          .filter((n: any) => n.data?.type === "URLComponent");
        if (urlNodes.length !== 1) return `expected 1 URLComponent flow, found ${urlNodes.length}`;
        return urlNodes[0]?.data?.node?.template?.tools_metadata?.value?.[0]?.name;
      },
      { timeout: 15000 },
    )
    .toBe(expected);
}

// Set the task on the ChatInput node (the Playground prompt pre-fills from it;
// typing into the Playground races an async default re-injection).
async function setChatInputText(page: Page, text: string): Promise<void> {
  const field = page.locator(
    '[data-testid^="rf__node-ChatInput"] [data-testid="textarea_str_input_value"]',
  );
  await expect(field).toBeVisible({ timeout: 15000 });
  await field.click();
  await field.fill(text);
  await field.blur();
}

async function waitForAgentToFinish(page: Page): Promise<void> {
  const stopButton = page.getByRole("button", { name: "Stop" });
  const stopVisible = await stopButton.isVisible({ timeout: 10000 }).catch(() => false);
  if (stopVisible) {
    await expect(stopButton).toBeHidden({ timeout: 120000 });
  }
}

// Open the Playground with the pre-seeded task and send it.
async function openPlaygroundAndSend(page: Page): Promise<void> {
  await page.getByTestId("playground-btn-flow-io").click();
  const chatInput = page.getByTestId("input-chat-playground").last();
  await expect(chatInput).toBeVisible({ timeout: 30000 });
  await expect(chatInput).toHaveValue(TASK, { timeout: 15000 });
  await page.getByTestId("button-send").last().click();
  await waitForAgentToFinish(page);
}

const targets = getTestTargets();

// SimpleAgentTemplatePage.load() deletes all flows before loading the template;
// serial mode + --workers=1 keeps the shared instance state deterministic.
test.describe.configure({ mode: "serial" });

for (const { label, options, skipReason } of targets) {
  const provider = options.provider ?? (Object.keys(providerConfigMap)[0] as Provider);

  test.describe(`Agent Tool Name Validation [${label}]`, () => {
    test(
      "an invalid tool name blocks execution with a clear message",
      { tag: ["@stable", "@regression", "@agents", "@playground"] },
      async ({ page, request }) => {
        test.skip(!!skipReason, skipReason ?? "");
        test.skip(
          !hasProviderEnvKeys(provider),
          `Missing env vars for provider "${provider}": ${missingProviderEnvKeys(provider).join(", ")}`,
        );

        await loadAgent(page, options);

        await test.step("rename the URL tool to an invalid function name", async () => {
          await renameUrlTool(page, INVALID_TOOL_NAME);
          await setChatInputText(page, TASK);
          await waitForFlowSaveSettled(page);
          await expectPersistedToolName(page, request, "invalid_tool_name!!");
        });

        await test.step("run and assert the clear invalid-name error", async () => {
          // The failure is the scenario under test — the provider rejects the
          // request at validation, before any inference.
          (page as any).allowFlowErrors();
          await openPlaygroundAndSend(page);
          await expect(page.getByText(INVALID_NAME_ERROR).first()).toBeVisible({
            timeout: 60000,
          });
        });
      },
    );

    test(
      "causal control — a valid custom tool name executes normally",
      { tag: ["@stable", "@regression", "@agents", "@playground"] },
      async ({ page, request }) => {
        test.skip(!!skipReason, skipReason ?? "");
        test.skip(
          !hasProviderEnvKeys(provider),
          `Missing env vars for provider "${provider}": ${missingProviderEnvKeys(provider).join(", ")}`,
        );

        await loadAgent(page, options);

        await test.step("rename the URL tool to a valid custom name", async () => {
          await renameUrlTool(page, VALID_TOOL_NAME);
          await setChatInputText(page, TASK);
          await waitForFlowSaveSettled(page);
          await expectPersistedToolName(page, request, VALID_TOOL_NAME);
        });

        await test.step("run and assert a normal answer with no error", async () => {
          // No allowFlowErrors here: any flow error fails the test via the
          // fixture, which is itself half of the causal-pair guarantee.
          await openPlaygroundAndSend(page);
          const bubble = page.getByTestId("div-chat-message").last();
          await expect(bubble).toBeVisible({ timeout: 30000 });
          await expect(bubble).toContainText(/hello/i, { timeout: 30000 });
          await expect(page.getByText(INVALID_NAME_ERROR)).toHaveCount(0);
        });
      },
    );
  });
}
