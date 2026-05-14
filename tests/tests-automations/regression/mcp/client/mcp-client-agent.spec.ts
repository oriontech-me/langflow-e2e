import * as dotenv from "dotenv";
import path from "path";
import fs from "fs";
import type { Page } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { SimpleAgentTemplatePage, type LoadSimpleAgentOptions } from "../../../../pages";
import {
  hasProviderEnvKeys,
  missingProviderEnvKeys,
  providerConfigMap,
  type Provider,
} from "../../../../helpers/provider-setup";
import type { ProviderRecord } from "../../../../helpers/provider-setup/collect-models";
import { cleanAllFlows } from "../../../../helpers/flows/clean-all-flows";
import { adjustScreenView } from "../../../../helpers/ui/adjust-screen-view";

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
  if (!fs.existsSync(jsonPath)) return new Map();
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
  if (!fs.existsSync(jsonPath)) return [];
  return JSON.parse(fs.readFileSync(jsonPath, "utf-8")) as ModelRecord[];
}

function getTestTargets(): TestTarget[] {
  const skipReasons = getProviderSkipReasons();

  if (process.env.MODEL_TEST_ID) {
    const model = process.env.MODEL_TEST_ID;
    const allModels = getModelsFromJson();
    const record = allModels.find((m) => m.model === model);
    const provider = record?.provider as Provider | undefined;
    return [{
      label: `model:${model}`,
      options: { provider, model },
      skipReason: provider ? skipReasons.get(provider) : undefined,
    }];
  }

  const allModels = getModelsFromJson();
  if (allModels.length === 0) {
    const fallbackProvider = Object.keys(providerConfigMap)[0] as Provider;
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

async function loadAgent(page: Page, options: LoadSimpleAgentOptions): Promise<void> {
  try {
    await new SimpleAgentTemplatePage(page).load(options);
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

const targets = getTestTargets();

// SimpleAgentTemplatePage.load() deletes all flows before loading the template.
// Serial mode prevents parallel provider blocks from wiping each other's flows.
test.describe.configure({ mode: "serial" });

for (const { label, options, skipReason } of targets) {
  const provider = options.provider ?? (Object.keys(providerConfigMap)[0] as Provider);

  test.describe(`MCP Client – Agent using MCPTools [${label}]`, () => {
    test.afterEach(async ({ page }) => {
      try {
        const token = await page.request
          .post("/api/v1/login", {
            form: { username: "langflow", password: "langflow" },
          })
          .then((r) => r.json())
          .then((d) => d.access_token as string);
        await page.request.delete(`/api/v2/mcp/servers/${MCP_SERVER_NAME}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
      } catch {
        // best-effort
      }
      try {
        await page.goto("/");
        await cleanAllFlows(page);
      } catch {
        // best-effort
      }
    });

    test(
      "agent calls echo MCP tool and returns echoed message",
      { tag: ["@mcp", "@agents", "@regression", "@stable"] },
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
          const token = await page.request
            .post("/api/v1/login", {
              form: { username: "langflow", password: "langflow" },
            })
            .then((r) => r.json())
            .then((d) => d.access_token as string);
          await page.request.delete(`/api/v2/mcp/servers/${MCP_SERVER_NAME}`, {
            headers: { Authorization: `Bearer ${token}` },
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
          const echoPrompt = "Use the echo tool to echo: hello mcp";
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

        await test.step("Verify agent response contains echoed message", async () => {
          await waitForAgentToFinish(page);
          // `div-chat-message` is rendered only for AI messages in the Langflow chat-message
          // component (the `!chat.isSend` branch in chat-message.tsx renders this testid;
          // user messages render the `chat-message-{sender_name}-{content}` testid only and
          // never `div-chat-message`). Polling with toContainText guards against the agent
          // still streaming when waitForAgentToFinish returns early (Stop button never appeared).
          const lastAiMessage = page.getByTestId("div-chat-message").last();
          await expect(lastAiMessage).toBeVisible({ timeout: 30000 });
          await expect(lastAiMessage, "Agent response must contain 'hello mcp' (echoed via MCP tool)").toContainText(
            /hello mcp/i,
            { timeout: 60000 },
          );
        });
      },
    );
  });
}
