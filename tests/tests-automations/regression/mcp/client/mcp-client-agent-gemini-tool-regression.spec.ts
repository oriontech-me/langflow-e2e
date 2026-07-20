import * as dotenv from "dotenv";
import path from "path";
import fs from "fs";
import type { Page, APIRequestContext } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { SimpleAgentTemplatePage, type LoadSimpleAgentOptions } from "../../../../pages";
import { hasProviderEnvKeys, missingProviderEnvKeys } from "../../../../helpers/provider-setup";
import type { ProviderRecord } from "../../../../helpers/provider-setup/collect-models";
import { resolveGeminiModel } from "../../../../helpers/provider-setup/resolve-gemini-model";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import { adjustScreenView } from "../../../../helpers/ui/adjust-screen-view";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";

/**
 * MCP Client – Gemini tool-calling regression (upstream Langflow #440).
 *
 * Guards the Gemini × MCP tool-calling path IN ISOLATION. On 1.11.0
 * gemini-2.5-flash calls native Langflow tools (URL, Web Search, Calculator)
 * but silently does NOT invoke MCP tools (`echo`) — bug #440. The generic
 * mcp-client-agent.spec.ts could not surface this: its three provider variants
 * share a file-scope `mode: "serial"` group, the OpenAI variant runs first and
 * flakes daily on an unrelated `toBeHidden` timeout, and in serial mode a
 * failure SKIPS every later test — so the Gemini variant (the only one that
 * exercises #440) never ran. This file is deliberately standalone (no shared
 * serial group), pins Gemini and names it in the title (self-attributing
 * signal). See docs/mcp/client/mcp-client-agent-gemini-tool-regression.md.
 *
 * DIRECTION OF THE ASSERT (read before "fixing" this test):
 * While #440 is OPEN, this test asserts the CURRENTLY-BROKEN behavior — the
 * agent runs and answers but invokes NO `echo` MCP tool — via the monitor API
 * (backend truth, immune to frontend selector drift). It therefore PASSES today
 * and FLIPS RED the moment Langflow fixes #440 (an `echo` tool_use block starts
 * being persisted). A red here is the promote signal: remove this guard, fold
 * Gemini back into mcp-client-agent's coverage, promote to @stable.
 * `test.fail()` was deliberately rejected: it converts ANY failure (a broken
 * bootstrap, a down instance, an unregistered MCP server) into a green
 * "expected failure", masking real breakage — proven live during authoring.
 * Here the setup asserts stay LOUD: infra breakage goes genuinely red.
 */

if (!process.env.CI) {
  dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });
}

// Worker- and timestamp-suffixed name prevents cross-file races with the other
// specs that also register an "everything" MCP server.
const MCP_SERVER_NAME = `everything-gemini-${process.env.TEST_WORKER_INDEX ?? "0"}-${Date.now()}`;
const MCP_JSON_CONFIG = JSON.stringify({
  mcpServers: {
    [MCP_SERVER_NAME]: {
      command: "npx",
      args: ["@modelcontextprotocol/server-everything"],
    },
  },
});

const PROVIDER = "google" as const;
const ECHO_PAYLOAD = "hello mcp";

// Google provider inactive-status reason from providers.json (collect-models),
// mirroring the sibling specs' skip contract.
function getGoogleSkipReason(): string | undefined {
  const jsonPath = path.resolve(
    __dirname,
    "../../../../helpers/provider-setup/data/providers.json",
  );
  if (!fs.existsSync(jsonPath)) return undefined;
  const records = JSON.parse(fs.readFileSync(jsonPath, "utf-8")) as ProviderRecord[];
  const record = records.find((r) => r.provider === PROVIDER);
  return record?.status === "inactive"
    ? `Provider "${PROVIDER}" inactive — ${record.error}`
    : undefined;
}

let createdFlowId: string | undefined;

async function loadAgent(page: Page, options: LoadSimpleAgentOptions): Promise<void> {
  try {
    createdFlowId = await new SimpleAgentTemplatePage(page).load(options);
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

// Read the persisted agent turn for THIS run's session (keyed by the nonce in
// the user message) from the monitor API — the backend truth, not the live
// Playground bubble (which renders an empty placeholder mid-run and races the
// stream). Returns null until the AI message is persisted, so callers poll on it.
async function fetchPersistedAgentTurn(
  request: APIRequestContext,
  nonce: string,
): Promise<{ replyText: string; echoToolUseCount: number } | null> {
  const bearer = await getAuthToken(request);
  const res = await request.get("/api/v1/monitor/messages", {
    headers: { Authorization: bearer },
  });
  if (res.status() !== 200) return null;
  const messages = await res.json();
  if (!Array.isArray(messages)) return null;

  const userMsg = messages.find(
    (m: any) => m.sender !== "Machine" && (m.text ?? "").includes(nonce),
  );
  if (!userMsg) return null;

  const aiMsgs = messages.filter(
    (m: any) => m.sender === "Machine" && m.session_id === userMsg.session_id,
  );
  if (aiMsgs.length === 0) return null;

  const echoToolUseCount = aiMsgs
    .flatMap((m: any) => (m.content_blocks ?? []) as any[])
    .flatMap((b: any) => (b.contents ?? []) as any[])
    .filter((c: any) => c.type === "tool_use" && /echo/i.test(c.name ?? "")).length;

  const replyText = aiMsgs.map((m: any) => m.text ?? "").join(" ");
  return { replyText, echoToolUseCount };
}

const skipReason = getGoogleSkipReason();
const geminiModel = resolveGeminiModel();

test.describe(`MCP Client – Gemini tool regression (#440) [${PROVIDER} / ${geminiModel ?? "default"}]`, () => {
  test.afterEach(async ({ page }) => {
    const flowId = createdFlowId;
    createdFlowId = undefined;

    await page.goto("/");
    const authHeader = await getAuthToken(page.request);
    const opts = authHeader ? { headers: { Authorization: authHeader } } : undefined;

    try {
      await page.request.delete(`/api/v2/mcp/servers/${MCP_SERVER_NAME}`, opts);
    } catch {
      // best-effort
    }
    if (flowId) {
      await deleteFlow(page.request, flowId, opts);
    }
  });

  test(
    "Gemini runs but invokes no echo MCP tool (guards upstream #440)",
    { tag: ["@mcp", "@agents", "@regression", "@model-provider"] },
    async ({ page, request }) => {
      test.skip(!!skipReason, skipReason ?? "");
      test.skip(
        !hasProviderEnvKeys(PROVIDER),
        `Missing env vars for provider "${PROVIDER}": ${missingProviderEnvKeys(PROVIDER).join(", ")}`,
      );

      // npx server may emit transient backend errors while starting.
      (page as any).allowFlowErrors();

      const nonce = `probe-${process.env.TEST_WORKER_INDEX ?? "0"}-${Date.now()}`;
      const echoPrompt = `Use the 'echo' tool to echo: ${ECHO_PAYLOAD} (${nonce})`;

      await test.step("Load Simple Agent template pinned to Gemini", async () => {
        await loadAgent(page, { provider: PROVIDER, model: geminiModel });
      });

      await test.step("Register everything MCP server and wait for tools", async () => {
        const authHeader = await getAuthToken(page.request);
        await page.request.delete(`/api/v2/mcp/servers/${MCP_SERVER_NAME}`, {
          headers: { Authorization: authHeader },
        });

        await page.getByTestId("sidebar-nav-mcp").click();
        await expect(page.getByTestId("sidebar-add-mcp-server-button")).toBeVisible({
          timeout: 15000,
        });
        await page.getByTestId("sidebar-add-mcp-server-button").click();
        await expect(page.getByTestId("add-mcp-server-button")).toBeVisible({
          timeout: 15000,
        });
        await page.getByTestId("json-tab").click();
        await expect(page.getByTestId("json-input")).toBeVisible({ timeout: 5000 });
        await page.getByTestId("json-input").fill(MCP_JSON_CONFIG);

        await page.getByTestId("add-mcp-server-button").click();
        await expect(page.getByTestId("add-mcp-server-button")).toBeHidden({
          timeout: 10000,
        });

        await expect(
          page.getByTestId(`add-component-button-${MCP_SERVER_NAME}`),
        ).toBeVisible({ timeout: 30000 });

        await expect
          .poll(
            async () => {
              const resp = await page.request.get(
                "/api/v2/mcp/servers?action_count=true",
              );
              const servers: Array<{ name: string; toolsCount: number | null }> =
                await resp.json();
              return servers.find((s) => s.name === MCP_SERVER_NAME)?.toolsCount ?? null;
            },
            { timeout: 90000, intervals: [3000] },
          )
          .not.toBeNull();
      });

      await test.step("Add MCPTools component to canvas", async () => {
        await page.getByTestId(`add-component-button-${MCP_SERVER_NAME}`).click();
        await expect(page.getByTestId("dropdown_str_tool")).toBeVisible({
          timeout: 15000,
        });
        await adjustScreenView(page, { numberOfZoomOut: 3 });
      });

      await test.step("Enable tool mode on MCPTools", async () => {
        const toolsetCountBefore = await page.getByText("toolset").count();
        await page.getByTestId("tool-mode-button").last().click();
        await expect(page.getByText("toolset")).toHaveCount(toolsetCountBefore + 1, {
          timeout: 5000,
        });
      });

      await test.step("Connect MCPTools toolset → Agent tools handle", async () => {
        await page.getByTestId("handle-mcp-shownode-toolset-right").click();
        await page.getByTestId("handle-agent-shownode-tools-left").first().click();
        await expect(page.locator(".react-flow__edge").last()).toBeVisible({
          timeout: 5000,
        });
      });

      await test.step("Open Playground and send echo prompt", async () => {
        await page.getByTestId("playground-btn-flow-io").click();
        const playgroundInput = page.getByTestId("input-chat-playground").last();
        await expect(playgroundInput).toBeVisible({ timeout: 30000 });
        // Atomic set-value + send inside one page.evaluate — the #226 prefill
        // useEffect can otherwise reset chatValue to the Chat Input template
        // default between fill and click. Keep the prompt short and name the
        // tool in single quotes (the reliable MCP-echo phrasing).
        await playgroundInput.clear();
        await playgroundInput.fill(echoPrompt);
        await expect(playgroundInput).toHaveValue(echoPrompt);
        await page.evaluate((value: string) => {
          const inputs = document.querySelectorAll<HTMLTextAreaElement>(
            '[data-testid="input-chat-playground"]',
          );
          const input = inputs[inputs.length - 1];
          const sends = document.querySelectorAll<HTMLButtonElement>(
            '[data-testid="button-send"]',
          );
          const send = sends[sends.length - 1];
          const setter = Object.getOwnPropertyDescriptor(
            HTMLTextAreaElement.prototype,
            "value",
          )?.set;
          if (!setter || !input || !send) {
            throw new Error("Playground input or send button not found in DOM");
          }
          setter.call(input, value);
          input.dispatchEvent(new Event("input", { bubbles: true }));
          send.click();
        }, echoPrompt);
        await expect(
          page.getByText(echoPrompt, { exact: true }).first(),
          "User message in chat must match the echo prompt (not the Chat Input template default)",
        ).toBeVisible({ timeout: 10000 });
      });

      await test.step("#440: agent completes a turn but invokes no echo MCP tool", async () => {
        await waitForAgentToFinish(page);

        // Poll the monitor until the agent turn for this session is persisted —
        // this is both the completion gate and a race-free source of truth.
        let turn: { replyText: string; echoToolUseCount: number } | null = null;
        await expect
          .poll(
            async () => {
              turn = await fetchPersistedAgentTurn(request, nonce);
              return turn ? "persisted" : "waiting";
            },
            { timeout: 60000, intervals: [2000] },
          )
          .toBe("persisted");

        // The pipeline ran end-to-end: the agent produced a final reply that
        // surfaced the echoed payload (proves setup + run + playground worked,
        // so a tool call was genuinely possible — this is NOT the #440 flip).
        expect(
          turn!.replyText,
          "Agent must produce a final reply containing the echoed payload",
        ).toMatch(new RegExp(ECHO_PAYLOAD, "i"));

        // The #440 flip (backend truth, no frontend selector drift): while the
        // bug is OPEN, Gemini invokes NO `echo` MCP tool → count is 0 and this
        // passes. When Langflow FIXES #440, an `echo` tool_use block starts
        // being persisted → count > 0 → this FAILS. A red here means: #440 is
        // fixed — remove this guard and promote Gemini into mcp-client-agent.
        expect(
          turn!.echoToolUseCount,
          "EXPECTED while Langflow #440 is open: Gemini invoked NO 'echo' MCP tool. " +
            "If this fails, #440 is FIXED — promote this guard (see spec doc).",
        ).toBe(0);
      });
    },
  );
});
