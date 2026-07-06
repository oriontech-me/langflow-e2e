import * as dotenv from "dotenv";
import path from "path";
import fs from "fs";
import type { Page } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { SimpleAgentTemplatePage, type LoadSimpleAgentOptions } from "../../../../pages";
import { waitForFlowSaveSettled } from "../../../../helpers/flows/wait-for-flow-save-settled";
import {
  hasProviderEnvKeys,
  missingProviderEnvKeys,
  providerConfigMap,
  type Provider,
} from "../../../../helpers/provider-setup";
import type { ProviderRecord } from "../../../../helpers/provider-setup/collect-models";

/**
 * Agent max_tokens (QA-CHECKLIST §6.2 "max_tokens truncates response as
 * configured", §7.7 "Maximum token count — response truncated as configured").
 * The cap is proven at the TOKEN level via the Playground token-usage tooltip:
 *
 *   Test 1 — max_tokens=50 + a ~500-word essay prompt: the response's Output
 *            token count is <= 50. The reply TEXT is not asserted — a thinking
 *            model may spend the whole budget on reasoning and legitimately
 *            render an empty reply ("Message empty." placeholder).
 *   Test 2 — causal control: max_tokens unset (0 = unlimited), same prompt —
 *            Output > 50 and a real essay comes back. Only max_tokens differs.
 *
 * §7.7 "Temperature parameter (verify via network payload)" is NOT covered:
 * the Agent has no temperature parameter on 1.11 (absent from agent.py inputs
 * and from the saved flow; it left with the model-bundle refactor). Flagged on
 * the issue/PR — see the spec doc's Scope note.
 */

if (!process.env.CI) {
  dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });
}

const TOKEN_LIMIT = 50;
const ESSAY_PROMPT =
  "Write a detailed 500-word essay about the history of the ocean. Do not use any tools — answer directly.";

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

// Set the Agent's max_tokens in the Controls dialog. Two scouted quirks
// (dev33): (a) the int field rejects Playwright's fill() outright and swallows
// the first keystroke of an immediate pressSequentially — a typed "50" becomes
// a range_spec-clamped "1"; (b) closing the dialog can race the field's commit
// debounce, persisting 0 even though the DOM showed the typed value. So: type
// slowly and verify the DOM, blur to force the commit, and verify the value
// actually PERSISTED via the flows API — reopening the dialog and retrying the
// whole cycle when it did not.
async function setMaxTokens(page: Page, value: string): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    await page.getByTestId("edit-button-modal").click();
    const field = page.getByTestId("int_int_edit_max_tokens");
    await expect(field).toBeVisible({ timeout: 15000 });
    await field.scrollIntoViewIfNeeded();
    for (let typeTry = 0; typeTry < 3; typeTry++) {
      await field.click();
      await page.waitForTimeout(600);
      await field.press("ControlOrMeta+a");
      await field.press("Backspace");
      await field.pressSequentially(value, { delay: 150 });
      if ((await field.inputValue()) === value) break;
    }
    await expect(field).toHaveValue(value);
    await field.press("Tab");
    await page.waitForTimeout(800);
    await page.getByTestId("edit-button-close").click();
    await waitForFlowSaveSettled(page);
    if ((await getSavedMaxTokens(page)) === Number(value)) return;
    console.warn(`setMaxTokens: value did not persist (attempt ${attempt}) — retrying`);
  }
  expect(await getSavedMaxTokens(page)).toBe(Number(value));
}

// Read the Agent node's persisted max_tokens straight from the flows API. The
// int field's quirks make a silently unsaved value possible — the causal pair
// is only trustworthy when the saved value is verified before each run.
async function getSavedMaxTokens(page: Page): Promise<unknown> {
  await page.waitForURL(/\/flow\/[^/?#]+/);
  const flowId = page.url().split("/flow/")[1].split(/[/?#]/)[0];
  const res = await page.request.get(`/api/v1/flows/${flowId}`);
  expect(res.status()).toBe(200);
  const flow = await res.json();
  const agent = flow.data.nodes.find((n: any) => n.id.startsWith("Agent"));
  return agent?.data?.node?.template?.max_tokens?.value;
}

// Seed the prompt on the ChatInput node (the Playground prefill re-injects the
// template default asynchronously and would corrupt typed text — see
// agent-multimodal-image-input.md), then send it and wait for the response to
// complete (token-usage badge renders only on completion).
async function runPrompt(page: Page): Promise<string> {
  const node = page.locator(
    '[data-testid^="rf__node-ChatInput"] [data-testid="textarea_str_input_value"]',
  );
  await expect(node).toBeVisible({ timeout: 15000 });
  await node.click();
  await node.fill(ESSAY_PROMPT);
  await node.blur();
  await waitForFlowSaveSettled(page);

  await page.getByTestId("playground-btn-flow-io").click();
  await expect(page.getByTestId("input-chat-playground").last()).toBeVisible({ timeout: 30000 });
  await page.getByTestId("button-send").last().click();

  const stop = page.getByRole("button", { name: "Stop" });
  if (await stop.isVisible({ timeout: 8000 }).catch(() => false)) {
    await stop.waitFor({ state: "hidden", timeout: 120000 }).catch(() => {});
  }
  await expect(page.getByTestId("chat-message-token-usage")).toHaveCount(1, { timeout: 120000 });

  return (await page.getByTestId("div-chat-message").last().innerText()).trim();
}

// "1.9K" -> 1900, "46" -> 46, missing/empty -> 0 (a tight cap can be fully
// consumed by reasoning before any visible token — observed with max_tokens=1).
function parseTokenCount(raw: string | undefined): number {
  if (!raw) return 0;
  const n = parseFloat(raw);
  if (Number.isNaN(n)) return 0;
  return raw.trim().toUpperCase().endsWith("K") ? Math.round(n * 1000) : n;
}

// Hover the token-usage badge and read the response's Output token count from
// its tooltip ("Input: 1.0K / Output: 46" layout).
async function readOutputTokens(page: Page): Promise<number> {
  const badge = page.getByTestId("chat-message-token-usage").last();
  await badge.hover();
  const tooltip = page
    .locator('[role="tooltip"], [data-radix-popper-content-wrapper]')
    .first();
  await expect(tooltip).toBeVisible({ timeout: 10000 });
  const text = await tooltip.innerText();
  const match = text.match(/Output:\s*([\d.]+K?)?/i);
  expect(match, `token tooltip must contain an Output entry — got: ${text}`).toBeTruthy();
  return parseTokenCount(match?.[1]);
}

const targets = getTestTargets();

// SimpleAgentTemplatePage.load() deletes all flows before loading the template;
// serial mode + --workers=1 keeps the shared instance state deterministic.
test.describe.configure({ mode: "serial" });

for (const { label, options, skipReason } of targets) {
  const provider = options.provider ?? (Object.keys(providerConfigMap)[0] as Provider);

  test.describe(`Agent max_tokens [${label}]`, () => {
    test(
      "max_tokens=50 caps the response's output tokens",
      { tag: ["@stable", "@regression", "@agents", "@playground"] },
      async ({ page }) => {
        test.skip(!!skipReason, skipReason ?? "");
        test.skip(
          !hasProviderEnvKeys(provider),
          `Missing env vars for provider "${provider}": ${missingProviderEnvKeys(provider).join(", ")}`,
        );

        await loadAgent(page, options);

        await test.step(`cap max_tokens at ${TOKEN_LIMIT}`, async () => {
          await setMaxTokens(page, String(TOKEN_LIMIT));
          expect(await getSavedMaxTokens(page)).toBe(TOKEN_LIMIT);
        });

        await test.step("run the essay prompt and assert Output tokens <= limit", async () => {
          await runPrompt(page);
          const outputTokens = await readOutputTokens(page);
          // The provider enforces the cap server-side; the reply text is NOT
          // asserted — a thinking model may spend the whole budget on
          // reasoning and render an empty reply, which is still a correct cap.
          expect(outputTokens).toBeLessThanOrEqual(TOKEN_LIMIT);
        });
      },
    );

    test(
      "causal control — unset max_tokens generates freely",
      { tag: ["@stable", "@regression", "@agents", "@playground"] },
      async ({ page }) => {
        test.skip(!!skipReason, skipReason ?? "");
        test.skip(
          !hasProviderEnvKeys(provider),
          `Missing env vars for provider "${provider}": ${missingProviderEnvKeys(provider).join(", ")}`,
        );

        await loadAgent(page, options);

        await test.step("verify max_tokens is unset (0/empty = unlimited)", async () => {
          // The fresh template ships without a limit; _get_max_tokens_value()
          // maps ""/0 to None (unlimited). Verify instead of assuming.
          const saved = await getSavedMaxTokens(page);
          expect([0, "", null, undefined]).toContain(saved as never);
        });

        await test.step("run the essay prompt and assert unbounded output", async () => {
          const reply = await runPrompt(page);
          const outputTokens = await readOutputTokens(page);
          // Only max_tokens differs from Test 1, so its cap is attributable to
          // the parameter, not to the model choosing to answer briefly.
          expect(outputTokens).toBeGreaterThan(TOKEN_LIMIT);
          expect(reply.split(/\s+/).length).toBeGreaterThan(200);
        });
      },
    );
  });
}
