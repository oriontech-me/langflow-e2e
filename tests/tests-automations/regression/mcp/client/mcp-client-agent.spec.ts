import * as dotenv from "dotenv";
import path from "path";
import type { Page } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import type { LoadSimpleAgentOptions } from "../../../../pages";
import {
  hasProviderEnvKeys,
  langflowProviderName,
  missingProviderEnvKeys,
  providerConfigMap,
  providerSetupMap,
  type Provider,
} from "../../../../helpers/provider-setup";
import {
  classifyCredentialSettle,
  formatCredentialSettleFailure,
  readAgentCredentialProbe,
  type AgentCredentialProbe,
} from "../../../../helpers/flows/agent-credential-settle";
import { resolveTestTargets } from "../../../../helpers/provider-setup/test-targets";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import { loadTemplateByName } from "../../../../helpers/flows/load-template-by-name";
import { adjustScreenView } from "../../../../helpers/ui/adjust-screen-view";
import { hideInspectorPanel } from "../../../../helpers/ui/hide-inspector-panel";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";

if (!process.env.CI) {
  dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });
}

// Worker- and timestamp-suffixed name prevents cross-file races with
// mcp-client-regression.spec.ts (which also registers an "everything" MCP server).
// File-level serial mode does not serialize across workers.
const MCP_SERVER_NAME = `everything-${process.env.TEST_WORKER_INDEX ?? "0"}-${Date.now()}`;
const MCP_JSON_CONFIG = JSON.stringify({
  mcpServers: {
    [MCP_SERVER_NAME]: {
      command: "npx",
      args: ["@modelcontextprotocol/server-everything"],
    },
  },
});

// Id of the flow the running test created; teardown deletes only this one via
// the API (scoped) — never a global cleanAllFlows, which wipes flows other
// parallel workers are actively building mid-run (#515).
let createdFlowId: string | undefined;

// Picks the pinned model from the Agent dropdown without opening the Model Providers
// panel, whose setup enables EVERY model of the provider — each enable runs a live
// synchronous credential validation that blocks the single-worker backend for ~35s when
// the provider throttles it (#922/#927). Returns false when the model is not offered.
async function selectPinnedModel(page: Page, model: string): Promise<boolean> {
  await hideInspectorPanel(page);
  // With no provider configured (fresh instance), 1.12 renders a "Setup Provider"
  // button instead of the model dropdown — that state must fall back to the shared
  // provider setup, not throw.
  const trigger = page.getByTestId("model_model");
  const triggerVisible = await trigger
    .waitFor({ state: "visible", timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  if (!triggerVisible) return false;
  await trigger.click();

  const option = page.locator('[data-testid$="-option"]', {
    hasText: new RegExp(`^${model}$`),
  });
  if (!(await option.isVisible({ timeout: 10000 }).catch(() => false))) {
    await page.keyboard.press("Escape");
    return false;
  }
  await option.click();
  return true;
}

/** Budget for the settle guard below — the pre-#1371 value, deliberately unchanged. */
const CREDENTIAL_SETTLE_TIMEOUT_MS = 20_000;

/**
 * Block until the Agent node's persisted **provider binding** has settled (#751).
 *
 * The race is real and unchanged: the node mounts on the model selector's DEFAULT
 * model — measured `{ name: "claude-opus-5", provider: "Anthropic" }` — and only
 * flips to the requested one once the editor's debounced autosave
 * `PATCH /api/v1/flows/{id}` carries the pick. A caller that reaches the Playground
 * in between runs the wrong provider's model with the wrong provider's key.
 *
 * **The axis is the provider, never `api_key` (#1371).** This function used to
 * assert `template.api_key.value === "<PROVIDER>_API_KEY"`, and upstream
 * [#14311](https://github.com/langflow-ai/langflow/pull/14311) deleted the block
 * that wrote it. Measured on `1.12.0.dev19` before this change: `Expected
 * "OPENAI_API_KEY" / Received ""`, 3 runs out of 3, always inside the load step —
 * the field is empty from mount onward on every build, so the transition could
 * only ever time out. This was the THIRD copy of that premise: #1274 migrated the
 * shared helper and 19 `@stable` specs with it, #1334 migrated the inline copy in
 * `openai-compatible-provider-setup.spec.ts`, and this one survived both because
 * its sweep grepped `credential:`, a spelling this file never used.
 *
 * The provider is not a weaker proxy: with `api_key` empty the runtime resolves the
 * key FROM it — `instantiation.py` reads `model.value[0].provider` and calls
 * `get_api_key_for_provider`, which falls through to
 * `get_provider_secret_variable_key(provider)`.
 *
 * Classification and the failure text come from the SHARED module so this file
 * cannot drift off the axis again; only the wait loop is local, because this spec
 * loads the agent its own way (see `loadAgent`).
 */
async function waitForAgentCredentialSettled(
  page: Page,
  flowId: string,
  expectedProvider: string,
  expectedModel?: string,
): Promise<void> {
  const auth = await getAuthToken(page.request);
  const headers = auth ? { Authorization: auth } : undefined;

  const startedAt = Date.now();
  let probe: AgentCredentialProbe | null = null;
  let reads = 0;
  let lastReadError: string | undefined;

  try {
    await expect(async () => {
      let flow: unknown;
      try {
        const res = await page.request.get(`/api/v1/flows/${flowId}`, { headers });
        expect(res.ok()).toBe(true);
        flow = await res.json();
      } catch (e: any) {
        // Tracked, not swallowed: a guard that never managed to READ the flow must
        // not report "the binding is wrong" about a payload nobody saw (#1261).
        lastReadError = e?.message ?? String(e);
        throw e;
      }
      reads += 1;
      lastReadError = undefined;
      probe = readAgentCredentialProbe(flow);
      expect(classifyCredentialSettle(probe, expectedProvider, expectedModel)).toBe(
        "settled",
      );
    }).toPass({
      timeout: CREDENTIAL_SETTLE_TIMEOUT_MS,
      intervals: [500, 1000, 2000],
    });
  } catch {
    // Re-thrown as the shared, self-describing diagnostic. A bare `toBe` mismatch
    // here reads as a provider-wiring bug and was triaged as one twice (#1072).
    throw new Error(
      formatCredentialSettleFailure({
        flowId,
        provider: expectedProvider,
        expectedProvider,
        expectedModel,
        probe,
        verdict:
          reads === 0
            ? "read-failed"
            : classifyCredentialSettle(probe, expectedProvider, expectedModel),
        elapsedMs: Date.now() - startedAt,
        reads,
        lastReadError,
      }),
    );
  }
}

async function loadAgent(page: Page, options: LoadSimpleAgentOptions): Promise<void> {
  const provider = options.provider ?? (Object.keys(providerConfigMap)[0] as Provider);
  try {
    createdFlowId = await loadTemplateByName(page, "Simple Agent");
    await adjustScreenView(page);

    // Fall back to the shared setup when the model is not selectable yet — that path
    // also configures the provider credential from scratch.
    const picked = options.model
      ? await selectPinnedModel(page, options.model)
      : false;
    if (!picked) {
      await providerSetupMap[provider](page, options.model);
    }

    // Langflow's own spelling of the provider — the payload never carries this
    // repo's `Provider` key, so the comparison has to go through the mapper.
    await waitForAgentCredentialSettled(
      page,
      createdFlowId,
      langflowProviderName(provider),
      options.model,
    );
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

const targets = resolveTestTargets({ tier: "tool-calling" });

// Serial mode prevents parallel provider blocks from racing autosaves of the
// template flow. (load() no longer deletes all flows — that cross-worker wipe
// was removed in #553; teardown is now scoped per created flow, #515.)
test.describe.configure({ mode: "serial" });

for (const { label, options, skipReason } of targets) {
  const provider = options.provider ?? (Object.keys(providerConfigMap)[0] as Provider);

  test.describe(`MCP Client – Agent using MCPTools [${label}]`, () => {
    test.afterEach(async ({ page }) => {
      const flowId = createdFlowId;
      createdFlowId = undefined;

      // Navigate off the editor first so the unmounted flow page stops polling
      // the flow we are about to delete. The auth header is reused for both the
      // MCP server cleanup and the flow deletion — page.request is
      // unauthenticated under AUTO_LOGIN and would 401 otherwise.
      await page.goto("/");
      const authHeader = await getAuthToken(page.request);
      const opts = authHeader
        ? { headers: { Authorization: authHeader } }
        : undefined;

      try {
        await page.request.delete(`/api/v2/mcp/servers/${MCP_SERVER_NAME}`, opts);
      } catch {
        // best-effort
      }

      // Delete ONLY the flow this test created (scoped teardown, #515). Not
      // swallowed: a failed cleanup surfaces instead of silently leaking (#547).
      if (flowId) {
        await deleteFlow(page.request, flowId, opts);
      }
    });

    test(
      "agent calls echo MCP tool and returns echoed message",
      { tag: ["@mcp", "@agents", "@regression"] },
      async ({ page }) => {
        test.skip(!!skipReason, skipReason ?? "");
        test.skip(
          !hasProviderEnvKeys(provider),
          `Missing env vars for provider "${provider}": ${missingProviderEnvKeys(provider).join(", ")}`,
        );

        // Allow backend errors — npx server may return transient errors while starting
        (page as any).allowFlowErrors();

        await test.step("Load Simple Agent template", async () => {
          await loadAgent(page, options);
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
          // Verify a new toolset badge appeared after enabling tool mode on MCPTools
          await expect(page.getByText("toolset")).toHaveCount(toolsetCountBefore + 1, {
            timeout: 5000,
          });
        });

        await test.step("Connect MCPTools toolset → Agent tools handle", async () => {
          // The MCPTools node testid uses "mcp" (not "mcp tools") when normalized
          await page
            .getByTestId("handle-mcp-shownode-toolset-right")
            .click();
          await page
            .getByTestId("handle-agent-shownode-tools-left")
            .first()
            .click();
          await expect(page.locator(".react-flow__edge").last()).toBeVisible({ timeout: 5000 });
        });

        await test.step("Open Playground and send echo prompt", async () => {
          await page.getByTestId("playground-btn-flow-io").click();
          const playgroundInput = page.getByTestId("input-chat-playground").last();
          await expect(playgroundInput).toBeVisible({ timeout: 30000 });
          // Cross-version Playground hardening for issue #226.
          //
          // Root cause on Langflow < 1.10.x: in flow-page-sliding-container.tsx the
          // prefill useEffect has `inputs` and `nodes` in its dep array (renders
          // produce new array refs, so the effect re-fires repeatedly). When the
          // textarea is filled via Playwright and we then `.click()` send, the
          // useEffect can re-execute in between and reset `chatValue` back to the
          // Chat Input node's template `input_value` ("Hello, how are you?"), so
          // the send dispatches the stale value even though the textarea displayed
          // our prompt.
          //
          // Per issue acceptance criteria we keep `.clear()` + `.fill()` +
          // `toHaveValue()` so the surface contract is met. Then we run the actual
          // send as an *atomic* DOM operation inside a single `page.evaluate` — set
          // the textarea value, dispatch the synthetic `input` event so React's
          // controlled component picks up the change, and call `.click()` on the
          // send button in the same synchronous tick. React useEffects only run
          // after the current task completes, so the prefill cannot race the click.
          //
          // Keep the prompt minimal and direct — empirically, gpt-4o-mini is most
          // reliable at calling the echo tool when the prompt is short and uses the
          // exact tool name in single quotes. Longer prompts that enumerate forbidden
          // tools increase refusal rate (the model second-guesses the instruction).
          const echoPrompt = "Use the 'echo' tool to echo: hello mcp";
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
          // Verify the user message that reached the chat history is the echo prompt
          // (not the Chat Input template default). Catches any residual race loudly.
          await expect(
            page.getByText(echoPrompt, { exact: true }).first(),
            "User message in chat must match the echo prompt (not the Chat Input template default)",
          ).toBeVisible({ timeout: 10000 });
        });

        await test.step("Verify agent invoked the echo MCP tool and returned echoed text", async () => {
          await waitForAgentToFinish(page);

          // Proof #1: the agent actually INVOKED a tool.
          //
          // `tool-status-done` (`chatComponents/ToolCallCard.tsx`) is rendered
          // per tool CALL — `ContentBlockDisplay` mounts a `ToolCallCard` only
          // under `if (run.item.type === "tool_use")`. That is the whole point
          // of this assertion, and the two test ids it replaced could not carry
          // it (#1793).
          //
          // WHAT THIS REPLACED, and why it was a no-op. Proofs #1 and #2 used
          // to assert `div-tools_tools_metadata` and `tool_echo` with an
          // unscoped `.last()`, on the premise that "this DOM only exists after
          // the agent invoked a tool". It does not: both come from
          // `parameterRenderComponent/components/ToolsComponent/index.tsx` —
          // `data-testid={"div-" + id}` and a `<Badge>` per entry of
          // `visibleActions` — i.e. the `tools_metadata` FIELD of the MCPTools
          // NODE on the canvas, which stays mounted behind the Playground modal
          // and is matched by an unscoped locator (Playwright visibility is a
          // bounding box, not "on top"). They enumerate the tools ATTACHED to
          // the component and exist BEFORE any run. Measured on the sibling
          // spec at 1.12.1 (#1451/PR #1792): an agent instructed never to call
          // a tool still rendered both, with no `tool_use` block persisted, and
          // the equivalent assertions PASSED.
          //
          // NO "expand the Steps accordion" step. This Playground renders
          // through `bot-message.tsx`, which passes `hideHeader={true}` to
          // `ContentBlockDisplay` — so no "Steps"/"Finished" header exists to
          // click, and the `{(hideHeader || isExpanded) && …}` gate that hides
          // GROUPED tool cards behind that chevron is satisfied unconditionally
          // here. Measured: on a run with a completed tool call, zero rows
          // matched the old helper's selector while `tool-status-done` was
          // already present. (The other call site, `chat-message.tsx`, does not
          // pass `hideHeader` and would need the chevron — which is why the
          // helper existed at all.)
          const completedToolSteps = page
            .getByTestId("tool-status-done")
            .locator("xpath=..");
          await expect(
            completedToolSteps.first(),
            "Playground must show a COMPLETED tool step (`tool-status-done`). " +
              "Either the agent invoked no tool at all, or the call it made " +
              "errored (`tool-status-error`, which wins over a duration), or it " +
              "never resolved (`tool-status-running`, no duration attached)",
          ).toBeVisible({ timeout: 120000 });

          // Proof #2: the tool called was 'echo'.
          //
          // The status dot's parent is the title cell, whose text is the tool
          // NAME alone (the duration is a sibling). `formatToolTitle` replaces
          // `_` with a space and uppercases IN JS — not CSS `text-transform` —
          // so the row's textContent really is matchable; the pattern is
          // tolerant of both spellings rather than pinning the display form.
          await expect(
            completedToolSteps.filter({ hasText: /\becho\b/i }).first(),
            "The MCP tool invoked must be 'echo' — agent picked a different tool from the everything server",
          ).toBeVisible({ timeout: 5000 });

          // Proof #3: the echoed payload appears in the agent's final response,
          // confirming the round-trip through the MCP echo tool returned the
          // expected text (and the agent surfaced it instead of dropping it).
          // The AI message container is `chat-message-AI-<text>` on 1.12 (was the
          // now-removed `div-chat-message`).
          const lastAiMessage = page
            .locator('[data-testid^="chat-message-AI-"]')
            .last();
          await expect(lastAiMessage).toBeVisible({ timeout: 30000 });
          await expect(
            lastAiMessage,
            "Agent response must contain 'hello mcp' (text echoed back through the MCP echo tool)",
          ).toContainText(/hello mcp/i, { timeout: 60000 });
        });
      },
    );
  });
}
