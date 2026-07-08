import * as dotenv from "dotenv";
import path from "path";
import fs from "fs";
import type { Page } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { SimpleAgentTemplatePage, type LoadSimpleAgentOptions } from "../../../../pages";
import { waitForFlowSaveSettled } from "../../../../helpers/flows/wait-for-flow-save-settled";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import {
  hasProviderEnvKeys,
  missingProviderEnvKeys,
  providerConfigMap,
  type Provider,
} from "../../../../helpers/provider-setup";
import type { ProviderRecord } from "../../../../helpers/provider-setup/collect-models";

/**
 * Agent multi-tool selection (QA-CHECKLIST §6.2 "Agent with multiple
 * configured tools executes correctly" + §6.4 "Multiple connected tools —
 * agent selects the correct one for each prompt").
 *
 * The Simple Agent template ships with TWO tools wired to the Agent — URL
 * (tool `fetch_content`) and Web Search (tool `perform_search`) — the
 * canonical multi-tool surface. Per prompt, the FIRST tool_use block
 * persisted for the run's session (monitor API, nonce-keyed) must name the
 * expected tool — the first call IS the selection decision. Extra follow-up
 * calls are tolerated: on 2026-07-08 gemini started appending a
 * "verification" search after a correct fetch (provider-side drift, zero
 * Langflow changes — dev34/dev36 fail identically), which retired the
 * original sibling-tool-absent assert (spec doc, "Why first-call" note).
 *
 * The Agent Instructions force exactly one tool call per question WITHOUT
 * naming any tool: tool USE is instructed (a from-memory answer would flake
 * the positive half), tool CHOICE is the agent's — the behavior under test.
 * Search result content is never asserted (non-deterministic); the fetch
 * prompt additionally asserts httpbin.org/json's fixed "Sample Slide Show"
 * title reached the reply.
 */

if (!process.env.CI) {
  dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });
}

const FETCH_URL = "https://httpbin.org/json";
const URL_TOOL = "fetch_content";
const SEARCH_TOOL = "perform_search";
const EXPECTED_TITLE = /Sample Slide Show/i;
const SYSTEM_PROMPT =
  "For every user question you MUST call exactly one tool to obtain the answer - " +
  "never answer from memory and never refuse. Choose the tool that fits the question.";

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

// Flows created by each test are tracked here and deleted by id in
// afterEach — loadTemplateByName does NO cleanup (post-#553 contract), and
// SimpleAgentTemplatePage.load() discards the id, so it is re-captured from
// the template-instantiation POST response in parallel with the load.
const createdFlowIds: string[] = [];

async function loadAgent(page: Page, options: LoadSimpleAgentOptions): Promise<void> {
  // Collect EVERY flow id this page creates (POST /api/v1/flows 201): the
  // app can fire more than one flows POST during template load, and only
  // one of them is the flow that persists — deleting all collected ids is
  // still id-scoped (only THIS test's creations), and a 404 on an already-
  // gone transient id is harmless.
  page.on("response", (resp) => {
    if (
      resp.url().includes("/api/v1/flows") &&
      resp.request().method() === "POST" &&
      resp.status() === 201
    ) {
      resp
        .json()
        .then((body: { id?: string }) => {
          if (body?.id) createdFlowIds.push(body.id);
        })
        .catch(() => {}); // non-JSON / batch payloads
    }
  });
  try {
    await new SimpleAgentTemplatePage(page).load(options);
  } catch (e: any) {
    if (e?.message?.startsWith("MODEL_NOT_AVAILABLE")) test.skip(true, e.message);
    throw e;
  }
}

test.afterEach(async ({ request }) => {
  if (createdFlowIds.length === 0) return;
  const bearer = await getAuthToken(request);
  for (const id of createdFlowIds.splice(0)) {
    const res = await request.delete(`/api/v1/flows/${id}`, {
      headers: { Authorization: bearer },
    });
    // 404 = transient flow the app already discarded — expected noise.
    if (!res.ok() && res.status() !== 404) {
      console.warn(`flow cleanup: DELETE ${id} -> ${res.status()}`);
    }
  }
});

// Set the Agent Instructions (system prompt) on the node.
async function setSystemPrompt(page: Page, prompt: string): Promise<void> {
  const field = page.getByTestId("textarea_str_system_prompt");
  await expect(field).toBeVisible({ timeout: 15000 });
  await field.click();
  await field.fill(prompt);
  await field.blur();
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

async function waitForAgentToFinish(page: Page): Promise<void> {
  const stopButton = page.getByRole("button", { name: "Stop" });
  const stopVisible = await stopButton.isVisible({ timeout: 10000 }).catch(() => false);
  if (stopVisible) {
    await expect(stopButton).toBeHidden({ timeout: 120000 });
  }
}

// Open the Playground with the pre-seeded task and send it.
async function openPlaygroundAndSend(page: Page, task: string): Promise<void> {
  await page.getByTestId("playground-btn-flow-io").click();
  const chatInput = page.getByTestId("input-chat-playground").last();
  await expect(chatInput).toBeVisible({ timeout: 30000 });
  await expect(chatInput).toHaveValue(task, { timeout: 15000 });
  await page.getByTestId("button-send").last().click();
  await waitForAgentToFinish(page);
}

// Monitor-API check of tool SELECTION: the FIRST tool_use block persisted
// for THIS run's session (keyed by the nonce in the user message) must be
// `expectedFirstTool` — the first call is the selection decision. A run
// that opens with the wrong tool fails even if the model recovers later;
// extra follow-up calls after a correct first choice are tolerated
// (provider-side style drift the test does not own).
async function expectToolSelectionPersisted(
  request: APIRequestContext,
  nonce: string,
  expectedFirstTool: string,
): Promise<void> {
  const bearer = await getAuthToken(request);
  await expect
    .poll(
      async () => {
        const res = await request.get("/api/v1/monitor/messages", {
          headers: { Authorization: bearer },
        });
        if (res.status() !== 200) return `GET monitor -> ${res.status()}`;
        const messages = await res.json();
        if (!Array.isArray(messages)) return "monitor payload not a list";

        const userMsg = messages.find(
          (m: any) => m.sender !== "Machine" && (m.text ?? "").includes(nonce),
        );
        if (!userMsg) return "user message with nonce not persisted yet";

        const aiMsg = messages.find(
          (m: any) =>
            m.sender === "Machine" &&
            m.session_id === userMsg.session_id &&
            (m.content_blocks?.length ?? 0) > 0,
        );
        if (!aiMsg) return "AI message for the session not persisted yet";

        const toolNames = (aiMsg.content_blocks as any[])
          .flatMap((b: any) => b.contents ?? [])
          .filter((c: any) => c.type === "tool_use")
          .map((c: any) => c.name as string);
        if (toolNames.length === 0) return "no tool_use blocks persisted yet";

        return toolNames[0] === expectedFirstTool
          ? "correct-tool-selected"
          : `first tool called was "${toolNames[0]}", expected "${expectedFirstTool}"; all: ${JSON.stringify(toolNames)}`;
      },
      { timeout: 30000 },
    )
    .toBe("correct-tool-selected");
}

const targets = getTestTargets();

// Serial mode + --workers=1 keeps the shared instance state deterministic
// (area rule for agent specs). Cleanup is id-scoped in afterEach — nothing
// here wipes flows, so parallel neighbors are never victims.
test.describe.configure({ mode: "serial" });

for (const { label, options, skipReason } of targets) {
  const provider = options.provider ?? (Object.keys(providerConfigMap)[0] as Provider);

  test.describe(`Agent Multi-Tool Selection [${label}]`, () => {
    test(
      "agent selects the URL tool for a fetch prompt",
      { tag: ["@stable", "@regression", "@agents", "@playground"] },
      async ({ page, request }) => {
        test.skip(!!skipReason, skipReason ?? "");
        test.skip(
          !hasProviderEnvKeys(provider),
          `Missing env vars for provider "${provider}": ${missingProviderEnvKeys(provider).join(", ")}`,
        );

        const nonce = `probe-${Date.now()}`;
        const task = `Fetch ${FETCH_URL} and tell me the exact slideshow title it returns. (${nonce})`;

        await loadAgent(page, options);

        await test.step("force tool use (not tool choice), seed the fetch task", async () => {
          await setSystemPrompt(page, SYSTEM_PROMPT);
          await setChatInputText(page, task);
          await waitForFlowSaveSettled(page);
        });

        await test.step("run — no allowFlowErrors: a crashed run fails via the fixture", async () => {
          await openPlaygroundAndSend(page, task);
        });

        await test.step("execution: the reply carries httpbin's deterministic slideshow title", async () => {
          const bubble = page.getByTestId("div-chat-message").last();
          await expect(bubble).toBeVisible({ timeout: 30000 });
          await expect(bubble).toContainText(EXPECTED_TITLE, { timeout: 30000 });
        });

        await test.step("selection: the FIRST tool call is fetch_content", async () => {
          await expectToolSelectionPersisted(request, nonce, URL_TOOL);
        });
      },
    );

    test(
      "agent selects the Web Search tool for a search prompt",
      { tag: ["@stable", "@regression", "@agents", "@playground"] },
      async ({ page, request }) => {
        test.skip(!!skipReason, skipReason ?? "");
        test.skip(
          !hasProviderEnvKeys(provider),
          `Missing env vars for provider "${provider}": ${missingProviderEnvKeys(provider).join(", ")}`,
        );

        const nonce = `probe-${Date.now()}`;
        const task = `Search the web for recent news about the Playwright test framework and summarize one headline. (${nonce})`;

        await loadAgent(page, options);

        await test.step("force tool use (not tool choice), seed the search task", async () => {
          await setSystemPrompt(page, SYSTEM_PROMPT);
          await setChatInputText(page, task);
          await waitForFlowSaveSettled(page);
        });

        await test.step("run — no allowFlowErrors: a crashed run fails via the fixture", async () => {
          await openPlaygroundAndSend(page, task);
        });

        await test.step("execution: the run produced a final, non-empty reply", async () => {
          // Search result content is inherently non-deterministic — the
          // selection assert below is the concrete observable (spec doc,
          // "Guarding against false positives").
          const bubble = page.getByTestId("div-chat-message").last();
          await expect(bubble).toBeVisible({ timeout: 30000 });
          await expect(bubble).not.toHaveText("", { timeout: 30000 });
        });

        await test.step("selection: the FIRST tool call is perform_search", async () => {
          await expectToolSelectionPersisted(request, nonce, SEARCH_TOOL);
        });
      },
    );
  });
}
