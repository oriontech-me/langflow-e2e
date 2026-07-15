import * as dotenv from "dotenv";
import path from "path";
import fs from "fs";
import type { Page } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { SimpleAgentTemplatePage, type LoadSimpleAgentOptions } from "../../../../pages";
import {
  hasProviderEnvKeys,
  missingProviderEnvKeys,
  providerConfigMap,
  type Provider,
} from "../../../../helpers/provider-setup";
import type { ProviderRecord } from "../../../../helpers/provider-setup/collect-models";
import { waitForFlowSaveSettled } from "../../../../helpers/flows/wait-for-flow-save-settled";

/**
 * Agent robustness on a degenerate model output (QA-CHECKLIST §6.5,
 * "Empty response or model refusal — component does not crash").
 *
 *   Test 1 — a refusal-forcing instruction: the model refuses with a per-run
 *            marker; the component finishes with no backend/flow error.
 *   Test 2 — an empty-forcing instruction: the run completes without crashing;
 *            whether the reply is actually empty is logged, not asserted (model
 *            obedience varies — a soft assertion would still fail the test).
 *
 * The crash guard is the fixture: importing `test` from fixtures.ts adds backend
 * 4xx/5xx and flow-error monitoring, so a component crash on the degenerate
 * output fails the test automatically. A green run therefore proves the §6.5
 * "does not crash" contract. Mirrors agent-system-prompt.spec.ts.
 */

if (!process.env.CI) {
  dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });
}

// The user message is unrelated to the instruction — a plain question the agent
// would normally answer, so a refusal / empty reply can only come from the
// instruction we set.
const USER_MESSAGE = "What is the capital of France?";

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
      console.warn(
        `MODEL_TEST_ID="${model}" not found in models.json — provider cannot be inferred. ` +
        `Run collect-models.spec.ts first, or set MODEL_TEST_PROVIDER.`,
      );
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

async function waitForAgentToFinish(page: Page): Promise<void> {
  const stopButton = page.getByRole("button", { name: "Stop" });
  const stopVisible = await stopButton.isVisible({ timeout: 10000 }).catch(() => false);
  if (stopVisible) {
    await expect(stopButton).toBeHidden({ timeout: 120000 });
  }
}

// Fill the Agent Instructions (system prompt) and make sure the debounced
// autosave has settled before the build, so the run uses the prompt we set, not
// the template default.
async function setAgentInstructions(page: Page, prompt: string): Promise<void> {
  const promptField = page.getByTestId("textarea_str_system_prompt");
  await expect(promptField).toBeVisible({ timeout: 15000 });

  await promptField.click();
  await promptField.fill(prompt);
  await promptField.blur();
  // Drain ALL debounced autosave PATCHes instead of racing a single
  // `waitForResponse(PATCH && ok(), 15s)` (#608). The old waiter flaked three
  // ways on the google run: (a) the autosave debounce could exceed 15s under
  // load; (b) a stale PATCH still in flight from load() (model selection) could
  // resolve it BEFORE the instruction's own save landed; (c) a transient
  // non-ok PATCH never matched `resp.ok()`, so it waited out the full timeout.
  // `waitForFlowSaveSettled` waits for a quiet period after the last flow-save
  // PATCH (any status), which is robust to all three. Matches the hardened
  // `agent-system-prompt.spec.ts` helper (#635).
  await waitForFlowSaveSettled(page);
}

// Open the Playground, send a message, wait for the run to finish, return the
// latest chat message bubble locator + its text.
async function askAndGetReplyBubble(page: Page, message: string) {
  await page.getByTestId("playground-btn-flow-io").click();
  await expect(page.getByTestId("input-chat-playground").last()).toBeVisible({
    timeout: 30000,
  });

  await page.getByTestId("input-chat-playground").last().fill(message);
  await page.getByTestId("button-send").last().click();

  await waitForAgentToFinish(page);

  const bubble = page.getByTestId("div-chat-message").last();
  await expect(bubble).toBeVisible({ timeout: 30000 });
  return { bubble, text: (await bubble.innerText()).trim() };
}

const targets = getTestTargets();

// SimpleAgentTemplatePage.load() deletes all flows before loading the template.
// File-level serial mode prevents parallel provider blocks from wiping each
// other's flows.
test.describe.configure({ mode: "serial" });

for (const { label, options, skipReason } of targets) {
  const provider = options.provider ?? (Object.keys(providerConfigMap)[0] as Provider);

  test.describe(`Agent Empty / Refusal Response [${label}]`, () => {
    test(
      "model refusal does not crash the component",
      { tag: ["@stable", "@regression", "@agents", "@playground"] },
      async ({ page }) => {
        test.skip(!!skipReason, skipReason ?? "");
        test.skip(
          !hasProviderEnvKeys(provider),
          `Missing env vars for provider "${provider}": ${missingProviderEnvKeys(provider).join(", ")}`,
        );

        // Per-run marker: a passing assertion can only be caused by THIS run's
        // refusal instruction reaching the model — never stale/coincidental text.
        const uniq = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const marker = `REFUSE-${uniq}`;
        const systemPrompt = `You must refuse every request. Regardless of what the user asks, reply with exactly this and nothing else: ${marker}`;

        await loadAgent(page, options);

        await test.step("set a refusal-forcing instruction and wait for autosave", async () => {
          await setAgentInstructions(page, systemPrompt);
        });

        await test.step("run a message and assert the component refuses without crashing", async () => {
          const { text } = await askAndGetReplyBubble(page, USER_MESSAGE);
          // Hard: the model produced the induced refusal (not a helpful answer),
          // so the pass is not coincidental. The fixture's backend/flow-error
          // monitoring is the crash guard — a component crash on the refusal path
          // would raise a backend error and auto-fail this test.
          expect(text).toContain(marker);
        });
      },
    );

    test(
      "empty response does not crash the component",
      { tag: ["@stable", "@regression", "@agents", "@playground"] },
      async ({ page }) => {
        test.skip(!!skipReason, skipReason ?? "");
        test.skip(
          !hasProviderEnvKeys(provider),
          `Missing env vars for provider "${provider}": ${missingProviderEnvKeys(provider).join(", ")}`,
        );

        const systemPrompt =
          "Reply with an empty response. Output nothing at all — no text, no punctuation, no whitespace.";

        await loadAgent(page, options);

        await test.step("set an empty-forcing instruction and wait for autosave", async () => {
          await setAgentInstructions(page, systemPrompt);
        });

        await test.step("run a message and assert the component completes without crashing", async () => {
          // Hard: the run completes — the assistant bubble renders (even for an
          // empty completion) and the Stop button is gone. This is a
          // deterministic completion signal independent of the reply content;
          // combined with the fixture's backend/flow-error monitoring it proves
          // the component did not crash on the empty-content path.
          const { text } = await askAndGetReplyBubble(page, USER_MESSAGE);

          // Optional signal — NOT asserted (expect.soft would still fail the
          // test): whether the model actually obeyed and returned empty vs.
          // answered anyway. Emptiness is model-obedience dependent. When the
          // model DOES return an empty completion, Langflow renders the friendly
          // placeholder "Message empty." in the bubble instead of crashing — that
          // placeholder is itself the graceful-handling signal §6.5 asks for.
          const isEmpty = text.length === 0 || /^message empty\.?$/i.test(text);
          console.log(
            isEmpty
              ? `empty response obeyed: the component handled an empty completion without crashing (bubble: "${text}")`
              : `model did not return empty (obedience); reply: ${text.slice(0, 80)}`,
          );
        });
      },
    );
  });
}
