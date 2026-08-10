import * as dotenv from "dotenv";
import path from "path";
import type { Page, APIRequestContext } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { SimpleAgentTemplatePage, type LoadSimpleAgentOptions } from "../../../../pages";
import { hasProviderEnvKeys, missingProviderEnvKeys } from "../../../../helpers/provider-setup";
import { providerSkipReasons } from "../../../../helpers/provider-setup/provider-health";
import { resolveGeminiModel } from "../../../../helpers/provider-setup/resolve-gemini-model";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import { adjustScreenView } from "../../../../helpers/ui/adjust-screen-view";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";

/**
 * MCP Client – Gemini tool-calling regression (upstream Langflow #440).
 *
 * Covers the Gemini × MCP tool-calling path IN ISOLATION. Historically (1.11.0,
 * gemini-2.5-flash) Gemini called native Langflow tools (URL, Web Search,
 * Calculator) but silently did NOT invoke MCP tools (`echo`) — bug #440. The
 * generic mcp-client-agent.spec.ts could not surface Gemini specifically: its
 * provider variants share a file-scope `mode: "serial"` group where an earlier
 * variant's failure SKIPS the later ones, so the Gemini variant could be masked.
 * This file is deliberately standalone (no shared serial group), pins Gemini and
 * names it in the title (self-attributing signal).
 * See docs/mcp/client/mcp-client-agent-gemini-tool-regression.md.
 *
 * DIRECTION OF THE ASSERT (read before "fixing" this test):
 * #440 is FIXED as of Langflow 1.12.0.dev5 (validated under #947, gemini-flash-
 * latest, 3/3 deterministic). This test now asserts the FIXED behavior — the
 * agent runs, answers, AND invokes the `echo` MCP tool at least once — via the
 * monitor API (backend truth, immune to frontend selector drift). It is a
 * forward regression: it FLIPS RED if Langflow ever regresses Gemini × MCP
 * tool-calling (echo tool_use count drops back to 0). `test.fail()` was
 * deliberately rejected: it converts ANY failure (a broken bootstrap, a down
 * instance, an unregistered MCP server) into a green "expected failure", masking
 * real breakage. Here the setup asserts stay LOUD: infra breakage goes red.
 */

if (!process.env.CI) {
  dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });
}

// Worker- and timestamp-suffixed name prevents cross-file races with the other
// specs that also register an "everything" MCP server.
// Langflow silently truncates a registered MCP server name to 30 chars. A
// base-10 `Date.now()` suffix pushed `everything-gemini-<worker>-<ts>` to 33
// chars, so the stored name was truncated and the sidebar testid
// (`add-component-button-<name>`) never matched the full name — the spec timed
// out registering the server, and afterEach then failed to delete it (leaking an
// orphan MCP server). A base-36 timestamp keeps the name ≤ 30 chars.
const MCP_SERVER_NAME = `everything-gemini-${process.env.TEST_WORKER_INDEX ?? "0"}-${Date.now().toString(36)}`;
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

const skipReason = providerSkipReasons().get(PROVIDER);
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
    "Gemini invokes the echo MCP tool (regression for fixed upstream #440)",
    // `@stable` was auto-removed by the daily of 2026-08-10 (commit c954cd9, run
    // 31373880200) on a failure that never ran this test: the shard's own
    // `collect-models.spec.ts` rewrote `models.json` after the runner had computed
    // this file's titles, so the worker could not find the test by title
    // (`duration 0`, `workerIndex -1`, no browser). Restored with the cause fixed at
    // the source — the catalog is now frozen per run, see
    // `helpers/provider-setup/catalog-snapshot.ts` (#1386) — and the assertion itself
    // re-validated 3/3 with `--retries=0` on 1.12.0.dev22 with google configured.
    { tag: ["@mcp", "@agents", "@regression", "@model-provider", "@stable"] },
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

      await test.step("#440 (fixed): agent completes a turn and invokes the echo MCP tool", async () => {
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

        // The #440 fix (backend truth, no frontend selector drift): #440 is
        // FIXED, so Gemini persists at least one `echo` MCP tool_use block for
        // this turn → count > 0. This is a forward regression: if Langflow ever
        // regresses Gemini × MCP tool-calling, the count drops back to 0 and
        // this FAILS loudly (see spec doc / header for the #440 history).
        expect(
          turn!.echoToolUseCount,
          "Gemini must invoke the 'echo' MCP tool at least once (regression for fixed #440). " +
            "A 0 count means Gemini × MCP tool-calling regressed to the #440 state.",
        ).toBeGreaterThan(0);
      });
    },
  );
});
