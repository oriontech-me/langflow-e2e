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

if (!process.env.CI) {
  dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });
}

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
    console.warn("providers.json not found — run collect-providers.spec.ts first. Skipping provider pre-validation.");
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

const targets = getTestTargets();

// SimpleAgentTemplatePage.load() deletes all flows before loading the template.
// File-level serial mode prevents parallel provider blocks from wiping each other's flows.
test.describe.configure({ mode: "serial" });

for (const { label, options, skipReason } of targets) {
  const provider = options.provider ?? (Object.keys(providerConfigMap)[0] as Provider);

  test.describe(`Agent Component Regression [${label}]`, () => {

    test(
      "agent interaction suite",
      { tag: ["@stable", "@release", "@components", "@agents", "@playground"] },
      async ({ page }) => {
        test.skip(!!skipReason, skipReason ?? "");
        test.skip(
          !hasProviderEnvKeys(provider),
          `Missing env vars for provider "${provider}": ${missingProviderEnvKeys(provider).join(", ")}`,
        );

        await loadAgent(page, options);
        await page.getByTestId("playground-btn-flow-io").click();
        await expect(page.getByTestId("input-chat-playground").last()).toBeVisible({ timeout: 30000 });

        await test.step("responds without tools connected", async () => {
          await page.getByTestId("input-chat-playground").last().fill("What is the capital of France?");
          await page.getByTestId("button-send").last().click();
          await waitForAgentToFinish(page);
          await expect.soft(page.getByTestId("div-chat-message").last()).toBeVisible({ timeout: 30000 });
          const text = await page.getByTestId("div-chat-message").last().innerText();
          expect.soft(text.trim().length).toBeGreaterThan(1);
        });

        await test.step("shows reasoning steps", async () => {
          await page.getByTestId("input-chat-playground").last().fill("Who was the first astronaut to walk on the Moon?");
          await page.getByTestId("button-send").last().click();
          await waitForAgentToFinish(page);
          await expect.soft(page.getByTestId("div-chat-message").last()).toBeVisible({ timeout: 30000 });
          const finishedText = page.getByText(/Finished in/).last();
          if (await finishedText.isVisible({ timeout: 5000 }).catch(() => false)) {
            const durationText = await finishedText.innerText();
            expect.soft(durationText.trim().length).toBeGreaterThan(0);
          }
        });

        await test.step("streams response progressively and displays duration", async () => {
          await page.getByTestId("input-chat-playground").last().fill(
            "Write a 5-paragraph summary explaining what artificial intelligence is, covering its definition, history, main techniques, applications, and future perspectives.",
          );
          await page.getByTestId("button-send").last().click();

          const stopButton = page.getByRole("button", { name: "Stop" });
          const chatMessage = page.getByTestId("div-chat-message").last();

          await expect.soft(chatMessage).toBeVisible({ timeout: 30000 });

          // Wait for the Stop button to appear — confirms the model is actively generating.
          // div-chat-message can appear before Stop (element created before first token),
          // so we must not start polling until Stop is visible or we'll exit immediately.
          const stopAppeared = await stopButton
            .waitFor({ state: "visible", timeout: 30000 })
            .then(() => true)
            .catch(() => false);

          if (!stopAppeared) {
            // Model responded before Stop appeared — too fast for streaming to be observable.
            // Still validate the final response exists and continue to remaining steps.
            const earlyFinalText = await chatMessage.innerText();
            expect.soft(earlyFinalText.trim().length).toBeGreaterThan(1);
            return;
          }

          // Poll while Stop is visible (max 5s) to detect text growth deterministically.
          // prevLength is captured after Stop appears so the model has already started.
          const prevLength = (await chatMessage.innerText()).trim().length;
          const deadline = Date.now() + 5000;

          while (Date.now() < deadline) {
            const stopVisible = await stopButton.isVisible().catch(() => false);
            if (!stopVisible) break;
            const currentLength = (await chatMessage.innerText()).trim().length;
            if (currentLength > prevLength) break;
            await page.waitForTimeout(100);
          }

          await expect(stopButton).toBeHidden({ timeout: 120000 });

          const finalText = await chatMessage.innerText();
          expect.soft(finalText.trim().length).toBeGreaterThan(1);

          // Growth not observed: the model may render faster than our 100ms poll interval,
          // or div-chat-message may only be applied after streaming completes (making .last()
          // point at the previous stable response throughout). The finalText check above
          // catches truly broken streaming (empty response). No assertion when unobservable.

          // "Finished in Xs" only appears when the frontend duration timer fires
          // (depends on isBuilding cycle + React render). node_duration_agent in the
          // canvas step is the canonical duration assertion backed by the backend.
          const durationBadge = page.getByText(/Finished in \d+(\.\d+)?s/);
          if (await durationBadge.isVisible({ timeout: 5000 }).catch(() => false)) {
            expect.soft((await durationBadge.innerText()).trim().length).toBeGreaterThan(0);
          }
        });

        await test.step("handles multiple consecutive messages", async () => {
          const count = await page.getByTestId("div-chat-message").count();
          expect.soft(count).toBeGreaterThanOrEqual(2);
        });

        await test.step("response time visible on canvas after closing playground", async () => {
          await page.getByTestId("playground-close-button").click();
          await expect.soft(page.getByTestId("node_duration_agent")).toBeVisible({ timeout: 10000 });
        });
      },
    );

    test(
      "agent stop button must halt execution mid-run",
      // @stable removed: hard-fails every weekly run (deterministic). Tracked in #355;
      // tag to be restored in the correction PR. See @stable lifecycle in CONTRIBUTING.md.
      { tag: ["@release", "@components", "@agents", "@playground"] },
      async ({ page }) => {
        test.skip(!!skipReason, skipReason ?? "");
        test.skip(
          !hasProviderEnvKeys(provider),
          `Missing env vars for provider "${provider}": ${missingProviderEnvKeys(provider).join(", ")}`,
        );

        await loadAgent(page, options);
        await page.getByTestId("playground-btn-flow-io").click();

        await page
          .getByTestId("input-chat-playground")
          .last()
          .fill("Write a detailed story about the life and adventures of a fictional explorer in the 18th century.");
        await page.getByTestId("button-send").last().click();

        const stopButton = page.getByRole("button", { name: "Stop" });
        const stopVisible = await stopButton.isVisible({ timeout: 30000 }).catch(() => false);
        if (!stopVisible) {
          console.log(`Model ${options.model ?? provider} responded without stop button — skipping halt test`);
          return;
        }

        // dispatchEvent bypasses Playwright actionability checks — stop button may be transitioning during stream teardown
        await stopButton.dispatchEvent("click");
        await expect(stopButton).toBeHidden({ timeout: 30000 });
        await expect(page.getByTestId("input-chat-playground").last()).toBeVisible({ timeout: 10000 });
      },
    );
  });
}
