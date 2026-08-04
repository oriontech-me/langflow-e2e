import * as dotenv from "dotenv";
import path from "path";
import type { Page } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { SimpleAgentTemplatePage, type LoadSimpleAgentOptions } from "../../../../pages";
import { waitForFlowSaveSettled } from "../../../../helpers/flows/wait-for-flow-save-settled";
import {
  closeAdvancedOptions,
  openAdvancedOptions,
} from "../../../../helpers/ui/open-advanced-options";
import {
  hasProviderEnvKeys,
  missingProviderEnvKeys,
  providerConfigMap,
  type Provider,
} from "../../../../helpers/provider-setup";
import { resolveTestTargets } from "../../../../helpers/provider-setup/test-targets";

/**
 * Agent Max Iterations (QA-CHECKLIST §6.2 "Agent stops when maximum number of
 * iterations is reached" and §7.7 "Maximum agent iterations").
 *
 *   Test 1 — max_iterations=1 on a task that makes the agent attempt a tool call:
 *            the attempt exceeds the limit and the agent returns
 *            "Model call limits exceeded: run limit (1/1)".
 *   Test 2 — causal control: the SAME task with a high max_iterations finishes
 *            WITHOUT the limit message — only the cap differs, so Test 1's stop
 *            is attributable to the cap, not an unrelated failure.
 *
 * Issue #481 flagged a backend bug (parameter ignored) and asked to gate this
 * expected-fail. Reproduction on 1.11.0.dev33 shows the parameter is RESPECTED
 * (1 → run limit (1/1); high → finishes), so this is a normal passing @stable test.
 */

if (!process.env.CI) {
  dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });
}

// Force a real tool-calling loop with data the model CANNOT fabricate, so it must
// call the URL tool — guaranteeing more than one model call, so a limit of 1 is
// genuinely exceeded. The target is the running instance's own version endpoint:
// the model cannot know the exact nightly version, so it always attempts the
// fetch (unlike a famous page like example.com, whose contents it has memorised,
// or an arithmetic task it computes inline). The fetch itself is SSRF-blocked
// backend-side, but that is irrelevant — the *attempt* consumes the iteration,
// which is what proves the cap. See the spec doc for the full rationale.
const TARGET_URL = "http://localhost:7860/api/v1/version";
const SYSTEM_PROMPT =
  "You have web tools. To answer any question about a URL you MUST call the URL fetch tool. Never guess or invent responses.";
const TASK = `Fetch ${TARGET_URL} and tell me the exact "version" value it returns.`;
const LIMIT_MESSAGE = /model call limits exceeded/i;
const HIGH_LIMIT = "20";

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

// Set the Agent Instructions (system prompt) on the node.
async function setSystemPrompt(page: Page, prompt: string): Promise<void> {
  const field = page.getByTestId("textarea_str_system_prompt");
  await expect(field).toBeVisible({ timeout: 15000 });
  await field.click();
  await field.fill(prompt);
  await field.blur();
}

// Open the Agent Controls dialog, set max_iterations, and close. The template's
// URL tool (default) is the forcer — no extra tool needs enabling.
async function setMaxIterations(page: Page, maxIterations: string): Promise<void> {
  // dev49: max_iterations is an advanced field — expose it on the node body via
  // the inspector (replaces the old Controls dialog / edit-button-modal), then
  // fill it on the body.
  await page.locator('[data-testid^="rf__node-Agent"]').first().click();
  await openAdvancedOptions(page);
  await page.getByTestId("inspector-add-max_iterations").click();
  await closeAdvancedOptions(page);
  const maxIter = page.getByTestId("int_int_max_iterations");
  await expect(maxIter).toBeVisible({ timeout: 15000 });
  await maxIter.scrollIntoViewIfNeeded();
  await maxIter.fill(maxIterations);
  await maxIter.blur();
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

// Run the configured flow through the Playground and return the AI message
// bubble locator. Callers assert with toContainText (auto-retrying) — reading
// innerText once can catch a partially-streamed message right after the run ends.
async function runAndGetBubble(page: Page) {
  await page.getByTestId("playground-btn-flow-io").click();
  const chatInput = page.getByTestId("input-chat-playground").last();
  await expect(chatInput).toBeVisible({ timeout: 30000 });
  await expect(chatInput).toHaveValue(TASK, { timeout: 15000 });
  await page.getByTestId("button-send").last().click();
  await waitForAgentToFinish(page);
  const bubble = page.getByTestId("div-chat-message").last();
  await expect(bubble).toBeVisible({ timeout: 30000 });
  return bubble;
}

const targets = resolveTestTargets({ tier: "tool-calling" });

// SimpleAgentTemplatePage.load() deletes all flows before loading the template;
// serial mode + --workers=1 keeps the shared instance state deterministic.
test.describe.configure({ mode: "serial" });

for (const { label, options, skipReason } of targets) {
  const provider = options.provider ?? (Object.keys(providerConfigMap)[0] as Provider);

  test.describe(`Agent Max Iterations [${label}]`, () => {
    test(
      "agent stops when max iterations is reached",
      { tag: ["@regression", "@agents", "@playground"] },
      async ({ page }) => {
        test.skip(!!skipReason, skipReason ?? "");
        test.skip(
          !hasProviderEnvKeys(provider),
          `Missing env vars for provider "${provider}": ${missingProviderEnvKeys(provider).join(", ")}`,
        );

        await loadAgent(page, options);

        await test.step("force a tool call, cap max_iterations at 1, set the task", async () => {
          await setSystemPrompt(page, SYSTEM_PROMPT);
          await setMaxIterations(page, "1");
          await setChatInputText(page, TASK);
          await waitForFlowSaveSettled(page);
        });

        await test.step("run and assert the agent stops at the limit", async () => {
          const bubble = await runAndGetBubble(page);
          // Limit enforced: the agent stopped at the configured cap of 1.
          await expect(bubble).toContainText(LIMIT_MESSAGE, { timeout: 30000 });
          // run limit (1/1) ties the stop to max_iterations=1.
          await expect(bubble).toContainText(/\(\s*1\s*\/\s*1\s*\)/, { timeout: 10000 });
        });
      },
    );

    test(
      "causal control — a high max iterations does not hit the limit",
      { tag: ["@stable", "@regression", "@agents", "@playground"] },
      async ({ page }) => {
        test.skip(!!skipReason, skipReason ?? "");
        test.skip(
          !hasProviderEnvKeys(provider),
          `Missing env vars for provider "${provider}": ${missingProviderEnvKeys(provider).join(", ")}`,
        );

        await loadAgent(page, options);

        await test.step("force a tool call, allow a high max_iterations, set the task", async () => {
          await setSystemPrompt(page, SYSTEM_PROMPT);
          await setMaxIterations(page, HIGH_LIMIT);
          await setChatInputText(page, TASK);
          await waitForFlowSaveSettled(page);
        });

        await test.step("run and assert the run finishes without hitting the limit", async () => {
          const bubble = await runAndGetBubble(page);
          const reply = (await bubble.innerText()).trim();
          // Same task as Test 1, but with headroom to iterate: the agent finishes
          // (a few attempts, well under the high limit) WITHOUT the limit message.
          // Only max_iterations differs between the two tests — so the stop in
          // Test 1 is attributable to the cap, not an unrelated failure.
          expect(reply.length).toBeGreaterThan(0);
          expect(reply).not.toMatch(LIMIT_MESSAGE);
        });
      },
    );
  });
}
