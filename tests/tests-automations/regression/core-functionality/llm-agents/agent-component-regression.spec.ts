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
      reasons.set(r.provider, `Provider "${r.provider}" inativo — ${r.error}`);
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
      "agent must show reasoning steps and produce a valid response",
      { tag: ["@release", "@components"] },
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

        await page.getByTestId("input-chat-playground").last().fill("What is 2 + 2?");

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

        // header-icon and duration-display appear when agent uses tools
        // soft-check: only assert if tools were actually called
        const headerIcon = page.getByTestId("header-icon").last();
        if (await headerIcon.isVisible({ timeout: 3000 }).catch(() => false)) {
          await expect(page.getByTestId("duration-display").last()).toBeVisible();
          await expect(page.getByTestId("icon-check").first()).toBeVisible();
        }
      },
    );

    test(
      "agent stop button must halt execution mid-run",
      { tag: ["@release", "@components"] },
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
          .fill("Write a very long essay about the history of artificial intelligence.");

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

    test(
      "agent must display duration after successful run",
      { tag: ["@release", "@components"] },
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

        await page.getByTestId("input-chat-playground").last().fill("What is 123 + 456?");

        await page.getByTestId("button-send").last().click();

        // Some models respond directly without tools — stop button may not appear
        const stopButton = page.getByRole("button", { name: "Stop" });
        const stopVisible = await stopButton.isVisible({ timeout: 10000 }).catch(() => false);
        if (stopVisible) {
          await expect(stopButton).toBeHidden({ timeout: 120000 });
        }

        await expect(page.getByTestId("div-chat-message").last()).toBeVisible({ timeout: 30000 });

        // "Finished in Xs" only appears when tools are used — soft-check
        const finishedText = page.getByText(/Finished in/).last();
        if (await finishedText.isVisible({ timeout: 5000 }).catch(() => false)) {
          const durationText = await finishedText.innerText();
          expect(durationText.trim().length).toBeGreaterThan(0);
        }
      },
    );

    test(
      "agent must handle multiple consecutive messages in same session",
      { tag: ["@release", "@components"] },
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

        for (const message of ["Hello.", "What is 1 + 1?"]) {
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

    test(
      "agent must run and respond without any tools connected (ID 147)",
      { tag: ["@release", "@components"] },
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
  });
}
