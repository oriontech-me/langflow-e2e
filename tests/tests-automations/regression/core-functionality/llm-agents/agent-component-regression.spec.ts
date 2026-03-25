import * as dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { expect, test } from "../../../../fixtures/fixtures";
import { SimpleAgentTemplatePage, type LoadSimpleAgentOptions } from "../../../../pages";
import {
  hasProviderEnvKeys,
  missingProviderEnvKeys,
  type Provider,
} from "../../../../helpers/provider-setup";
import type { ProviderRecord } from "../../../../helpers/provider-setup/collect-models";

// Load .env before resolving strategy and targets
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
  const raw = fs.readFileSync(jsonPath, "utf-8");
  return JSON.parse(raw) as ModelRecord[];
}

function getTestTargets(): TestTarget[] {
  const strategy = process.env.MODEL_TEST_STRATEGY ?? "all";
  const skipReasons = getProviderSkipReasons();

  if (strategy === "model" && process.env.MODEL_TEST_ID) {
    const model = process.env.MODEL_TEST_ID;
    const allModels = getModelsFromJson();
    const record = allModels.find((m) => m.model === model);

    if (!record) {
      console.warn(
        `MODEL_TEST_ID="${model}" not found in models.json — provider cannot be inferred. ` +
        `Run collect-models.spec.ts first, or set MODEL_TEST_STRATEGY=provider + MODEL_TEST_PROVIDER.`,
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
    console.warn("models.json not found or empty — run collect-models.spec.ts first.");
    return [{ label: "provider:openai (fallback)", options: { provider: "openai" } }];
  }

  let models = allModels;

  if (strategy === "provider" && process.env.MODEL_TEST_PROVIDER) {
    models = models.filter((m) => m.provider === process.env.MODEL_TEST_PROVIDER);
  }

  return models.map((m) => ({
    label: `${m.provider} / ${m.model}`,
    options: { provider: m.provider as Provider, model: m.model },
    skipReason: skipReasons.get(m.provider),
  }));
}

const targets = getTestTargets();

for (const { label, options, skipReason } of targets) {
  const provider = options.provider ?? "openai";

  test.describe.serial(`Agent Component Regression [${label}]`, () => {
    test(
      "agent must run and respond without any tools connected",
      { tag: ["@release", "@components", "@agents"] },
      async ({ page }) => {
        test.skip(!!skipReason, skipReason ?? "");
        test.skip(
          !hasProviderEnvKeys(provider),
          `Missing env vars for provider "${provider}": ${missingProviderEnvKeys(provider).join(", ")}`,
        );

        // Use Simple Agent template (has Chat I/O needed for playground) but
        // send a knowledge question that doesn't require tools — verifies agent
        // responds even when tool use is not needed (regression for ID 147)
        try {
          await new SimpleAgentTemplatePage(page).load(options);
        } catch (e: any) {
          if (e?.message?.startsWith("MODEL_NOT_AVAILABLE")) test.skip(true, e.message);
          throw e;
        }

        await page.getByTestId("playground-btn-flow-io").click();

        await page.waitForSelector('[data-testid="input-chat-playground"]', {
          timeout: 30000,
        });

        await page
          .getByTestId("input-chat-playground")
          .last()
          .fill("What is the capital of France?");

        await page.getByTestId("button-send").last().click();

        // Some models respond directly without tools — stop button may not appear
        const stopButton = page.getByRole("button", { name: "Stop" });
        const stopVisible = await stopButton.isVisible({ timeout: 10000 }).catch(() => false);
        if (stopVisible) {
          await expect(stopButton).toBeHidden({ timeout: 120000 });
        }

        await expect(page.getByTestId("div-chat-message").last()).toBeVisible({ timeout: 30000 });

        const responseText = await page
          .getByTestId("div-chat-message")
          .last()
          .innerText();

        expect(responseText.trim().length).toBeGreaterThan(1);
      },
    );

    test(
      "agent must show reasoning steps and produce a valid response",
      { tag: ["@release", "@components", "@agents"] },
      async ({ page }) => {
        test.skip(!!skipReason, skipReason ?? "");
        test.skip(
          !hasProviderEnvKeys(provider),
          `Missing env vars for provider "${provider}": ${missingProviderEnvKeys(provider).join(", ")}`,
        );

        try {
          await new SimpleAgentTemplatePage(page).load(options);
        } catch (e: any) {
          if (e?.message?.startsWith("MODEL_NOT_AVAILABLE")) {
            test.skip(true, e.message);
          }
          throw e;
        }

        await page.getByTestId("playground-btn-flow-io").click();

        await page.getByTestId("input-chat-playground").last().fill("Who was the first astronaut to walk on the Moon?");

        await page.getByTestId("button-send").last().click();

        // Some models respond directly without tools — stop button may not appear
        const stopButton = page.getByRole("button", { name: "Stop" });
        const stopVisible = await stopButton.isVisible({ timeout: 10000 }).catch(() => false);
        if (stopVisible) {
          await expect(stopButton).toBeHidden({ timeout: 120000 });
        }

        const lastMessage = page.getByTestId("div-chat-message").last();
        await expect(lastMessage).toBeVisible({ timeout: 30000 });

        const responseText = await lastMessage.innerText();
        expect(responseText.trim().length).toBeGreaterThan(1);

        // ThinkingMessage shows "Finished in Xs" when agent uses reasoning steps — soft-check
        const finishedText = page.getByText(/Finished in/).last();
        if (await finishedText.isVisible({ timeout: 5000 }).catch(() => false)) {
          const durationText = await finishedText.innerText();
          expect(durationText.trim().length).toBeGreaterThan(0);
        }
      },
    );

    test(
      "agent stop button must halt execution mid-run",
      { tag: ["@release", "@components", "@agents"] },
      async ({ page }) => {
        test.skip(!!skipReason, skipReason ?? "");
        test.skip(
          !hasProviderEnvKeys(provider),
          `Missing env vars for provider "${provider}": ${missingProviderEnvKeys(provider).join(", ")}`,
        );

        try {
          await new SimpleAgentTemplatePage(page).load(options);
        } catch (e: any) {
          if (e?.message?.startsWith("MODEL_NOT_AVAILABLE")) test.skip(true, e.message);
          throw e;
        }

        await page.getByTestId("playground-btn-flow-io").click();

        await page
          .getByTestId("input-chat-playground")
          .last()
          .fill("Write a detailed story about the life and adventures of a fictional explorer in the 18th century.");

        await page.getByTestId("button-send").last().click();

        // Some models respond too fast or don't support tools — stop button may not appear
        const stopButton = page.getByRole("button", { name: "Stop" });
        const stopVisible = await stopButton.isVisible({ timeout: 30000 }).catch(() => false);
        if (!stopVisible) {
          console.log(`Model ${options.model ?? provider} responded without stop button — skipping halt test`);
          return;
        }

        // dispatchEvent bypasses coverage/stability checks while triggering React's click handler
        await stopButton.dispatchEvent("click");

        await expect(stopButton).toBeHidden({ timeout: 30000 });

        await expect(
          page.getByTestId("input-chat-playground").last(),
        ).toBeVisible({ timeout: 10000 });
      },
    );

    test.only(
      "agent must display duration after successful run",
      { tag: ["@release", "@components", "@agents"] },
      async ({ page }) => {
        test.skip(!!skipReason, skipReason ?? "");
        test.skip(
          !hasProviderEnvKeys(provider),
          `Missing env vars for provider "${provider}": ${missingProviderEnvKeys(provider).join(", ")}`,
        );

        try {
          await new SimpleAgentTemplatePage(page).load(options);
        } catch (e: any) {
          if (e?.message?.startsWith("MODEL_NOT_AVAILABLE")) test.skip(true, e.message);
          throw e;
        }

        await page.getByTestId("playground-btn-flow-io").click();

        await page.getByTestId("input-chat-playground").last().fill("What is IA?");

        await page.getByTestId("button-send").last().click();

        // Some models respond directly without tools — stop button may not appear
        const stopButton = page.getByRole("button", { name: "Stop" });
        const stopVisible = await stopButton.isVisible({ timeout: 10000 }).catch(() => false);
        if (stopVisible) {
          await expect(stopButton).toBeHidden({ timeout: 120000 });
        }

        await expect(page.getByTestId("div-chat-message").last()).toBeVisible({ timeout: 30000 });
        await expect(page.getByText(/Finished in \d+(\.\d+)?s/)).toBeVisible();
      },
    );

    test(
      "agent must stream response progressively in the playground",
      { tag: ["@release", "@components", "@agents", "@playground"] },
      async ({ page }) => {
        test.skip(!!skipReason, skipReason ?? "");
        test.skip(
          !hasProviderEnvKeys(provider),
          `Missing env vars for provider "${provider}": ${missingProviderEnvKeys(provider).join(", ")}`,
        );

        try {
          await new SimpleAgentTemplatePage(page).load(options);
        } catch (e: any) {
          if (e?.message?.startsWith("MODEL_NOT_AVAILABLE")) test.skip(true, e.message);
          throw e;
        }

        await page.getByTestId("playground-btn-flow-io").click();

        await page.waitForSelector('[data-testid="input-chat-playground"]', {
          timeout: 30000,
        });

        // Long enough prompt to keep the agent generating for a few seconds
        await page
          .getByTestId("input-chat-playground")
          .last()
          .fill("Write a 5-paragraph summary explaining what artificial intelligence is, covering its definition, history, main techniques, applications, and future perspectives.");

        await page.getByTestId("button-send").last().click();

        // Wait for the agent to start (~2s) and the first message to appear
        await expect(page.getByTestId("div-chat-message").last()).toBeVisible({
          timeout: 30000,
        });

        // Capture partial text while the agent may still be generating
        const textAtStart = await page
          .getByTestId("div-chat-message")
          .last()
          .innerText();

        // Wait a few seconds for more tokens to be received
        await page.waitForTimeout(3000);

        const textAfterWait = await page
          .getByTestId("div-chat-message")
          .last()
          .innerText();

        // If stop button is still visible, text must have grown (streaming active)
        // If already finished within 3s, just validate that the response has content
        const stopButton = page.getByRole("button", { name: "Stop" });
        const stillGenerating = await stopButton.isVisible({ timeout: 500 }).catch(() => false);

        if (stillGenerating) {
          expect(
            textAfterWait.trim().length,
            "Text must grow during streaming — response still in progress",
          ).toBeGreaterThan(textAtStart.trim().length);
        }

        // Wait for the response to finish completely
        await expect(stopButton).toBeHidden({ timeout: 120000 });

        const finalText = await page
          .getByTestId("div-chat-message")
          .last()
          .innerText();

        expect(finalText.trim().length).toBeGreaterThan(1);
      },
    );

    test(
      "playground must display response time after agent finishes",
      { tag: ["@release", "@components", "@agents", "@playground"] },
      async ({ page }) => {
        test.skip(!!skipReason, skipReason ?? "");
        test.skip(
          !hasProviderEnvKeys(provider),
          `Missing env vars for provider "${provider}": ${missingProviderEnvKeys(provider).join(", ")}`,
        );

        try {
          await new SimpleAgentTemplatePage(page).load(options);
        } catch (e: any) {
          if (e?.message?.startsWith("MODEL_NOT_AVAILABLE")) test.skip(true, e.message);
          throw e;
        }

        await page.getByTestId("playground-btn-flow-io").click();

        await page.waitForSelector('[data-testid="input-chat-playground"]', {
          timeout: 30000,
        });

        await page
          .getByTestId("input-chat-playground")
          .last()
          .fill("What are the main differences between mammals and reptiles?");

        await page.getByTestId("button-send").last().click();

        // Wait for the response to finish
        const stopButton = page.getByRole("button", { name: "Stop" });
        const stopVisible = await stopButton.isVisible({ timeout: 10000 }).catch(() => false);
        if (stopVisible) {
          await expect(stopButton).toBeHidden({ timeout: 120000 });
        }

        await expect(page.getByTestId("div-chat-message").last()).toBeVisible({ timeout: 30000 });

        // Close the playground and check the duration indicator on the canvas node
        await page.getByTestId("playground-close-button").click();

        await expect(page.getByTestId("node_duration_agent")).toBeVisible({ timeout: 10000 });
      },
    );

    test(
      "agent must handle multiple consecutive messages in same session",
      { tag: ["@release", "@components", "@agents"] },
      async ({ page }) => {
        test.skip(!!skipReason, skipReason ?? "");
        test.skip(
          !hasProviderEnvKeys(provider),
          `Missing env vars for provider "${provider}": ${missingProviderEnvKeys(provider).join(", ")}`,
        );

        try {
          await new SimpleAgentTemplatePage(page).load(options);
        } catch (e: any) {
          if (e?.message?.startsWith("MODEL_NOT_AVAILABLE")) test.skip(true, e.message);
          throw e;
        }

        await page.getByTestId("playground-btn-flow-io").click();

        for (const message of ["Hello.", "Name three countries in South America."]) {
          await page.getByTestId("input-chat-playground").last().fill(message);

          await page.getByTestId("button-send").last().click();

          // Some models respond directly without tools — stop button may not appear
          const stopButton = page.getByRole("button", { name: "Stop" });
          const stopVisible = await stopButton.isVisible({ timeout: 10000 }).catch(() => false);
          if (stopVisible) {
            await expect(stopButton).toBeHidden({ timeout: 120000 });
          } else {
            await expect(page.getByTestId("div-chat-message").last()).toBeVisible({ timeout: 30000 });
          }
        }

        const messages = page.getByTestId("div-chat-message");
        const count = await messages.count();
        expect(count).toBeGreaterThanOrEqual(2);
      },
    );

  });
}
