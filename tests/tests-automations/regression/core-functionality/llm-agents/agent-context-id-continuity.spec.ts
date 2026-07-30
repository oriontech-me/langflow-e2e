import * as dotenv from "dotenv";
import path from "path";
import fs from "fs";
import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { SimpleAgentTemplatePage, type LoadSimpleAgentOptions } from "../../../../pages";
import { waitForFlowSaveSettled } from "../../../../helpers/flows/wait-for-flow-save-settled";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import {
  closeAdvancedOptions,
  openAdvancedOptions,
} from "../../../../helpers/ui/open-advanced-options";
import { createRunnableChatFlowViaApi } from "../../../../helpers/flows/create-runnable-chat-flow-via-api";
import { addComponentFromSidebar } from "../../../../helpers/flows/add-component-from-sidebar";
import { adjustScreenView } from "../../../../helpers/ui/adjust-screen-view";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import {
  hasProviderEnvKeys,
  missingProviderEnvKeys,
  providerConfigMap,
  type Provider,
} from "../../../../helpers/provider-setup";
import { providerSkipReasons } from "../../../../helpers/provider-setup/provider-health";

/**
 * Agent context_id continuity (QA-CHECKLIST §6.3 "Agent uses custom
 * context_id — continuity between session messages").
 *
 * context_id "adds an extra layer to the local memory": ChatInput/ChatOutput
 * tag the messages they store with it, and the Agent's history retrieval
 * resolves through aget_agent_chat_history(session, flow, context_id, n) —
 * the same context-scoped layer Message History's Retrieve mode reads.
 *
 * Both tests are DETERMINISTIC — no model-recall assertion (three recall
 * designs flaked at spec level in #482; the unit-shift to the shared backend
 * retrieval is the same deviation class, flagged on the PR):
 *
 *   Test 1 (write half, agent in the loop): a Simple Agent run with
 *   context_id=CTX persists every session message tagged context_id=CTX
 *   (monitor API, nonce-keyed).
 *   Test 2 (continuity half, model-free): 3 passthrough runs seeded under
 *   (session, CTX) all come back from a context-scoped Message History
 *   retrieval — and an untagged control message from the SAME session does
 *   NOT (the negative that makes the positive falsifiable).
 *
 * context_id is set via API PATCH on the flow nodes (the /api/v1/run payload
 * does not carry it) — the §6.3 contract is the memory layer's behavior, not
 * the input widget.
 */

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
  const skipReasons = providerSkipReasons();

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

// Flows created by test 1 are tracked here and deleted by id in afterEach —
// loadTemplateByName does NO cleanup (post-#553 contract), and the app can
// fire more than one flows POST during template load (only one persists;
// deleting a transient id 404s harmlessly — deleteFlow treats 404 as done).
const createdFlowIds: string[] = [];

async function loadAgent(page: Page, options: LoadSimpleAgentOptions): Promise<void> {
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
    await deleteFlow(request, id, { headers: { Authorization: bearer } });
  }
});

// The collect-listener records transient ids too — the LIVE flow is the one
// the flows API still returns.
async function resolveLiveFlowId(
  request: APIRequestContext,
  bearer: string,
  ids: string[],
): Promise<string> {
  for (const id of [...ids].reverse()) {
    const res = await request.get(`/api/v1/flows/${id}`, {
      headers: { Authorization: bearer },
    });
    if (res.status() === 200) return id;
  }
  throw new Error(`none of the collected flow ids is live: ${JSON.stringify(ids)}`);
}

// Set context_id on the given node types via API PATCH — the run payload
// cannot carry it; the value lives in the flow's node templates.
async function patchContextId(
  request: APIRequestContext,
  bearer: string,
  flowId: string,
  nodeTypes: string[],
  contextId: string,
): Promise<void> {
  const headers = { Authorization: bearer };
  const res = await request.get(`/api/v1/flows/${flowId}`, { headers });
  expect(res.status()).toBe(200);
  const flow = await res.json();
  let patched = 0;
  for (const node of flow.data?.nodes ?? []) {
    if (nodeTypes.includes(node.data?.type) && node.data?.node?.template?.context_id) {
      node.data.node.template.context_id.value = contextId;
      patched++;
    }
  }
  expect(patched, `nodes with a context_id field among ${JSON.stringify(nodeTypes)}`).toBe(nodeTypes.length);
  const patchRes = await request.patch(`/api/v1/flows/${flowId}`, {
    headers,
    data: { data: flow.data },
  });
  expect(patchRes.status()).toBe(200);
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

async function openPlaygroundAndSend(page: Page, task: string): Promise<void> {
  await page.getByTestId("playground-btn-flow-io").click();
  const chatInput = page.getByTestId("input-chat-playground").last();
  await expect(chatInput).toBeVisible({ timeout: 30000 });
  await expect(chatInput).toHaveValue(task, { timeout: 15000 });
  await page.getByTestId("button-send").last().click();
  await waitForAgentToFinish(page);
}

// Monitor-API check: every message persisted for the nonce's session carries
// context_id === expected. Requires at least the user+AI pair so a lone user
// row cannot pass the assert early.
async function expectSessionTaggedWithContext(
  request: APIRequestContext,
  nonce: string,
  expectedContext: string,
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

        const sessionMsgs = messages.filter(
          (m: any) => m.session_id === userMsg.session_id,
        );
        if (sessionMsgs.length < 2) return `only ${sessionMsgs.length} session message(s) persisted yet`;

        const badly = sessionMsgs.filter((m: any) => m.context_id !== expectedContext);
        return badly.length === 0
          ? "all-session-messages-tagged"
          : `message(s) with wrong context_id: ${JSON.stringify(badly.map((m: any) => ({ sender: m.sender, context_id: m.context_id })))}`;
      },
      { timeout: 30000 },
    )
    .toBe("all-session-messages-tagged");
}

// ---------- test 2 machinery (model-free; mirrors agent-n-messages-limit) ----------

const SEED_RUNS = 3;

interface SeededContextFlow {
  flowId: string;
  session: string;
  sentinel: string;
  contextId: string;
  cleanup: () => Promise<void>;
}

// Passthrough flow whose ChatInput/ChatOutput are PATCHed to tag messages
// with contextId; 3 runs seeded under it plus ONE control run with the
// context reset to empty — same session, no tag. Seed verified to the exact
// count so a failed seed fails HERE, not as a silent empty retrieval later.
async function seedContextSession(request: APIRequestContext): Promise<SeededContextFlow> {
  const bearer = await getAuthToken(request);

  const keyRes = await request.post("/api/v1/api_key/", {
    headers: { Authorization: bearer },
    data: { name: `ctx-cont-${Date.now()}-${Math.random().toString(36).slice(2, 7)}` },
  });
  expect(keyRes.status()).toBe(200);
  const { api_key: apiKey, id: apiKeyId } = await keyRes.json();

  const { flowId, deleteFlow: deleteSeededFlow } = await createRunnableChatFlowViaApi(request, {
    Authorization: bearer,
  });

  const sentinel = `CTXCONT-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const session = `${sentinel}-session`;
  const contextId = `${sentinel}-ctx`;

  const runOnce = async (text: string) => {
    const runRes = await request.post(`/api/v1/run/${flowId}`, {
      headers: { "x-api-key": apiKey },
      data: { input_value: text, input_type: "chat", output_type: "chat", session_id: session },
    });
    expect(runRes.status()).toBe(200);
  };
  const expectStoredCount = async (count: number) => {
    await expect
      .poll(
        async () => {
          const res = await request.get(
            `/api/v1/monitor/messages?session_id=${session}`,
            { headers: { Authorization: bearer } },
          );
          if (res.status() !== 200) return -1;
          return ((await res.json()) as unknown[]).length;
        },
        { timeout: 15000 },
      )
      .toBe(count);
  };

  await patchContextId(request, bearer, flowId, ["ChatInput", "ChatOutput"], contextId);
  for (let i = 1; i <= SEED_RUNS; i++) await runOnce(`${sentinel}-${i}`);
  await expectStoredCount(SEED_RUNS * 2);

  // Control: same session, context reset to empty — its sentinel must NOT
  // come back from the context-scoped retrieval.
  await patchContextId(request, bearer, flowId, ["ChatInput", "ChatOutput"], "");
  await runOnce(`${sentinel}-CTRL`);
  await expectStoredCount(SEED_RUNS * 2 + 2);

  return {
    flowId,
    session,
    sentinel,
    contextId,
    cleanup: async () => {
      await deleteSeededFlow().catch(() => {});
      await request
        .delete(`/api/v1/api_key/${apiKeyId}`, { headers: { Authorization: bearer } })
        .catch(() => {});
    },
  };
}

// Add a Message History node, expose its hidden n_messages/session_id/
// context_id fields, point it at (session, context), run it, return the
// retrieved text (default template renders one line per message).
async function retrieveViaMessageHistory(
  page: Page,
  flowId: string,
  session: string,
  contextId: string,
): Promise<string> {
  await page.goto(`/flow/${flowId}`);
  await page
    .getByTestId("sidebar-search-input")
    .waitFor({ state: "visible", timeout: 60000 });

  await addComponentFromSidebar(
    page,
    "message history",
    "add-component-button-message-history",
  );
  const node = page.locator('[data-testid^="rf__node-Memory"]').first();
  await expect(node).toBeVisible({ timeout: 15000 });
  // Fit the canvas BEFORE selecting the node: a sidebar-added node can land
  // outside the viewport, taking `parameters-button` — which mounts in the
  // node's own toolbar — off-screen with it (#989). Order matters: fitting
  // AFTER selection drops the selection and unmounts the toolbar (#867).
  await adjustScreenView(page, { numberOfZoomOut: 0 });

  await page.getByTestId("title-Message History").click();
  // dev46: expose the advanced n_messages / session_id / context_id fields on the
  // node body via the inspector (replaces the old edit-fields modal + show<field>).
  await openAdvancedOptions(page);
  await page.getByTestId("inspector-add-n_messages").click();
  await page.getByTestId("inspector-add-session_id").click();
  await page.getByTestId("inspector-add-context_id").click();
  await closeAdvancedOptions(page);

  await page.getByTestId("int_int_n_messages").fill("100");
  await page.getByTestId("popover-anchor-input-session_id").fill(session);
  await page.getByTestId("popover-anchor-input-context_id").fill(contextId);
  await waitForFlowSaveSettled(page);

  await page.getByTestId("button_run_message history").click();
  await page.waitForSelector("text=built successfully", { timeout: 30000 });

  const inspectButton = page.getByTestId("output-inspection-messages-memory");
  await expect(inspectButton).toBeEnabled({ timeout: 20000 });
  await inspectButton.click();

  const dialog = page.locator('[role="dialog"]').last();
  const textarea = dialog.getByTestId("textarea");
  await expect(textarea).toBeVisible({ timeout: 15000 });
  return textarea.inputValue();
}

const targets = getTestTargets();

// Test 1 loads the Simple Agent template — serial + --workers=1 per the
// agent-area rule. Cleanup is id-scoped; nothing here wipes flows.
test.describe.configure({ mode: "serial" });

for (const { label, options, skipReason } of targets) {
  const provider = options.provider ?? (Object.keys(providerConfigMap)[0] as Provider);

  test.describe(`Agent Context ID Continuity [${label}]`, () => {
    test(
      "agent run persists every session message tagged with the custom context_id",
      { tag: ["@stable", "@regression", "@agents", "@components"] },
      async ({ page, request }) => {
        test.skip(!!skipReason, skipReason ?? "");
        test.skip(
          !hasProviderEnvKeys(provider),
          `Missing env vars for provider "${provider}": ${missingProviderEnvKeys(provider).join(", ")}`,
        );

        const nonce = `probe-${Date.now()}`;
        const contextId = `ctx-${nonce}`;
        const task = `Reply with a short greeting. (${nonce})`;

        await loadAgent(page, options);

        const bearer = await getAuthToken(request);
        const flowId = await resolveLiveFlowId(request, bearer, createdFlowIds);

        await test.step("set context_id on Agent + Chat Input + Chat Output via API, reload", async () => {
          await patchContextId(request, bearer, flowId, ["Agent", "ChatInput", "ChatOutput"], contextId);
          await page.reload();
          await page.waitForSelector('[data-testid="canvas_controls_dropdown"]', { timeout: 30000 });
        });

        await test.step("seed the task and run through the Playground", async () => {
          await setChatInputText(page, task);
          await waitForFlowSaveSettled(page);
          await openPlaygroundAndSend(page, task);
        });

        await test.step("every persisted session message carries context_id === CTX", async () => {
          await expectSessionTaggedWithContext(request, nonce, contextId);
        });
      },
    );
  });
}

test.describe("Context ID continuity — retrieval layer (model-free)", () => {
  test(
    "context-scoped retrieval returns all turns of the context and not the untagged control",
    { tag: ["@stable", "@regression", "@agents", "@components"] },
    async ({ page, request }) => {
      const seeded = await seedContextSession(request);
      try {
        const retrieved = await test.step(
          "retrieve the session scoped to the custom context",
          () => retrieveViaMessageHistory(page, seeded.flowId, seeded.session, seeded.contextId),
        );

        await test.step("all 3 tagged turns present; untagged control absent", async () => {
          expect(retrieved).toContain(`${seeded.sentinel}-1`);
          expect(retrieved).toContain(`${seeded.sentinel}-2`);
          expect(retrieved).toContain(`${seeded.sentinel}-3`);
          // The negative that makes the positive falsifiable: an unfiltered
          // retrieve-everything bug returns the control too.
          expect(retrieved).not.toContain(`${seeded.sentinel}-CTRL`);
        });
      } finally {
        await seeded.cleanup();
      }
    },
  );
});
