import * as dotenv from "dotenv";
import path from "path";
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
import { resolveTestTargets } from "../../../../helpers/provider-setup/test-targets";

/**
 * Agent tool inspection (QA-CHECKLIST §6.5 "Inspect tools used by Agent in
 * Playground"). After a tool-using run, the operator must be able to inspect
 * what the agent did — this spec asserts BOTH layers of that surface:
 *
 *   1. UI (which tool) — the Playground renders a `div-tools_tools_metadata`
 *      row with a `tool_<name>` chip (here `tool_fetch_content`, label
 *      "FETCH_CONTENT") naming the tool the agent called.
 *   2. Payload (what it did) — the run's persisted `tool_use` content block
 *      (monitor API, nonce-keyed) carries `tool_input` (the exact arguments,
 *      here the prompt's URL) and `output` (the tool result, the deterministic
 *      slideshow title). This is the inspection DATA behind the UI.
 *
 * 1.12 rendering note: through ~1.11 the tool call surfaced as a
 * `.cursor-pointer` "Called tool" accordion that expanded inline to Input/Output
 * JSON; on 1.12 that accordion is gone (scouted live on 1.12.0.dev0). The chips
 * name the tool; the input/output payload lives only in `content_blocks`, which
 * is what any inspection reads from — so this spec asserts the chip (UI) + the
 * persisted payload (API), not a DOM accordion that no longer exists (#894 found
 * the same drift for the MCP-tool indicator).
 *
 * Distinct from siblings: `agent-multi-tool-selection` asserts WHICH tool and
 * the ORDER of a sequence; `mcp-client-agent` asserts the chip for MCP tools.
 * Neither asserts the tool call's INPUT arguments are captured — this spec's
 * subject. Gated: no @stable at creation (flaky cluster #773; promotion gated
 * on the clean baseline #818, per #827).
 */

if (!process.env.CI) {
  dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });
}

const HTTPBIN_BASE = (
  process.env.ECHO_BASE_URL ??
  process.env.HTTPBIN_BASE_URL ??
  "https://httpbin.org"
).replace(/\/$/, "");
const FETCH_URL = `${HTTPBIN_BASE}/json`;
const URL_TOOL = "fetch_content";
const EXPECTED_TITLE = /Sample Slide Show/i;
const SYSTEM_PROMPT =
  "For every user question you MUST call exactly one tool to obtain the answer - " +
  "never answer from memory and never refuse. Choose the tool that fits the question.";

// Flow ids created by each test, deleted by id in afterEach (id-scoped — never
// name-based or delete-all). SimpleAgentTemplatePage.load() discards the id, so
// it is re-captured from the template-instantiation POST response.
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
        .catch(() => {});
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
    if (!res.ok() && res.status() !== 404) {
      console.warn(`flow cleanup: DELETE ${id} -> ${res.status()}`);
    }
  }
});

async function setSystemPrompt(page: Page, prompt: string): Promise<void> {
  const field = page.getByTestId("textarea_str_system_prompt");
  await expect(field).toBeVisible({ timeout: 15000 });
  await field.click();
  await field.fill(prompt);
  await field.blur();
}

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

// The Playground renders the tools-metadata block inside a collapsed
// "Steps"/"Finished" accordion by default (chat-message.tsx, hideHeader=false —
// chevron click required to reveal it). Best-effort expand every such row so the
// `div-tools_tools_metadata` / `tool_<name>` chips become visible; if already
// expanded the click is a no-op. Mirrors mcp-client-agent.spec.ts (proven on
// 1.12) — the chevron trigger is a `.cursor-pointer` in the header row.
async function expandAgentSteps(page: Page): Promise<void> {
  await page.evaluate(() => {
    const rows = Array.from(
      document.querySelectorAll<HTMLElement>("div.flex.items-center.justify-between"),
    ).filter((row) => {
      const text = row.textContent ?? "";
      return text.includes("Finished") || text.includes("Steps");
    });
    for (const row of rows) {
      row.querySelector<HTMLElement>(".cursor-pointer")?.click();
    }
  });
}

// Payload inspection (§6.5): the persisted `tool_use` block for THIS run
// (nonce-keyed) must carry `tool_input` containing `inputNeedle` (the prompt's
// exact URL — proves the captured input is the real arguments) AND `output`
// matching `outputRe` (the deterministic tool result — proves the captured
// output is the real payload, not a from-memory recitation). Asserted on the
// monitor API, not the live bubble (empty placeholder mid-run) nor the model
// prose (recitable) — same rationale as agent-multi-tool-selection.
async function expectToolInspectionPersisted(
  request: APIRequestContext,
  nonce: string,
  toolName: string,
  inputNeedle: string,
  outputRe: RegExp,
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

        const aiMsgs = messages.filter(
          (m: any) => m.sender === "Machine" && m.session_id === userMsg.session_id,
        );
        if (aiMsgs.length === 0) return "AI message for the session not persisted yet";

        const toolCalls = aiMsgs
          .flatMap((m: any) => (m.content_blocks ?? []) as any[])
          .flatMap((b: any) => (b.contents ?? []) as any[])
          .filter((c: any) => c.type === "tool_use" && c.name === toolName);
        if (toolCalls.length === 0) return `no ${toolName} tool_use block persisted yet`;

        const match = toolCalls.find((c: any) => {
          const input = JSON.stringify(c.tool_input ?? c.input ?? "");
          const output = JSON.stringify(c.output ?? "");
          return input.includes(inputNeedle) && outputRe.test(output);
        });
        if (match) return "tool-inspection-captured";
        const c = toolCalls[0];
        return (
          `${toolName} block found but input/output did not match — ` +
          `input=${JSON.stringify(c.tool_input ?? c.input ?? "").slice(0, 150)} ` +
          `output=${JSON.stringify(c.output ?? "").slice(0, 150)}`
        );
      },
      { timeout: 90000 },
    )
    .toBe("tool-inspection-captured");
}

const targets = resolveTestTargets({ tier: "tool-calling" });

// Serial + --workers=1: shared instance state (agent-family rule). Cleanup is
// id-scoped in afterEach — nothing here wipes flows.
test.describe.configure({ mode: "serial" });

for (const { label, options, skipReason } of targets) {
  const provider = options.provider ?? (Object.keys(providerConfigMap)[0] as Provider);

  test.describe(`Agent Tool Inspection [${label}]`, () => {
    test(
      "Playground names the tool used and captures its input/output",
      { tag: ["@regression", "@agents", "@playground"] },
      async ({ page, request }) => {
        test.skip(!!skipReason, skipReason ?? "");
        test.skip(
          !hasProviderEnvKeys(provider),
          `Missing env vars for provider "${provider}": ${missingProviderEnvKeys(provider).join(", ")}`,
        );

        const nonce = `probe-${Date.now()}`;
        const task = `Fetch ${FETCH_URL} and tell me the exact slideshow title it returns. (${nonce})`;

        await loadAgent(page, options);

        await test.step("force tool use, seed the fetch task", async () => {
          await setSystemPrompt(page, SYSTEM_PROMPT);
          await setChatInputText(page, task);
          await waitForFlowSaveSettled(page);
        });

        await test.step("run — no allowFlowErrors: a crashed run fails via the fixture", async () => {
          await openPlaygroundAndSend(page, task);
        });

        await test.step("UI inspection: the tools-used row names the URL tool", async () => {
          // Reveal the collapsed Steps accordion, then assert the tools-metadata
          // block + the URL-tool chip (unscoped `.last()`, mirroring the proven
          // mcp-client-agent assertions — the block only exists after a real tool
          // call, so a hallucinated text-only answer has no chip).
          await expandAgentSteps(page);
          await expect(
            page.getByTestId("div-tools_tools_metadata").last(),
            "Playground must show a tool-usage block — agent answered without invoking any tool",
          ).toBeVisible({ timeout: 120000 });
          await expect(
            page.getByTestId(`tool_${URL_TOOL}`).last(),
            `The tool named in the Playground must be ${URL_TOOL}`,
          ).toBeVisible({ timeout: 5000 });
        });

        await test.step("payload inspection: tool_input carries the prompt URL and output the real result", async () => {
          await expectToolInspectionPersisted(request, nonce, URL_TOOL, FETCH_URL, EXPECTED_TITLE);
        });

        await test.step("causal anchor: the final answer contains the fetched title", async () => {
          const aiMsg = page.locator('[data-testid^="chat-message-AI-"]').last();
          await expect(aiMsg).toContainText(EXPECTED_TITLE, { timeout: 30000 });
        });
      },
    );
  });
}
