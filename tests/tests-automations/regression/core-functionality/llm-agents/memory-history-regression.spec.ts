import * as dotenv from "dotenv";
import path from "path";
import type { Page } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { adjustScreenView } from "../../../../helpers/ui/adjust-screen-view";
import { updateOldComponents } from "../../../../helpers/flows/update-old-components";
import { loadTemplateByName } from "../../../../helpers/flows/load-template-by-name";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import { PlaygroundPage } from "../../../../pages";
import {
  setupLanguageModelOpenAI,
  setAgentModelViaApi,
} from "../../../../helpers/provider-setup/setup-language-model-openai";
import { providerSkipGate } from "../../../../helpers/provider-setup/provider-health";

if (!process.env.CI) {
  dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });
}

async function loadMemoryChatbot(page: Page): Promise<string> {
  const flowId = await loadTemplateByName(page, "Memory Chatbot");

  // Only one adjustScreenView is needed here, and only *after* the update. Each
  // adjustScreenView waits up to 30s on `canvas_controls_dropdown`, which is the
  // exact render race that flakes this heavy test under CI contention (#569) — so
  // we keep that exposure to the minimum this test actually requires:
  //  - loadTemplateByName already confirmed the canvas rendered, so a pre-update
  //    fit adds no signal;
  //  - updateOldComponents only clicks the global `update-all-button` toolbar
  //    action — it does not touch a node, so it needs no fitted view (unlike the
  //    adjustScreenView×2 sandwich in specs that edit a node between the two).
  // The single fit below is functionally required: it brings the Agent node into
  // the viewport so setupLanguageModelOpenAI can click its provider/model widgets.
  await updateOldComponents(page);
  await adjustScreenView(page);

  return flowId;
}

// Configures the provider (UI) and pins the Agent's executable model to a cheap chat
// model (API), then opens the Playground. The model pin is why this goes through the
// API: the Agent template defaults `model` to `gpt-5.5-pro` and the in-canvas widget
// does not persist a UI selection to the executed graph, so without this the flow runs
// gpt-5.5-pro (rejected by keys without access; slow reasoning model — issue #569).
// The reload makes the frontend/playground build pick up the patched model.
async function openConfiguredPlayground(page: Page, flowId: string): Promise<PlaygroundPage> {
  await setupLanguageModelOpenAI(page);
  await setAgentModelViaApi(page, flowId);
  await page.reload();

  const playground = new PlaygroundPage(page);
  await playground.waitForLoad();
  await page.getByTestId("playground-btn-flow-io").click();
  await page.waitForSelector('[data-testid="input-chat-playground"]', { timeout: 30000 });
  return playground;
}

// Waits until `expectedResponses` bot responses have *fully completed*.
//
// Two gates, in order:
//  1. `div-chat-message` reaches the expected count — the bot bubble mounts when the
//     turn begins, so this confirms the new turn actually started before we look at
//     the generating indicator (guards the "checked completion before generation
//     started" race that made the old stop-button wait return early — issue #354).
//  2. The generating indicator clears: `button-stop` hidden and `button-send` back.
//     This is the completion signal because it is *model-agnostic*. The previous
//     signal — counting `chat-message-token-usage` badges — was the root cause of the
//     #569 flake: not every model/response emits the badge, so the count could sit
//     below the expected value for the full 120s even though the response had already
//     rendered. The 120s budget covers live LLM latency.
async function waitForChatResponse(page: Page, expectedResponses: number): Promise<void> {
  await expect(page.getByTestId("div-chat-message")).toHaveCount(expectedResponses, {
    timeout: 120000,
  });
  await expect(page.getByTestId("button-stop")).toBeHidden({ timeout: 120000 });
  await expect(page.getByTestId("button-send")).toBeVisible({ timeout: 10000 });
}

test.describe("Memory Chatbot Regression", () => {
  let createdFlowId: string | null = null;

  // Delete only the flow this test created (by id) — a broad cleanup here
  // would kill parallel workers' in-flight flows (#553).
  test.afterEach(async ({ page }) => {
    if (createdFlowId) {
      // Navigate home first so the flow editor / open playground stops polling
      // this flow's /events endpoint; otherwise the delete below races those
      // in-flight requests, which then 404 ("Flow not found") as teardown noise.
      await page.goto("/").catch(() => {});
      // `deleteFlow` rather than a raw DELETE: it absorbs 404-as-done and one
      // transient 5xx, surfaces a real failure instead of silence, and -- the
      // reason this spec was migrated -- it is where token attribution happens,
      // immediately before the DELETE that 404s the trace (§3.1).
      try {
        await deleteFlow(page.request, createdFlowId);
      } catch {
        // Deliberately silent, matching the `.catch(() => {})` this replaces.
      }
      createdFlowId = null;
    }
  });

  test(
    "memory chatbot template loads with correct node structure",
    { tag: ["@stable", "@release", "@agents", "@playground"] },
    async ({ page }) => {
      createdFlowId = await loadMemoryChatbot(page);

      // Template redesigned upstream (1.11.0.dev34): Agent + Memory Base
      // replaced the Message History / Language Model / Prompt Template trio
      // (issue #550; verified in the shipped starter-project JSON).
      await test.step("canvas has all 5 required nodes", async () => {
        await expect.soft(page.getByTestId("title-Chat Input")).toBeVisible({ timeout: 10000 });
        await expect.soft(page.getByTestId("title-Chat Output")).toBeVisible({ timeout: 10000 });
        await expect.soft(page.getByTestId("title-Agent")).toBeVisible({ timeout: 10000 });
        await expect.soft(page.getByTestId("title-Memory Base")).toBeVisible({ timeout: 10000 });
        await expect.soft(page.getByTestId("note_node")).toBeVisible({ timeout: 10000 });
      });

      await test.step("canvas has exactly 5 nodes", async () => {
        const nodeCount = await page.locator(".react-flow__node").count();
        expect.soft(nodeCount).toBe(5);
      });
    },
  );

  test(
    "message history context retention suite",
    { tag: ["@stable", "@release", "@agents", "@playground"] },
    async ({ page }) => {
      // Real OpenAI completions drive the whole suite, so gate on provider
      // HEALTH, not on the env var alone — a drained key would block the backend
      // past gunicorn's 300s timeout and kill the shard's worker (#1029).
      const gate = providerSkipGate("openai");
      test.skip(gate.skip, gate.reason);

      createdFlowId = await loadMemoryChatbot(page);
      const playground = await openConfiguredPlayground(page, createdFlowId);

      await test.step("message history retains context within same session", async () => {
        await playground.sendMessage("My name is Alice. Please confirm you received my name.");
        await waitForChatResponse(page, 1);

        await playground.sendMessage("What is my name?");
        await waitForChatResponse(page, 2);

        const response = await page.getByTestId("div-chat-message").last().innerText();
        expect.soft(response).toMatch(/Alice/i);
      });

      await test.step("multiple consecutive messages accumulate in history", async () => {
        await expect
          .poll(() => page.getByTestId("div-chat-message").count(), { timeout: 10000 })
          .toBeGreaterThanOrEqual(2);
      });

      await test.step("messages persist after closing and reopening playground", async () => {
        const messagesBefore = await page.getByTestId("div-chat-message").count();

        await page.getByTestId("playground-close-button").click();
        await expect(page.getByTestId("input-chat-playground")).toBeHidden({ timeout: 10000 });

        await page.getByTestId("playground-btn-flow-io").click();
        await expect(page.getByTestId("input-chat-playground")).toBeVisible({ timeout: 30000 });

        // History reloads asynchronously on reopen; web-first wait for it to restore.
        await expect.soft(page.getByTestId("div-chat-message")).toHaveCount(messagesBefore, {
          timeout: 30000,
        });
      });
    },
  );

  test(
    "session isolation: new session has no context from previous session",
    { tag: ["@stable", "@release", "@agents", "@playground"] },
    async ({ page }) => {
      // Real OpenAI completions drive the whole suite, so gate on provider
      // HEALTH, not on the env var alone — a drained key would block the backend
      // past gunicorn's 300s timeout and kill the shard's worker (#1029).
      const gate = providerSkipGate("openai");
      test.skip(gate.skip, gate.reason);

      createdFlowId = await loadMemoryChatbot(page);
      const playground = await openConfiguredPlayground(page, createdFlowId);

      await playground.sendMessage("My name is Bob. Please confirm you received my name.");
      await waitForChatResponse(page, 1);

      // "new-chat" button is in the sessions sidebar (data-testid="new-chat")
      await page.getByTestId("new-chat").click();

      // Web-first: a fresh session must contain zero bot messages. toHaveCount(0)
      // auto-retries until the session reset settles, so a reset slower than a
      // fixed wait no longer false-fails (replaces waitForTimeout(500) + a hard
      // count assertion — issue #354 secondary latent risk).
      await expect(page.getByTestId("div-chat-message")).toHaveCount(0, {
        timeout: 10000,
      });

      // Backend-isolation probe: the UI-reset check above would still pass if
      // the backend leaked memory across sessions — only a model answer proves
      // the new session's context is really empty. A leak surfaces "Bob" and
      // fails; a model that answers "I don't know your name" passes.
      await playground.sendMessage("What is my name?");
      await waitForChatResponse(page, 1);
      const response = (await page.getByTestId("div-chat-message").last().innerText()).trim();
      // Require a real answer first: an empty/errored response (e.g. a reasoning model
      // that returns no content) would pass `not.toMatch(/Bob/)` vacuously and mask a
      // broken run as a green isolation result.
      expect(response.length).toBeGreaterThan(0);
      expect(response).not.toMatch(/Bob/i);
    },
  );
});
