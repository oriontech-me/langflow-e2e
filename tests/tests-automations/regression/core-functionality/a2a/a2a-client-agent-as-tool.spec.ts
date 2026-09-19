import * as dotenv from "dotenv";
import path from "path";
import { randomUUID } from "crypto";
import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test, type PageWithErrorHooks } from "../../../../fixtures/fixtures";
import { SimpleAgentTemplatePage, type LoadSimpleAgentOptions } from "../../../../pages";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { requireA2aEnabled } from "../../../../helpers/a2a/require-a2a-enabled";
// The suite's one narrow transport re-dial (#1562): retries a THROWN request once,
// never a response. Lives with the RBAC helpers that needed it first.
import { retryOnDroppedConnection } from "../../../../helpers/enterprise/rbac";
import { createRunnableChatFlowViaApi } from "../../../../helpers/flows/create-runnable-chat-flow-via-api";
import { addComponentFromSidebar } from "../../../../helpers/flows/add-component-from-sidebar";
import { deleteComponent } from "../../../../helpers/flows/delete-component";
import { trackCreatedFlows } from "../../../../helpers/flows/track-created-flows";
import { waitForFlowSaveSettled } from "../../../../helpers/flows/wait-for-flow-save-settled";
import { waitForComponentUpdateSettled } from "../../../../helpers/flows/wait-for-component-update-settled";
import {
  hasProviderEnvKeys,
  missingProviderEnvKeys,
  providerConfigMap,
  type Provider,
} from "../../../../helpers/provider-setup";
import { resolveTestTargets } from "../../../../helpers/provider-setup/test-targets";

if (!process.env.CI) {
  dotenv.config({ path: path.resolve(__dirname, "../../../../../.env") });
}

// Spec doc: docs/core-functionality/a2a/a2a-client-agent-as-tool.md
//
// An Agent delegating to a published A2A agent through the A2AAgent component used
// as a TOOL. The regression recorded here, LE-1963, did not break the plain tool
// call: it fired when the run RESUMED after a tool-call approval, where
// `self.user_id` was None and `_run_target_isolated` handed `str(None)` to a UUID
// parser ("badly formed hexadecimal UUID string"). So this spec goes through the
// approval pause, and uses Internal mode — the only mode that reads `user_id`.
//
// Siblings: a2a-client-agent-internal covers the dropdown and a direct (non-tool)
// Internal call; a2a-client-agent-external covers External mode;
// core-components/edit-tools covers the Requires Approval toggle's persistence;
// playground/human-input-pause-resume covers the HITL card for the Human Input
// node, which this card shares.

const A2A_SEARCH_TERM = "A2A";
const A2A_ADD_BUTTON = "add-component-button-a2a-agent";
const MODE_TAB_INTERNAL = "tab_0_internal";
const AGENT_DROPDOWN = "value-dropdown-dropdown_str_agent_name_selected";

const TOOL_NAME = "send_to_agent";
const TOOL_BADGE = `tool_${TOOL_NAME}`;
const A2A_TOOLSET_HANDLE = "handle-a2aagent-shownode-toolset-right";
const AGENT_TOOLS_HANDLE = "handle-agent-shownode-tools-left";

// The Simple Agent template's own tools, as [node type, display title].
const TEMPLATE_TOOLS = [
  ["URLComponent", "URL"],
  ["UnifiedWebSearch", "Web Search"],
] as const;

const APPROVAL_CARD = "human-input-card";
const APPROVE_BUTTON = "human-input-decision-approve";

// The Requires Approval switch renders at once but writes onto its grid row ~200 ms
// after the click; closing the editor before that write loses the flip (see
// core-components/edit-tools.spec.ts, where this window was measured).
const ROW_COMMIT_MS = 600;

const LLM_TIMEOUT_MS = 120_000;

// Every poll that issues API reads stays under 2 s between calls. At an idle gap of
// ~2000 ms the request context's reused keep-alive socket is closed under it and the
// read throws `socket hang up` — which `expect.poll` does not retry, so the poll ends
// early on a transport error instead of the condition (measured on this spec, twice).
// The reads are also re-dialled once (`retryOnDroppedConnection`) for the gaps a
// poll interval does not control, like the first read after a UI step.
const API_POLL_INTERVALS = [250, 500, 1_000];

let flows: ReturnType<typeof trackCreatedFlows>;

// The template load creates the caller flow from the UI, so its id is captured by
// the shared tracker (a `load()` that throws after creating it would otherwise
// leak it). The target flow is created through the API and deleted by the test.
test.beforeEach(({ page }) => {
  flows = trackCreatedFlows(page);
});

test.afterEach(async ({ request }) => {
  await flows.cleanup(request);
  flows.dispose();
});

async function loadAgent(page: Page, options: LoadSimpleAgentOptions): Promise<string> {
  try {
    return await new SimpleAgentTemplatePage(page).load(options);
  } catch (e: any) {
    if (e?.message?.startsWith("MODEL_NOT_AVAILABLE")) test.skip(true, e.message);
    throw e;
  }
}

async function patchFlow(
  request: APIRequestContext,
  headers: Record<string, string>,
  flowId: string,
  data: Record<string, unknown>,
) {
  const res = await retryOnDroppedConnection(() =>
    request.patch(`/api/v1/flows/${flowId}`, { headers, data }),
  );
  expect(res.status(), `PATCH /api/v1/flows/${flowId} — ${await res.text()}`).toBe(200);
  return res.json();
}

interface ContentItem {
  type?: string;
  name?: string;
  output?: unknown;
}

interface StoredMessage {
  sender?: string;
  text?: unknown;
  session_id?: string;
  content_blocks?: Array<{ contents?: ContentItem[] }>;
}

async function readFlowMessages(
  request: APIRequestContext,
  headers: Record<string, string>,
  flowId: string,
): Promise<StoredMessage[]> {
  const res = await retryOnDroppedConnection(() =>
    request.get(`/api/v1/monitor/messages?flow_id=${flowId}`, { headers }),
  );
  expect(res.status(), `GET /api/v1/monitor/messages — ${await res.text()}`).toBe(200);
  return (await res.json()) as StoredMessage[];
}

async function messagesCarrying(
  request: APIRequestContext,
  headers: Record<string, string>,
  flowId: string,
  sentinel: string,
): Promise<StoredMessage[]> {
  const messages = await readFlowMessages(request, headers, flowId);
  return messages.filter((m) => typeof m.text === "string" && m.text.includes(sentinel));
}

/** Every persisted `send_to_agent` tool_use output of a flow, serialised. */
async function persistedToolOutputs(
  request: APIRequestContext,
  headers: Record<string, string>,
  flowId: string,
): Promise<string[]> {
  const messages = await readFlowMessages(request, headers, flowId);
  return messages
    .filter((m) => m.sender === "Machine")
    .flatMap((m) => m.content_blocks ?? [])
    .flatMap((b) => b.contents ?? [])
    .filter((c) => c.type === "tool_use" && c.name === TOOL_NAME)
    .map((c) => JSON.stringify(c.output ?? ""));
}

interface FlowNode {
  id?: string;
  data?: {
    node?: {
      template?: {
        tools_metadata?: { value?: Array<{ name?: string; approval_actions?: unknown }> };
      };
    };
  };
}

/** The A2AAgent node's persisted `approval_actions` for its `send_to_agent` action. */
async function persistedApprovalActions(
  request: APIRequestContext,
  headers: Record<string, string>,
  flowId: string,
): Promise<unknown> {
  const res = await retryOnDroppedConnection(() =>
    request.get(`/api/v1/flows/${flowId}`, { headers }),
  );
  if (!res.ok()) return `GET /api/v1/flows/${flowId} -> ${res.status()}`;
  const flow = (await res.json()) as { data?: { nodes?: FlowNode[] } };
  const node = (flow.data?.nodes ?? []).find((n) => String(n.id ?? "").startsWith("A2AAgent-"));
  const actions = node?.data?.node?.template?.tools_metadata?.value ?? [];
  return actions.find((a) => a.name === TOOL_NAME)?.approval_actions ?? null;
}

async function pendingRunCount(
  request: APIRequestContext,
  headers: Record<string, string>,
  flowId: string,
): Promise<number> {
  const res = await retryOnDroppedConnection(() =>
    request.get(`/api/v2/workflows/pending?flow_id=${flowId}`, { headers }),
  );
  if (!res.ok()) throw new Error(`GET /api/v2/workflows/pending -> ${res.status()}`);
  const body = await res.json();
  return Array.isArray(body) ? body.length : -1;
}

/**
 * Waits out the node's `custom_component/update` round trips before the next canvas action.
 *
 * Tool Mode and a new edge each round-trip the node, and a response that lands after
 * a later action is applied on top of it. Measured on this spec: a click issued with
 * an update in flight opened nothing, and the runs where that happened were exactly
 * the runs where the Agent later had no tool to call. Retrying the click hid that; a
 * barrier removes it. Capped rather than open-ended, and the cap fails loudly: a node
 * that never stops updating is not a canvas this spec can reason about.
 */
async function settleNodeUpdates(page: Page, when: string): Promise<void> {
  const settled = await waitForComponentUpdateSettled(page);
  expect(settled, `node updates were still in flight 15 s ${when}`).toBe(true);
}

/**
 * Why the run did not (yet) pause, as a string `expect.poll` can print.
 *
 * With `send_to_agent` as the Agent's only tool, a finished run without the card has
 * exactly two readings, and they point at different owners: the model called no tool
 * at all, or the tool RAN without pausing — the approval requirement never reached
 * the run.
 */
async function approvalPauseState(
  page: Page,
  request: APIRequestContext,
  headers: Record<string, string>,
  targetFlowId: string,
  sentinel: string,
): Promise<string> {
  if (await page.getByTestId(APPROVAL_CARD).isVisible().catch(() => false)) return "paused";
  if (await page.getByRole("button", { name: "Stop" }).isVisible().catch(() => false)) {
    return "the run is still in progress, with no approval card yet";
  }
  const turns = (await page.locator('[data-testid^="chat-message-AI-"]').allTextContents())
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (turns.length === 0) return "no approval card and no answer yet";
  const ran = (await messagesCarrying(request, headers, targetFlowId, sentinel)).length > 0;
  return ran
    ? `the run finished WITHOUT pausing and the target already ran — the approval requirement did not reach the run. AI turns: ${JSON.stringify(turns)}`
    : `the run finished without calling ${TOOL_NAME}. AI turns: ${JSON.stringify(turns)}`;
}

/** Exactly one edge leaves the A2AAgent node, and it reaches the Agent. */
async function expectSingleToolEdge(page: Page): Promise<void> {
  // Edge testids embed both node ids; `-Agent-` (with the leading dash) is the Agent
  // node and cannot match the `A2AAgent-` id on the other end.
  await expect(page.locator('.react-flow__edge[data-testid*="A2AAgent-"]')).toHaveCount(1);
  await expect(
    page.locator('.react-flow__edge[data-testid*="A2AAgent-"][data-testid*="-Agent-"]'),
  ).toHaveCount(1);
}

async function setChatInputText(page: Page, text: string): Promise<void> {
  const field = page.locator(
    '[data-testid^="rf__node-ChatInput"] [data-testid="textarea_str_input_value"]',
  );
  await expect(field).toBeVisible({ timeout: 15_000 });
  await field.click();
  await field.fill(text);
  await field.blur();
}

const targets = resolveTestTargets({ tier: "tool-calling" });

// Serial + --workers=1 is the area rule for agent specs: the template autosaves and
// the model binding settle on the shared instance. Cleanup is id-scoped.
test.describe.configure({ mode: "serial" });

for (const { label, options, skipReason } of targets) {
  const provider = options.provider ?? (Object.keys(providerConfigMap)[0] as Provider);

  test.describe(`A2A Client — A2AAgent as an Agent tool [${label}]`, () => {
    // `@stable` removed for #1921 — a confirmed product defect in `lfx`, not a test
    // or wait-strategy problem. `lfx/graph/checkpoint/schema.py` infers "this field is
    // opaque" from `model_dump(mode="json")` raising; langchain-core >= 1.6 made
    // `args_schema` serializable, so the guard stopped firing and the Agent toolset's
    // `coroutine` is now checkpointed as a `repr` string. The resumed run then dies in
    // `model_validate`, and this is the only `@stable` spec that pauses a run holding
    // an agent's toolset. The nightly IMAGE still pins langchain-core 1.5.1 and masks
    // it, which is why the Actions lane passes while the VM lane (published dist in a
    // venv, current dependencies) fails 10/10 — so the tag comes off ahead of the VM
    // lane becoming the source of truth, instead of the VM gate opening red or
    // `auto-remove-stable` filing the finding away as triage. No `test.fixme`: the
    // spec is green on the impacted-specs lane, which runs the masked image, so #871
    // does not apply and that lane keeps the signal for when the image picks the
    // dependency up. Restoring the tag is a deliverable of #1921.
    test("an approved send_to_agent call resumes the run and executes the published agent",
      { tag: ["@regression", "@components", "@workspace", "@a2a", "@agents"] },
      async ({ page }) => {
        test.skip(!!skipReason, skipReason ?? "");
        test.skip(
          !hasProviderEnvKeys(provider),
          `Missing env vars for provider "${provider}": ${missingProviderEnvKeys(provider).join(", ")}`,
        );

        const headers = { Authorization: await getAuthToken(page.request) };
        await requireA2aEnabled(page.request, headers);

        const agentName = `a2a-tool-target-${randomUUID().slice(0, 8)}`;
        const sentinel = `a2a-tool-${randomUUID()}`;
        const prompt = `Use the '${TOOL_NAME}' tool with the message: ${sentinel}`;

        const target = await createRunnableChatFlowViaApi(page.request, headers);
        let callerFlowId = "";

        try {
          await test.step("publish the target flow as an A2A agent under a known name", async () => {
            const patched = await patchFlow(page.request, headers, target.flowId, {
              name: agentName,
              flow_type: "agent",
              a2a_enabled: true,
            });
            expect(patched.a2a_enabled).toBe(true);
          });

          await test.step("load the Simple Agent template with the resolved model", async () => {
            callerFlowId = await loadAgent(page, options);
          });

          await test.step("remove the template's own tools", async () => {
            // The sidebar would drop the A2A Agent on top of them, and with
            // send_to_agent as the only tool a missing approval card can only mean
            // the model called no tool.
            for (const [nodeType, title] of TEMPLATE_TOOLS) {
              const node = page.locator(`[data-testid^="rf__node-${nodeType}-"]`);
              await expect(node).toHaveCount(1, { timeout: 15_000 });
              await deleteComponent(page, "backspace", node.getByTestId(`title-${title}`));
              await expect(node).toHaveCount(0, { timeout: 10_000 });
            }
          });

          await test.step("add the A2A Agent in Internal mode, pointed at the target", async () => {
            await addComponentFromSidebar(page, A2A_SEARCH_TERM, A2A_ADD_BUTTON);
            await expect(page.getByTestId("title-A2A Agent")).toBeVisible();
            // Required: the node opens in External mode, where the picker is absent.
            await page.getByTestId(MODE_TAB_INTERNAL).click();
            await page.getByTestId(AGENT_DROPDOWN).click();
            const option = page.getByTestId(`${agentName}-0-option`);
            await expect(option).toBeVisible({ timeout: 15_000 });
            await option.click();
            await expect(page.getByTestId(AGENT_DROPDOWN)).toContainText(agentName);
            await settleNodeUpdates(page, "after selecting the agent");
          });

          await test.step("turn it into a tool and wire it to the Agent", async () => {
            await page.getByTestId("title-A2A Agent").click();
            await page.getByTestId("tool-mode-button").click({ timeout: 15_000 });
            await expect(page.getByTestId(TOOL_BADGE)).toBeVisible({ timeout: 15_000 });

            await settleNodeUpdates(page, "after switching to Tool Mode");
            await page.getByTestId(A2A_TOOLSET_HANDLE).dragTo(page.getByTestId(AGENT_TOOLS_HANDLE));
            await settleNodeUpdates(page, "after wiring the tool");
            // Asserted AFTER the settle: an edge a late response undid fails here,
            // not as a missing tool call two minutes later.
            await expectSingleToolEdge(page);
          });

          await test.step("require approval before the tool runs", async () => {
            await page
              .locator('.react-flow__node[data-id^="A2AAgent-"]')
              .getByTestId("button_open_actions")
              .click();
            const toggle = page.getByTestId("requires-approval-toggle");
            await expect(
              toggle,
              "the actions editor did not open — a node update was still re-rendering the node",
            ).toHaveCount(1, { timeout: 15_000 });
            await toggle.click();
            await expect(toggle).toHaveAttribute("aria-checked", "true");
            await page.waitForTimeout(ROW_COMMIT_MS);
            // #1519: a round trip in flight across the close overwrites the edits.
            await settleNodeUpdates(page, "before closing the actions editor");

            await page.keyboard.press("Escape");
            await expect(page.locator('[role="dialog"]')).toHaveCount(0, { timeout: 15_000 });

            // The editor applies its edits on close (#1519): poll the flow the run
            // will be built from rather than trusting the switch.
            await expect
              .poll(() => persistedApprovalActions(page.request, headers, callerFlowId), {
                message: `the ${TOOL_NAME} action never persisted an approval requirement`,
                timeout: 20_000,
                intervals: API_POLL_INTERVALS,
              })
              .toEqual(expect.arrayContaining(["approve"]));
          });

          await test.step("ask the Agent to call the tool with a per-run sentinel", async () => {
            // The playground runs the CANVAS, not the saved flow: the tool edge has to
            // still be there now.
            await expectSingleToolEdge(page);
            await setChatInputText(page, prompt);
            await waitForFlowSaveSettled(page);
            await page.getByTestId("playground-btn-flow-io").click();
            const chatInput = page.getByTestId("input-chat-playground").last();
            await expect(chatInput).toBeVisible({ timeout: 30_000 });
            await expect(chatInput).toHaveValue(prompt, { timeout: 15_000 });
            await page.getByTestId("button-send").last().click();
          });

          await test.step("the run pauses on the approval card, and the tool has not run", async () => {
            await expect
              .poll(
                () => approvalPauseState(page, page.request, headers, target.flowId, sentinel),
                { timeout: LLM_TIMEOUT_MS, intervals: API_POLL_INTERVALS },
              )
              .toBe("paused");
            const card = page.getByTestId(APPROVAL_CARD);
            await expect(card).toContainText(TOOL_NAME);
            await expect(card).toContainText(sentinel);
            await expect(page.getByTestId(APPROVE_BUTTON)).toBeEnabled({ timeout: 15_000 });

            // Parked server-side, not just drawn: the backend holds the run.
            await expect
              .poll(() => pendingRunCount(page.request, headers, callerFlowId), { timeout: 30_000 })
              .toBe(1);

            // NEGATIVE CONTROL for the resume step: with the run parked, the target
            // flow has not been executed.
            expect(
              await messagesCarrying(page.request, headers, target.flowId, sentinel),
              "the target flow ran before the call was approved",
            ).toHaveLength(0);
          });

          await test.step("approve", async () => {
            await page.getByTestId(APPROVE_BUTTON).click();
          });

          await test.step("the resumed tool call completes and executes the target flow", async () => {
            await expect(
              page.getByTestId("tool-status-done").first(),
              "the approved tool call never completed (LE-1963 failed exactly here, on resume)",
            ).toBeVisible({ timeout: LLM_TIMEOUT_MS });
            await expect(page.getByTestId("tool-status-error")).toHaveCount(0);

            // Read from the server, so it holds whatever the model writes next. The
            // Internal call runs the target in-process under `<caller session>:a2a:<id>`.
            await expect
              .poll(
                async () =>
                  (await messagesCarrying(page.request, headers, target.flowId, sentinel)).some(
                    (m) =>
                      m.sender === "User" &&
                      (m.session_id ?? "").endsWith(`:a2a:${target.flowId}`),
                  ),
                {
                  message: `the target flow ${target.flowId} never stored the sentinel after approval`,
                  timeout: 30_000,
                  intervals: API_POLL_INTERVALS,
                },
              )
              .toBe(true);
          });

          await test.step("the agent's reply came back into the run, and the run answered", async () => {
            // The sentinel is read from the PERSISTED tool output, never from the
            // Agent's final wording: measured, the same model echoed it on one run and
            // answered "The message has been sent successfully." on the next two.
            await expect
              .poll(
                async () => {
                  const outputs = await persistedToolOutputs(page.request, headers, callerFlowId);
                  if (outputs.length === 0) return `no ${TOOL_NAME} tool_use block persisted yet`;
                  return outputs.some((o) => o.includes(sentinel))
                    ? "tool-output-carries-sentinel"
                    : `${TOOL_NAME} output lacks the sentinel: ${outputs[0].slice(0, 300)}`;
                },
                { timeout: 60_000, intervals: API_POLL_INTERVALS },
              )
              .toBe("tool-output-carries-sentinel");

            // The playground turn only has to exist. The empty `chat-message-AI-`
            // bubble is the host message that carries the approval card, so it is
            // not the answer.
            await expect
              .poll(
                async () => {
                  const turns = await page
                    .locator('[data-testid^="chat-message-AI-"]')
                    .allTextContents();
                  return turns.some((t) => t.trim().length > 0)
                    ? "non-empty-ai-turn"
                    : `AI turns: ${JSON.stringify(turns)}`;
                },
                { timeout: 60_000 },
              )
              .toBe("non-empty-ai-turn");
          });

          await test.step("the run finished, and every run stream was read and clean", async () => {
            await expect
              .poll(() => pendingRunCount(page.request, headers, callerFlowId), { timeout: 60_000 })
              .toBe(0);
            await expect(page.getByRole("button", { name: "Stop" })).toBeHidden({
              timeout: LLM_TIMEOUT_MS,
            });

            const report = await (page as PageWithErrorHooks).flowErrorReport();
            // `clean` is vacuously true when nothing was read, so both are asserted.
            expect(report.evaluated, report.summary).toBeGreaterThan(0);
            expect(report.clean, report.summary).toBe(true);
          });
        } finally {
          await target
            .deleteFlow()
            .catch((e) => console.warn(`⚠️ target flow cleanup failed: ${e}`));
        }
      },
    );
  });
}
