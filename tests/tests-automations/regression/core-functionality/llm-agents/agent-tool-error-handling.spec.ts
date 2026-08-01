import * as dotenv from "dotenv";
import path from "path";
import type { Page } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { SimpleAgentTemplatePage, type LoadSimpleAgentOptions } from "../../../../pages";
import { waitForFlowSaveSettled } from "../../../../helpers/flows/wait-for-flow-save-settled";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import {
  hasProviderEnvKeys,
  missingProviderEnvKeys,
  providerConfigMap,
  type Provider,
} from "../../../../helpers/provider-setup";
import { resolveTestTargets } from "../../../../helpers/provider-setup/test-targets";

/**
 * Agent tool error handling (QA-CHECKLIST §6.4 "Tool returns error — agent
 * handles it and continues execution").
 *
 * One run proves both halves of the bullet (the pair is intrinsic):
 *   (a) the fetch tool REALLY errored — its persisted tool_use output contains
 *       the backend's SSRF rejection (monitor API, keyed to this run's session
 *       via a per-run nonce);
 *   (b) the agent handled it and CONTINUED — the final Playground reply carries
 *       the instructed TOOL_FAILED sentinel, and the fixture (no
 *       allowFlowErrors) fails the test on any flow error.
 *
 * The error generator is Langflow's own SSRF protection (an intentional
 * security feature): fetching http://localhost:7860/... fails always,
 * instantly and offline with a stable message — the most deterministic
 * tool-error source available (same technique as agent-max-iterations, #481).
 * Note: with handle_tool_error=True the exception becomes a normal tool
 * output ("Executed **fetch_content**"), NOT an "Error using" header — see
 * the spec doc's Rendering note.
 */

if (!process.env.CI) {
  dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });
}

const TARGET_URL = "http://localhost:7860/api/v1/version";
const SYSTEM_PROMPT =
  "You have web tools. To answer any question about a URL you MUST call the URL fetch tool - never guess or invent responses. " +
  "If a tool call fails or returns an error, reply with a message that starts with TOOL_FAILED: followed by the reason.";
const SSRF_MARKER = /SSRF Protection/i;
const CONTINUATION_SENTINEL = /TOOL_FAILED/i;

// Ids of the flows created by loadAgent(), so afterEach can delete exactly
// those via the API (id-scoped, #515) — never a global cleanAllFlows.
// `SimpleAgentTemplatePage.load()` does NOT pre-clean since #553, so without
// this the spec leaked one Simple Agent flow per run (#992).
const createdFlowIds: string[] = [];

async function loadAgent(page: Page, options: LoadSimpleAgentOptions): Promise<void> {
  try {
    const flowId = await new SimpleAgentTemplatePage(page).load(options);
    if (flowId) createdFlowIds.push(flowId);
  } catch (e: any) {
    if (e?.message?.startsWith("MODEL_NOT_AVAILABLE")) test.skip(true, e.message);
    throw e;
  }
}

test.afterEach(async ({ page }) => {
  const ids = createdFlowIds.splice(0);
  if (ids.length === 0) return;
  // Navigate off the editor first so the unmounted flow page stops polling a
  // flow we are about to delete, then pass an explicit bearer — page.request is
  // unauthenticated under AUTO_LOGIN and would 401 otherwise.
  await page.goto("/");
  const auth = await getAuthToken(page.request);
  const opts = auth ? { headers: { Authorization: auth } } : undefined;
  for (const id of ids) {
    await deleteFlow(page.request, id, opts);
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

// Monitor-API check that the fetch tool's persisted output carries the SSRF
// rejection — proof the tool REALLY errored in THIS run. Messages persist
// across flow wipes (earlier runs of this spec leave identical outputs
// behind), so the lookup is keyed to the current run's session via the
// nonce embedded in the user message.
async function expectToolErrorPersisted(
  request: APIRequestContext,
  nonce: string,
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

        const toolBlocks = (aiMsg.content_blocks as any[])
          .flatMap((b: any) => b.contents ?? [])
          .filter((c: any) => c.type === "tool_use" && c.name === "fetch_content");
        if (toolBlocks.length === 0) return "no fetch_content tool_use block";

        return toolBlocks.some((c: any) => SSRF_MARKER.test(JSON.stringify(c.output ?? "")))
          ? "tool-error-persisted"
          : `fetch_content output has no SSRF rejection: ${JSON.stringify(toolBlocks[0].output).slice(0, 120)}`;
      },
      { timeout: 30000 },
    )
    .toBe("tool-error-persisted");
}

// Assert the agent's continuation reply carries `expected` on the PERSISTED
// message (monitor API, nonce-keyed session), NOT the live playground bubble.
// The bubble renders the empty placeholder ("Message empty.", the frontend's
// EMPTY_OUTPUT_SEND_MESSAGE) while the agent is mid-execution, and a run can
// outlast the old 30s bubble window / return between phases from
// `waitForAgentToFinish` — so reading the live bubble races the stream, which
// was the #634 flaky "Message empty." symptom (verified: no backend 5xx, monitor
// state=complete; the empty bubble is a streaming/empty-turn artifact, not a
// product error). The persisted reply appears only once the run completes, so
// polling it is a race-free completion gate. A genuinely empty final turn (rare,
// model-side, tracked in #634) still fails here rather than silently passing.
async function expectReplyContainsPersisted(
  request: APIRequestContext,
  nonce: string,
  expected: RegExp,
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

        const replies = messages
          .filter((m: any) => m.sender === "Machine" && m.session_id === userMsg.session_id)
          .map((m: any) => ((m.text as string) ?? "").trim());
        if (replies.length === 0) return "AI message for the session not persisted yet";
        if (replies.every((t) => t === ""))
          return "AI reply persisted but still empty (run not finished / empty final turn)";

        return replies.some((t) => expected.test(t))
          ? "reply-contains-expected"
          : `reply did not match ${expected}: ${JSON.stringify(replies.map((t) => t.slice(0, 120)))}`;
      },
      { timeout: 60000 },
    )
    .toBe("reply-contains-expected");
}

const targets = resolveTestTargets({ tier: "tool-calling" });

// Serial mode + --workers=1 keeps the shared instance state deterministic.
// (This used to claim SimpleAgentTemplatePage.load() deletes all flows first —
// false since #553, and the reason the missing cleanup above went unnoticed.)
test.describe.configure({ mode: "serial" });

for (const { label, options, skipReason } of targets) {
  const provider = options.provider ?? (Object.keys(providerConfigMap)[0] as Provider);

  test.describe(`Agent Tool Error Handling [${label}]`, () => {
    // @stable restored in #992: the #726 flake (removed by daily triage #704 on
    // 07-07/07-10) no longer reproduces — 7/7 clean at `--retries=0`, including
    // two rounds under concurrent load. See reports/daily-history.jsonl.
    test(
      "agent handles a tool error and continues execution",
      { tag: ["@stable", "@regression", "@agents", "@playground"] },
      async ({ page, request }) => {
        test.skip(!!skipReason, skipReason ?? "");
        test.skip(
          !hasProviderEnvKeys(provider),
          `Missing env vars for provider "${provider}": ${missingProviderEnvKeys(provider).join(", ")}`,
        );

        const nonce = `probe-${Date.now()}`;
        const task = `Fetch ${TARGET_URL} and tell me the exact "version" value it returns. (${nonce})`;

        await loadAgent(page, options);

        await test.step("force the fetch tool, instruct the failure sentinel, seed the task", async () => {
          await setSystemPrompt(page, SYSTEM_PROMPT);
          await setChatInputText(page, task);
          await waitForFlowSaveSettled(page);
        });

        await test.step("run — the SSRF-blocked fetch makes the tool error deterministically", async () => {
          // No allowFlowErrors: a crashed run fails here via the fixture,
          // which is half of the "handled" guarantee.
          await openPlaygroundAndSend(page, task);
        });

        await test.step("agent continued: final reply carries the TOOL_FAILED sentinel", async () => {
          const bubble = page.getByTestId("div-chat-message").last();
          await expect(bubble).toBeVisible({ timeout: 30000 });
          // Gate on the PERSISTED reply first — race-free completion signal; the
          // live bubble shows the empty placeholder mid-run (#634 "Message
          // empty." race), so it must not be the primary observable.
          await expectReplyContainsPersisted(request, nonce, CONTINUATION_SENTINEL);
          // The run is now complete, so the user-visible bubble must ALSO carry
          // the sentinel. Re-asserting it here (after the gate, so no stream race)
          // keeps end-to-end UI coverage: a bubble stuck on "Message empty." while
          // the reply persisted would be a real frontend bug and must still fail.
          await expect(bubble).toContainText(CONTINUATION_SENTINEL, { timeout: 15000 });
        });

        await test.step("tool really errored: persisted tool output carries the SSRF rejection", async () => {
          await expectToolErrorPersisted(request, nonce);
        });
      },
    );
  });
}
