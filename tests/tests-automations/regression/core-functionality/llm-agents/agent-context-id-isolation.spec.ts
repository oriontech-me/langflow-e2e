import * as dotenv from "dotenv";
import path from "path";
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
import { clearCanvasBottomOverlay } from "../../../../helpers/ui/clear-canvas-bottom-overlay";
import { adjustScreenView } from "../../../../helpers/ui/adjust-screen-view";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import {
  hasProviderEnvKeys,
  missingProviderEnvKeys,
  providerConfigMap,
  type Provider,
} from "../../../../helpers/provider-setup";
import { resolveTestTargets } from "../../../../helpers/provider-setup/test-targets";

/**
 * Agent context_id isolation (QA-CHECKLIST §6.3 "Switching context_id
 * isolates history between distinct sessions" + §7.7 "Use of custom
 * context_id for memory isolation").
 *
 * context_id "adds an extra layer to the local memory": stored messages are
 * tagged with it, and history retrieval resolves through
 * aget_agent_chat_history(session, flow, context_id, n). Continuity WITHIN
 * one context is agent-context-id-continuity.spec.ts (#487) — this spec
 * proves the wall BETWEEN two custom contexts.
 *
 * Both tests are DETERMINISTIC — no model-recall assertion (three recall
 * designs flaked at spec level in #482; the unit-shift to the shared backend
 * retrieval is the same deviation class, flagged on the PR):
 *
 *   Test 1 (read half, model-free): one session seeded under CTX-A then
 *   CTX-B; the CTX-A-scoped Message History retrieval returns every A-*
 *   sentinel and zero B-*, and the mirrored CTX-B retrieval returns every
 *   B-* and zero A-*. Symmetric negatives — a leak in either direction fails.
 *   Test 2 (write half, agent in the loop): a Simple Agent turn under CTX-A
 *   then a second turn after SWITCHING to CTX-B persist their messages
 *   tagged with exactly the context active at that turn (monitor API,
 *   id-partitioned per turn) — and the switch does not re-tag turn 1.
 *
 * context_id is set via API PATCH on the flow nodes (the /api/v1/run payload
 * does not carry it) — the contract is the memory layer's behavior, not the
 * input widget.
 */

if (!process.env.CI) {
  dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });
}

// Flows created by test 2 are tracked here and deleted by id in afterEach —
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

// Read the context_id currently stored on the given node types.
async function readContextIds(
  request: APIRequestContext,
  bearer: string,
  flowId: string,
  nodeTypes: string[],
): Promise<Record<string, unknown>> {
  const res = await request.get(`/api/v1/flows/${flowId}`, {
    headers: { Authorization: bearer },
  });
  expect(res.status()).toBe(200);
  const flow = await res.json();
  const values: Record<string, unknown> = {};
  for (const node of flow.data?.nodes ?? []) {
    const type = node.data?.type;
    if (nodeTypes.includes(type)) {
      values[type] = node.data?.node?.template?.context_id?.value;
    }
  }
  return values;
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

const CONTEXT_NODE_TYPES = ["Agent", "ChatInput", "ChatOutput"];
const CONTEXT_WRITE_ATTEMPTS = 3;

// Put the flow in the state a turn needs — context_id switched AND the task
// seeded — and only return once the SERVER confirms the context on every node.
//
// The write is an API PATCH, but the editor keeps firing its own debounced
// PATCH /api/v1/flows/{id} with the store's snapshot after a playground turn.
// That autosave can be issued after ours and land last (the endpoint has no
// version check), silently reverting the switch: the next turn then runs under
// the OLD context and the isolation assert fails for a defect that does not
// exist — the #1060 flake, reproduced locally with the frontend PATCH going out
// 23 ms after ours and finishing 20 ms behind it. Re-patch while the server
// still disagrees; if the editor wins every attempt, fail HERE naming the
// reverted write instead of downstream as fake cross-tagging.
async function prepareTurn(
  page: Page,
  request: APIRequestContext,
  bearer: string,
  flowId: string,
  contextId: string,
  task: string,
): Promise<void> {
  let stored: Record<string, unknown> = {};
  for (let attempt = 1; attempt <= CONTEXT_WRITE_ATTEMPTS; attempt++) {
    await patchContextId(request, bearer, flowId, CONTEXT_NODE_TYPES, contextId);
    await page.reload();
    await page.waitForSelector('[data-testid="canvas_controls_dropdown"]', { timeout: 30000 });
    await setChatInputText(page, task);
    await waitForFlowSaveSettled(page);

    stored = await readContextIds(request, bearer, flowId, CONTEXT_NODE_TYPES);
    if (CONTEXT_NODE_TYPES.every((type) => stored[type] === contextId)) return;
  }
  throw new Error(
    `context_id "${contextId}" was reverted by the editor autosave on ${CONTEXT_WRITE_ATTEMPTS} consecutive attempts — stored: ${JSON.stringify(stored)}`,
  );
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
  // On a REOPEN the playground keeps the previous turn's draft instead of
  // re-reading the ChatInput node — fill explicitly. The node holds the same
  // string, so a late default re-injection converges on the same value.
  await chatInput.fill(task);
  await expect(chatInput).toHaveValue(task, { timeout: 15000 });
  await page.getByTestId("button-send").last().click();
  await waitForAgentToFinish(page);
}

interface MonitorMessage {
  id: string;
  sender: string;
  text?: string;
  session_id: string;
  context_id?: string;
}

async function getMonitorMessages(
  request: APIRequestContext,
  bearer: string,
): Promise<MonitorMessage[] | string> {
  const res = await request.get("/api/v1/monitor/messages", {
    headers: { Authorization: bearer },
  });
  if (res.status() !== 200) return `GET monitor -> ${res.status()}`;
  const messages = await res.json();
  return Array.isArray(messages) ? (messages as MonitorMessage[]) : "monitor payload not a list";
}

// Turn-1 check: every message persisted for the nonce's session carries
// context_id === expected. Returns the turn's message ids + session, so the
// turn-2 check can partition new messages from old by id (message counts per
// agent turn are not fixed — id partition beats counting).
async function expectTurnTaggedAndCollect(
  request: APIRequestContext,
  nonce: string,
  expectedContext: string,
): Promise<{ sessionId: string; messageIds: string[] }> {
  const bearer = await getAuthToken(request);
  let sessionId = "";
  let messageIds: string[] = [];
  await expect
    .poll(
      async () => {
        const messages = await getMonitorMessages(request, bearer);
        if (typeof messages === "string") return messages;

        const userMsg = messages.find(
          (m) => m.sender !== "Machine" && (m.text ?? "").includes(nonce),
        );
        if (!userMsg) return "user message with nonce not persisted yet";

        const sessionMsgs = messages.filter((m) => m.session_id === userMsg.session_id);
        if (sessionMsgs.length < 2) return `only ${sessionMsgs.length} session message(s) persisted yet`;

        const badly = sessionMsgs.filter((m) => m.context_id !== expectedContext);
        if (badly.length > 0) {
          return `message(s) with wrong context_id: ${JSON.stringify(badly.map((m) => ({ sender: m.sender, context_id: m.context_id })))}`;
        }
        sessionId = userMsg.session_id;
        messageIds = sessionMsgs.map((m) => m.id);
        return "all-turn-messages-tagged";
      },
      { timeout: 30000 },
    )
    .toBe("all-turn-messages-tagged");
  return { sessionId, messageIds };
}

// Turn-2 check: in the SAME session, every message NOT belonging to turn 1
// carries the switched context, and every turn-1 message still carries the
// original one (the switch must not re-tag history).
async function expectSwitchedTurnTagging(
  request: APIRequestContext,
  turn1: { sessionId: string; messageIds: string[] },
  nonce2: string,
  turn1Context: string,
  turn2Context: string,
): Promise<void> {
  const bearer = await getAuthToken(request);
  const turn1Ids = new Set(turn1.messageIds);
  await expect
    .poll(
      async () => {
        const messages = await getMonitorMessages(request, bearer);
        if (typeof messages === "string") return messages;

        const sessionMsgs = messages.filter((m) => m.session_id === turn1.sessionId);
        const newMsgs = sessionMsgs.filter((m) => !turn1Ids.has(m.id));

        const user2 = newMsgs.find(
          (m) => m.sender !== "Machine" && (m.text ?? "").includes(nonce2),
        );
        if (!user2) return "turn-2 user message not persisted yet";
        if (newMsgs.length < 2) return `only ${newMsgs.length} turn-2 message(s) persisted yet`;

        const badNew = newMsgs.filter((m) => m.context_id !== turn2Context);
        if (badNew.length > 0) {
          return `turn-2 message(s) with wrong context_id: ${JSON.stringify(badNew.map((m) => ({ sender: m.sender, context_id: m.context_id })))}`;
        }
        const badOld = sessionMsgs.filter(
          (m) => turn1Ids.has(m.id) && m.context_id !== turn1Context,
        );
        return badOld.length === 0
          ? "turns-tagged-with-their-own-context"
          : `turn-1 message(s) re-tagged: ${JSON.stringify(badOld.map((m) => ({ sender: m.sender, context_id: m.context_id })))}`;
      },
      { timeout: 30000 },
    )
    .toBe("turns-tagged-with-their-own-context");
}

// ---------- test 1 machinery (model-free; mirrors agent-context-id-continuity) ----------

const SEED_RUNS = 3;

interface SeededTwoContextFlow {
  flowId: string;
  session: string;
  sentinel: string;
  contextA: string;
  contextB: string;
  cleanup: () => Promise<void>;
}

// Passthrough flow whose ChatInput/ChatOutput are PATCHed to CTX-A for 3
// seeded runs (sentinels A-1..3), then to CTX-B for 3 more (B-1..3) — one
// session, two context layers. Each seeding block is verified to the exact
// stored count so a failed seed fails HERE, not as a silent empty retrieval.
async function seedTwoContextSession(request: APIRequestContext): Promise<SeededTwoContextFlow> {
  const bearer = await getAuthToken(request);

  const keyRes = await request.post("/api/v1/api_key/", {
    headers: { Authorization: bearer },
    data: { name: `ctx-iso-${Date.now()}-${Math.random().toString(36).slice(2, 7)}` },
  });
  expect(keyRes.status()).toBe(200);
  const { api_key: apiKey, id: apiKeyId } = await keyRes.json();

  const { flowId, deleteFlow: deleteSeededFlow } = await createRunnableChatFlowViaApi(request, {
    Authorization: bearer,
  });

  const sentinel = `CTXISO-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const session = `${sentinel}-session`;
  const contextA = `${sentinel}-ctx-A`;
  const contextB = `${sentinel}-ctx-B`;

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

  await patchContextId(request, bearer, flowId, ["ChatInput", "ChatOutput"], contextA);
  for (let i = 1; i <= SEED_RUNS; i++) await runOnce(`${sentinel}-A-${i}`);
  await expectStoredCount(SEED_RUNS * 2);

  await patchContextId(request, bearer, flowId, ["ChatInput", "ChatOutput"], contextB);
  for (let i = 1; i <= SEED_RUNS; i++) await runOnce(`${sentinel}-B-${i}`);
  await expectStoredCount(SEED_RUNS * 4);

  return {
    flowId,
    session,
    sentinel,
    contextA,
    contextB,
    cleanup: async () => {
      // Multi-step teardown: swallow so a failed flow delete still lets the
      // API-key cleanup below run.
      await deleteSeededFlow().catch(() => {});
      await request
        .delete(`/api/v1/api_key/${apiKeyId}`, { headers: { Authorization: bearer } })
        .catch(() => {});
    },
  };
}

// Add a Message History node once, expose its hidden n_messages/session_id/
// context_id fields, and pin it to the seeded session. Retrievals for the two
// contexts then reuse the SAME node via runRetrievalScopedTo.
async function setupMessageHistoryNode(
  page: Page,
  flowId: string,
  session: string,
): Promise<void> {
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
}

// Point the already-set-up Message History node at contextId, run it, and
// return the retrieved text from the output inspector (default template
// renders one line per message). Closes the inspector before returning so the
// next scoped run starts from the canvas.
async function runRetrievalScopedTo(page: Page, contextId: string): Promise<string> {
  await page.getByTestId("popover-anchor-input-context_id").fill(contextId);
  await waitForFlowSaveSettled(page);

  // The success toast of a previous run must be gone before waiting on the
  // next one, or the stale toast satisfies the wait immediately.
  await page.waitForSelector("text=built successfully", { state: "hidden", timeout: 15000 });
  await page.getByTestId("button_run_message history").click();
  await page.waitForSelector("text=built successfully", { timeout: 30000 });

  // The canvas' bottom-centre slot is shared by the build-status bar and the
  // "Flow needs review" banner, and the banner takes the slot back the moment the
  // bar auto-dismisses. This node's inspect button sits ~5 px from that slot, so
  // the click is refused for as long as the taller banner owns it — #1643. Free
  // the slot instead of retrying under it.
  await clearCanvasBottomOverlay(page);

  const inspectButton = page.getByTestId("output-inspection-messages-memory");
  await expect(inspectButton).toBeEnabled({ timeout: 20000 });
  await inspectButton.click();

  const dialog = page.locator('[role="dialog"]').last();
  const textarea = dialog.getByTestId("textarea");
  await expect(textarea).toBeVisible({ timeout: 15000 });
  const text = await textarea.inputValue();

  // Escape does not close the output inspector — use its Close button.
  await dialog.getByText("Close").last().click();
  await expect(dialog).toBeHidden({ timeout: 10000 });
  return text;
}

// `any-completion` (#1187). As in `agent-context-id-continuity`, this governs ONE
// test — the parametrized "switching the agent's context_id re-tags new turns". The
// "retrieval layer (model-free)" describe above is outside the `targets` loop and
// already resolves no provider, so it is not part of what this declaration routes.
//
// The routed test reads which context_id the PERSISTED turns carry, never what the
// agent said, so the model chooses nothing. The deciding observable is Langflow's
// per-context isolation.
//
// **Measured 7/7** routed on the CI lane against `llama3.2:1b` — the same dispatches
// recorded in `agent-context-id-continuity.spec.ts`, which measured 6/7 there (its one
// failure was a canvas-layout helper, not an assertion of its own).
//
// Read that against the hosted baseline rather than as a clean bill: this spec
// hard-failed on **6 of 22** hosted dailies and was flaky on 4 more before any of this.
// It is the heavier of the two — two turns plus up to three `prepareTurn` reload cycles
// inside the 5-minute cap — so it carries the thinner margin of the pair even though
// neither assertion reads the reply.
const targets = resolveTestTargets({ tier: "any-completion" });

// Test 2 loads the Simple Agent template — serial + --workers=1 per the
// agent-area rule (`llm-agents/CLAUDE.md`), so serial is declared on THAT
// describe rather than on the file (#1690). File-level `mode: "serial"` makes a
// failure skip every LATER test in the file, and the two describes here share
// nothing: the retrieval describe resolves no provider at all. Measured on
// 1.13.0.dev1 — with the parametrized test failing, every run reported
// `skipped=0` and the model-free coverage still reported its own verdict.
// Cleanup is id-scoped; nothing here wipes flows.

test.describe("Context ID isolation — retrieval layer (model-free)", () => {
  test(
    "mirrored context-scoped retrievals return only their own context's messages",
    { tag: ["@stable", "@regression", "@agents", "@components"] },
    async ({ page, request }) => {
      const seeded = await seedTwoContextSession(request);
      try {
        await test.step("add a Message History node pinned to the seeded session", () =>
          setupMessageHistoryNode(page, seeded.flowId, seeded.session));

        const retrievedA = await test.step(
          "retrieve the session scoped to CTX-A",
          () => runRetrievalScopedTo(page, seeded.contextA),
        );

        await test.step("CTX-A retrieval: all A-* present, zero B-*", async () => {
          for (let i = 1; i <= SEED_RUNS; i++) {
            expect(retrievedA).toContain(`${seeded.sentinel}-A-${i}`);
          }
          // The symmetric negative: an unfiltered retrieve-everything bug
          // returns the other context's sentinels too.
          expect(retrievedA).not.toContain(`${seeded.sentinel}-B-`);
        });

        const retrievedB = await test.step(
          "retrieve the same session scoped to CTX-B",
          () => runRetrievalScopedTo(page, seeded.contextB),
        );

        await test.step("CTX-B retrieval: all B-* present, zero A-*", async () => {
          for (let i = 1; i <= SEED_RUNS; i++) {
            expect(retrievedB).toContain(`${seeded.sentinel}-B-${i}`);
          }
          expect(retrievedB).not.toContain(`${seeded.sentinel}-A-`);
        });
      } finally {
        await seeded.cleanup();
      }
    },
  );
});

for (const { label, options, skipReason } of targets) {
  const provider = options.provider ?? (Object.keys(providerConfigMap)[0] as Provider);

  test.describe.serial(`Agent Context ID Isolation [${label}]`, () => {
    test(
      "switching the agent's context_id re-tags new turns without touching previous ones",
      { tag: ["@stable", "@regression", "@agents", "@playground"] },
      async ({ page, request }) => {
        test.skip(!!skipReason, skipReason ?? "");
        test.skip(
          !hasProviderEnvKeys(provider),
          `Missing env vars for provider "${provider}": ${missingProviderEnvKeys(provider).join(", ")}`,
        );

        // #1689 — CONFIRMED product defect, not a mute. The message the Agent
        // persists for its own turn carries `context_id: null` while every other
        // message of the same session carries the configured one: `agent.py`
        // threads `context_id` through the READ path (`get_memory_data`) but
        // `_construct_agent_message` builds the stored Message without it, and
        // `lfx/base/agents/events.py` never mentions it. Reproduced 6/6 on
        // 1.12.0.dev45 and 1.13.0.dev1, and DOWNSTREAM of the #1060
        // confirmed-write gate, which passes — so a reverted write is excluded.
        //
        // `test.fail()` rather than `test.fixme`: the test keeps RUNNING, so the
        // day the upstream fix lands it reports "expected to fail, but passed"
        // and points back at #1689 — a quarantine would stay silent. The cost,
        // stated because it is real: this absorbs ANY failure of this test, so an
        // unrelated regression here is invisible until the annotation is lifted.
        // Lift it (and re-validate `@stable`) as #1689's deliverable.
        test.fail();

        const nonce1 = `probe-A-${Date.now()}`;
        const nonce2 = `probe-B-${Date.now()}`;
        const contextA = `ctx-A-${nonce1}`;
        const contextB = `ctx-B-${nonce1}`;
        const task1 = `Reply with a short greeting. (${nonce1})`;
        const task2 = `Reply with a short farewell. (${nonce2})`;

        await loadAgent(page, options);

        const bearer = await getAuthToken(request);
        const flowId = await resolveLiveFlowId(request, bearer, createdFlowIds);

        await test.step("set context_id = CTX-A on Agent + Chat Input + Chat Output, run turn 1", async () => {
          await prepareTurn(page, request, bearer, flowId, contextA, task1);
          await openPlaygroundAndSend(page, task1);
        });

        const turn1 = await test.step("turn-1 messages all tagged CTX-A", () =>
          expectTurnTaggedAndCollect(request, nonce1, contextA));

        await test.step("switch context_id to CTX-B, run turn 2 in the same session", async () => {
          await page.keyboard.press("Escape"); // close the playground modal
          await prepareTurn(page, request, bearer, flowId, contextB, task2);
          await openPlaygroundAndSend(page, task2);
        });

        await test.step("turn-2 messages all tagged CTX-B; turn 1 still CTX-A", () =>
          expectSwitchedTurnTagging(request, turn1, nonce2, contextA, contextB));
      },
    );
  });
}
