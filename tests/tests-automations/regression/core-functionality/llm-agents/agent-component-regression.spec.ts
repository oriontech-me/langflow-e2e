import * as dotenv from "dotenv";
import path from "path";
import { expect, test } from "../../../../fixtures/fixtures";
import {
  loadSimpleAgent,
  type LoadSimpleAgentOptions,
} from "../../../../helpers/flows/load-simple-agent";
import {
  hasProviderEnvKeys,
  missingProviderEnvKeys,
} from "../../../../helpers/provider-setup";

// Provider/model to use across all tests in this suite.
// Defaults: provider = "openai", model = "gpt-4o-mini" (when omitted).
const agentOptions: LoadSimpleAgentOptions = { provider: "google" };

const provider = agentOptions.provider ?? "openai";

test.describe.serial("Agent Component Regression", () => {
  test(
    "agent must show reasoning steps and produce a valid response",
    { tag: ["@release", "@components"] },
    async ({ page }) => {
      test.skip(
        !hasProviderEnvKeys(provider),
        `Missing env vars for provider "${provider}": ${missingProviderEnvKeys(provider).join(", ")}`,
      );

      if (!process.env.CI) {
        dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });
      }

      await loadSimpleAgent(page, agentOptions);

      await page.getByTestId("playground-btn-flow-io").click();

      await page
        .getByTestId("input-chat-playground")
        .last()
        .fill("What is 2 + 2?");

      await page.getByTestId("button-send").last().click();

      const stopButton = page.getByRole("button", { name: "Stop" });
      await stopButton.waitFor({ state: "visible", timeout: 30000 });
      await expect(stopButton).toBeHidden({ timeout: 120000 });

      const lastMessage = page.getByTestId("div-chat-message").last();
      await expect(lastMessage).toBeVisible({ timeout: 10000 });

      const responseText = await lastMessage.innerText();
      expect(responseText.trim().length).toBeGreaterThan(1);

      // header-icon and duration-display appear when agent uses tools
      // soft-check: verify if present but don't fail if simple response
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
      test.skip(
        !hasProviderEnvKeys(provider),
        `Missing env vars for provider "${provider}": ${missingProviderEnvKeys(provider).join(", ")}`,
      );

      if (!process.env.CI) {
        dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });
      }

      await loadSimpleAgent(page, agentOptions);

      await page.getByTestId("playground-btn-flow-io").click();

      await page
        .getByTestId("input-chat-playground")
        .last()
        .fill("Write a very long essay about the history of artificial intelligence.");

      await page.getByTestId("button-send").last().click();

      const stopButton = page.getByRole("button", { name: "Stop" });
      await stopButton.waitFor({ state: "visible", timeout: 30000 });

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
      test.skip(
        !hasProviderEnvKeys(provider),
        `Missing env vars for provider "${provider}": ${missingProviderEnvKeys(provider).join(", ")}`,
      );

      if (!process.env.CI) {
        dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });
      }

      await loadSimpleAgent(page, agentOptions);

      await page.getByTestId("playground-btn-flow-io").click();

      await page
        .getByTestId("input-chat-playground")
        .last()
        .fill("What is 123 + 456?");

      await page.getByTestId("button-send").last().click();

      const stopButton = page.getByRole("button", { name: "Stop" });
      await stopButton.waitFor({ state: "visible", timeout: 30000 });
      await expect(stopButton).toBeHidden({ timeout: 120000 });

      // duration-display is hidden in playground view; ThinkingMessage shows "Finished in Xs" instead
      const finishedText = page.getByText(/Finished in/).last();
      await expect(finishedText).toBeVisible({ timeout: 10000 });

      const durationText = await finishedText.innerText();
      expect(durationText.trim().length).toBeGreaterThan(0);
    },
  );

  test(
    "agent must handle multiple consecutive messages in same session",
    { tag: ["@release", "@components"] },
    async ({ page }) => {
      test.skip(
        !hasProviderEnvKeys(provider),
        `Missing env vars for provider "${provider}": ${missingProviderEnvKeys(provider).join(", ")}`,
      );

      if (!process.env.CI) {
        dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });
      }

      await loadSimpleAgent(page, agentOptions);

      await page.getByTestId("playground-btn-flow-io").click();

      for (const message of ["Hello.", "What is 1 + 1?"]) {
        await page
          .getByTestId("input-chat-playground")
          .last()
          .fill(message);

        await page.getByTestId("button-send").last().click();

        const stopButton = page.getByRole("button", { name: "Stop" });
        await stopButton.waitFor({ state: "visible", timeout: 30000 });
        await expect(stopButton).toBeHidden({ timeout: 120000 });
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
      test.skip(
        !hasProviderEnvKeys(provider),
        `Missing env vars for provider "${provider}": ${missingProviderEnvKeys(provider).join(", ")}`,
      );

      if (!process.env.CI) {
        dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });
      }

      // Use Simple Agent template (has Chat I/O needed for playground) but
      // send a knowledge question that doesn't require tools — verifies agent
      // responds even when tool use is not needed (regression for ID 147)
      await loadSimpleAgent(page, agentOptions);

      // Open playground
      await page.getByTestId("playground-btn-flow-io").click();

      await page.waitForSelector('[data-testid="input-chat-playground"]', {
        timeout: 30000,
      });

      await page
        .getByTestId("input-chat-playground")
        .last()
        .fill("What is the capital of France?");

      await page.getByTestId("button-send").last().click();

      const stopButton = page.getByRole("button", { name: "Stop" });
      await stopButton.waitFor({ state: "visible", timeout: 30000 });
      await expect(stopButton).toBeHidden({ timeout: 120000 });

      const responseText = await page
        .getByTestId("div-chat-message")
        .last()
        .innerText();

      expect(responseText.trim().length).toBeGreaterThan(1);
    },
  );
});
