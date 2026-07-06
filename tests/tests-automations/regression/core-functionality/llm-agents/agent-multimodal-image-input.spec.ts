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
 * Agent multimodal image input (QA-CHECKLIST §6.5, "Image passed via input
 * handle is processed correctly").
 *
 *   Test 1 — an image attached to the chat input flows through the
 *            ChatInput.message → Agent.input handle to a vision-capable model,
 *            and the agent's response describes the image content.
 *   Test 2 — negative control: the same prompt with NO image must not produce
 *            the image-specific keyword, proving Test 1's match is caused by the
 *            processed image (not the prompt or chance).
 *
 * Parameterized per active provider, resolving a vision-capable chat model
 * (skips a provider with none). Mechanism scouted on 1.11.0.dev33: the ChatInput
 * node has no canvas file field — the only image-attach path is the chat input
 * widget (`input-wrapper` file input), which feeds the confirmed input handle.
 */

if (!process.env.CI) {
  dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });
}

const IMAGE_PATH = "tests/assets/media/chain.png";
const IMAGE_ALT = "chain.png";
const PROMPT = "what is this image? describe it";
// chain.png is a chain/links graphic; a vision model describes it with one of
// these tokens. `chain` is the most image-specific — the negative control keys
// on it.
const DESCRIBES_IMAGE = /chain|link|logo|inkscape/i;
const IMAGE_SPECIFIC = /chain/i;

interface ModelRecord {
  provider: string;
  model: string;
}

interface TestTarget {
  label: string;
  options: LoadSimpleAgentOptions;
  skipReason?: string;
}

// Non-vision / non-chat model families to exclude when resolving a vision model.
const NON_VISION = /gemma|embedding|tts|audio|whisper|realtime|image|customtools|moderation|search/i;

// Per-provider preference for a fast, vision-capable chat model.
const VISION_PREFS: Record<string, RegExp[]> = {
  openai: [/^gpt-4o-mini$/, /^gpt-4o$/, /^gpt-4\.1(-mini)?$/, /gpt-4o/, /^gpt-5.*mini$/, /^gpt-5/],
  google: [/^gemini-2\.5-flash$/, /^gemini-3\.5-flash$/, /^gemini-flash-latest$/, /gemini.*flash/, /gemini/],
  anthropic: [/^claude-3-5-sonnet/, /^claude-3-5-haiku/, /^claude-3-7/, /claude-3\.?5/, /claude-3/, /claude/],
};

// Resolve a vision-capable model for a provider from its models.json entries.
function resolveVisionModel(provider: string, models: ModelRecord[]): string | undefined {
  const candidates = models
    .filter((m) => m.provider === provider)
    .map((m) => m.model)
    .filter((m) => !NON_VISION.test(m));
  const prefs = VISION_PREFS[provider] ?? [/.*/];
  for (const pref of prefs) {
    const hit = candidates.find((m) => pref.test(m));
    if (hit) return hit;
  }
  return candidates[0];
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

// One target per active provider, each with a resolved vision-capable model.
// A provider with no vision model is skipped with a reason.
function getTestTargets(): TestTarget[] {
  const skipReasons = getProviderSkipReasons();
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

  // Explicit single-provider override.
  if (process.env.MODEL_TEST_PROVIDER) {
    const provider = process.env.MODEL_TEST_PROVIDER;
    const model = resolveVisionModel(provider, allModels);
    return [{
      label: `${provider} / ${model ?? "(no vision model)"}`,
      options: { provider: provider as Provider, model },
      skipReason:
        skipReasons.get(provider) ??
        (model ? undefined : `Provider "${provider}" has no vision-capable model in models.json`),
    }];
  }

  // One vision model per provider present in models.json.
  const providers = Array.from(new Set(allModels.map((m) => m.provider)));
  return providers.map((provider) => {
    const model = resolveVisionModel(provider, allModels);
    return {
      label: `${provider} / ${model ?? "(no vision model)"}`,
      options: { provider: provider as Provider, model },
      skipReason:
        skipReasons.get(provider) ??
        (model ? undefined : `Provider "${provider}" has no vision-capable model in models.json`),
    };
  });
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

// Set the ChatInput node's "Input Text" on the canvas. The Playground chat input
// pre-fills from this node value, so setting it here makes the Playground prompt
// deterministic — typing into the Playground races an async re-injection of the
// template default ("Hello, how are you?"), which corrupts the value.
async function setChatInputText(page: Page, text: string): Promise<void> {
  const field = page.locator(
    '[data-testid^="rf__node-ChatInput"] [data-testid="textarea_str_input_value"]',
  );
  await expect(field).toBeVisible({ timeout: 15000 });
  await field.click();
  await field.fill(text);
  await field.blur();
  // Playground builds/reads the persisted flow — the new value must be saved.
  await waitForFlowSaveSettled(page);
}

// Open the Playground and (optionally) attach an image through the chat input
// widget (`input-wrapper` file input) — the only UI path to attach an image; it
// feeds the ChatInput → Agent input handle. The prompt is prefilled from the
// ChatInput node value set via setChatInputText().
async function openPlayground(page: Page, attachImage: boolean): Promise<void> {
  await page.getByTestId("playground-btn-flow-io").click();
  const chatInput = page.getByTestId("input-chat-playground").last();
  await expect(chatInput).toBeVisible({ timeout: 30000 });
  // Prefilled from the ChatInput node — deterministic, no typing race.
  await expect(chatInput).toHaveValue(PROMPT, { timeout: 15000 });

  if (attachImage) {
    await page
      .locator('[data-testid="input-wrapper"] input[type="file"]')
      .setInputFiles(IMAGE_PATH);
    // Attachment renders as an <img alt="chain.png"> preview, not literal text.
    await expect(page.locator(`img[alt="${IMAGE_ALT}"]`).first()).toBeVisible({
      timeout: 30000,
    });
  }
}

const targets = getTestTargets();

// SimpleAgentTemplatePage.load() deletes all flows before loading the template.
// File-level serial mode prevents parallel provider blocks from wiping each
// other's flows.
test.describe.configure({ mode: "serial" });

for (const { label, options, skipReason } of targets) {
  const provider = options.provider ?? (Object.keys(providerConfigMap)[0] as Provider);

  test.describe(`Agent Multimodal Image Input [${label}]`, () => {
    test(
      "image via input handle is described by the agent",
      { tag: ["@stable", "@regression", "@agents", "@playground"] },
      async ({ page }) => {
        test.skip(!!skipReason, skipReason ?? "");
        test.skip(
          !hasProviderEnvKeys(provider),
          `Missing env vars for provider "${provider}": ${missingProviderEnvKeys(provider).join(", ")}`,
        );

        await loadAgent(page, options);

        await test.step("attach the image and send it through the input handle", async () => {
          await setChatInputText(page, PROMPT);
          await openPlayground(page, /* attachImage */ true);
          await page.getByTestId("button-send").last().click();
          await waitForAgentToFinish(page);
        });

        await test.step("assert the vision model described the image content", async () => {
          // The image reached the model via ChatInput → Agent.input: the reply
          // describes the actual image (chain/links), not a generic answer.
          const response = page.locator(".markdown.prose").last();
          await expect(response).toContainText(DESCRIBES_IMAGE, { timeout: 60000 });
          const text = await response.textContent();
          // Secondary guard against a one-word answer.
          expect((text ?? "").length).toBeGreaterThan(50);
        });
      },
    );

    test(
      "negative control — no image, no image-specific description",
      { tag: ["@stable", "@regression", "@agents", "@playground"] },
      async ({ page }) => {
        test.skip(!!skipReason, skipReason ?? "");
        test.skip(
          !hasProviderEnvKeys(provider),
          `Missing env vars for provider "${provider}": ${missingProviderEnvKeys(provider).join(", ")}`,
        );

        await loadAgent(page, options);

        await test.step("run the same prompt with NO image attached", async () => {
          await setChatInputText(page, PROMPT);
          await openPlayground(page, /* attachImage */ false);
          await page.getByTestId("button-send").last().click();
          await waitForAgentToFinish(page);
        });

        await test.step("assert the response does not describe a chain", async () => {
          // With no image the model cannot describe the chain — so the keyword
          // only appears in Test 1 because the image was actually processed.
          const response = page.locator(".markdown.prose").last();
          await expect(response).toBeVisible({ timeout: 60000 });
          const text = (await response.textContent()) ?? "";
          expect(text.length).toBeGreaterThan(0);
          expect(text).not.toMatch(IMAGE_SPECIFIC);
        });
      },
    );
  });
}
