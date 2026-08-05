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
import {
  hasProviderEnvKeys,
  missingProviderEnvKeys,
  providerConfigMap,
  providerSetupMap,
  type Provider,
} from "../../../../helpers/provider-setup";
import { resolveTestTargets } from "../../../../helpers/provider-setup/test-targets";

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

  return openPlayground(page);
}

/**
 * The same Playground open, for a target resolved by `resolveTestTargets` (#1251).
 *
 * Two things differ from the hosted path above, and only for providers other than
 * OpenAI. `setupLanguageModelOpenAI` is replaced by the shared `providerSetupMap`
 * dispatch, which reaches this template's Agent node through the same unified
 * `ModelInput` surface (`model_model` / "Setup Provider" / `manage-model-providers`) —
 * measured on 1.12.0.dev17, no separate keyless helper is required.
 *
 * And `setAgentModelViaApi` is NOT called. That pin exists because the template
 * defaults `model` to `gpt-5.5-pro` and a UI selection does not always reach the
 * executed graph; on the routed path the selection does persist (measured:
 * `model.value=[{name:"qwen2.5:0.5b", provider:"Ollama"}]`). Pinning here would mean
 * re-implementing its OpenAI-specific non-reasoning resolution for every provider. So
 * the persisted name is ASSERTED instead — a selection that silently dropped back to
 * the workspace default must fail loudly rather than run an unrequested model, which
 * is the #596/#491 failure class this suite keeps re-learning.
 */
async function openRoutedPlayground(
  page: Page,
  flowId: string,
  provider: Provider,
  model?: string,
): Promise<PlaygroundPage> {
  // A target that the running build does not offer is a SKIP, not a failure — the
  // area convention every parametrized agent spec follows. Measured: resolving
  // google's whole catalog yields image/live/omni entries that no dropdown lists, and
  // without this they surfaced as 23 red "failures" that said nothing about the flow.
  try {
    await providerSetupMap[provider](page, model);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("MODEL_NOT_AVAILABLE")) test.skip(true, message);
    throw error;
  }

  if (provider === "openai") {
    await setAgentModelViaApi(page, flowId);
  } else {
    await expectPersistedAgentModel(page, flowId, model);
  }
  await page.reload();

  return openPlayground(page);
}

/** What the Agent node carries as its EXECUTABLE model, straight from the persisted flow. */
async function expectPersistedAgentModel(
  page: Page,
  flowId: string,
  model?: string,
): Promise<void> {
  if (!model) return;

  // The autosave is debounced, so poll rather than sampling once: the selection is
  // persisted by `PATCH /api/v1/flows/{id}` after the click, and reading before it
  // lands would report the template default as a dropped selection.
  await expect
    .poll(
      async () => {
        // A read that fails is "not settled yet", never the end of the poll: under load
        // this GET has timed out at the request context's own 20 s (measured on a host
        // at load 63), and letting that escape would abort the poll with a transport
        // error instead of retrying — reporting an infrastructure hiccup as a dropped
        // model selection.
        try {
          const response = await page.request.get(`/api/v1/flows/${flowId}`, { timeout: 10000 });
          const flow = await response.json();
          const agent = (flow?.data?.nodes ?? []).find(
            (node: { data?: { type?: string } }) => node?.data?.type === "Agent",
          );
          const value = agent?.data?.node?.template?.model?.value;
          const entries = Array.isArray(value) ? value : [value];
          return entries
            .map((entry: unknown) =>
              typeof entry === "string" ? entry : ((entry as { name?: string } | null)?.name ?? ""),
            )
            .filter(Boolean);
        } catch {
          return [];
        }
      },
      {
        timeout: 30000,
        message:
          `the Agent's persisted model never became "${model}". The selection dropped back ` +
          `to the workspace default, so the flow would run a model the target never asked ` +
          `for (#596/#491 class).`,
      },
    )
    .toContain(model);
}

async function openPlayground(page: Page): Promise<PlaygroundPage> {
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
});

// `any-completion` (#1187, adopted here by #1251). This tier governs ONE test — the
// session-isolation one below. Tests 1 and 2 stay in the hosted describe above: Test 1
// resolves no provider at all, and Test 2 asserts `/Alice/i`, which requires the model
// to recall and restate a name. Adherence is model quality, so it stays hosted by
// design (#1187's criterion is DEPENDENCE, not a pass rate).
//
// What makes this one routable: every assertion is structural (`div-chat-message`
// `toHaveCount(0)` after the reset) or a NEGATIVE about content (`not.toMatch(/Bob/i)`)
// with a non-vacuous "answered at all" guard. The model is never asked to succeed at a
// task. Timing is safe too — `waitForChatResponse` gates on `button-stop` HIDDEN, never
// on catching it visible, which is what disqualified `settings-message-history`, where
// the Stop button must be observed mid-generation.
//
// The keyless surface needed no new helper: `setupOllama` reaches this template's Agent
// node through the same unified `ModelInput` panel the hosted helpers use — measured on
// 1.12.0.dev17, against #1251's premise that a second mechanism was required.
for (const { label, options, skipReason } of resolveTestTargets({ tier: "any-completion" })) {
  const provider = options.provider ?? (Object.keys(providerConfigMap)[0] as Provider);

  test.describe(`Memory Chatbot Regression — session isolation [${label}]`, () => {
    let createdFlowId: string | null = null;

    // Id-scoped, same as the hosted describe: a broad cleanup would kill parallel
    // workers' in-flight flows (#553).
    test.afterEach(async ({ page }) => {
      if (!createdFlowId) return;
      // Home first so the open playground stops polling this flow's /events endpoint;
      // otherwise the delete races those requests into 404 teardown noise.
      await page.goto("/").catch(() => {});
      try {
        await deleteFlow(page.request, createdFlowId);
      } catch {
        // Deliberately silent, matching the hosted describe's teardown.
      }
      createdFlowId = null;
    });

    test(
      "session isolation: new session has no context from previous session",
      { tag: ["@stable", "@release", "@agents", "@playground"] },
      async ({ page }) => {
        test.skip(!!skipReason, skipReason ?? "");
        // The env gate is the TARGET's, never a hosted provider's. `providerSkipGate`
        // would ask whether a hosted key is alive, so on a routed run a drained
        // account would skip a test that needs no key at all — #976's silent
        // coverage loss, reproduced on the mechanism built to prevent it (#1251).
        test.skip(
          !hasProviderEnvKeys(provider),
          `Missing env vars for provider "${provider}": ${missingProviderEnvKeys(provider).join(", ")}`,
        );

        createdFlowId = await loadMemoryChatbot(page);
        const playground = await openRoutedPlayground(
          page,
          createdFlowId,
          provider,
          options.model,
        );

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
}
