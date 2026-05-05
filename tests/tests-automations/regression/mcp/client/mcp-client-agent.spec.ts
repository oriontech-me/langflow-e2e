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

const MCP_SERVER_NAME = "everything";
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
          await expect(
            page.getByTestId("input-chat-playground").last(),
          ).toBeVisible({ timeout: 30000 });
          await page
            .getByTestId("input-chat-playground")
            .last()
            .fill("Use the echo tool to echo: hello mcp");
          await page.getByTestId("button-send").last().click();
        });

        await test.step("Verify agent response contains echoed message", async () => {
          await waitForAgentToFinish(page);
          const lastMessage = page.getByTestId("div-chat-message").last();
          await expect(lastMessage).toBeVisible({ timeout: 30000 });
          const responseText = await lastMessage.innerText();
          expect(
            responseText.toLowerCase(),
            "Agent response must contain 'hello mcp' (echoed via MCP tool)",
          ).toContain("hello mcp");
        });
      },
    );
  });
}
