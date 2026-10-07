import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import {
  createApiKey,
  deleteApiKey,
} from "../../../../helpers/auth/create-api-key";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { createFlow } from "../../../../helpers/flows/create-flow";
import { createProjectViaApi } from "../../../../helpers/flows/create-project-via-api";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";

/**
 * MCP Server — a flow is exposed as an MCP tool, end to end.
 * Spec doc: `docs/mcp/server/mcp-server-regression.md`.
 *
 * The flow lives in a project of its own (#2198). The tab renders at most 20 tool
 * badges and summarises the rest as `+N more`, and the project listing has no
 * order (insertion order on SQLite), so a flow created in the SHARED default
 * project was never rendered once 20 MCP-enabled flows from parallel specs sat
 * ahead of it — measured: 19 ahead passes, 20 ahead fails with the VM signature.
 */

/** A wired `ChatInput → ChatOutput` flow. */
const CHAT_FLOW_FIXTURE = "tests/assets/flows/chat-io-ok-trace-fixture.json";

test.describe("MCP Server – Flow Exposed as MCP Tool", () => {
  let headers: Record<string, string> = {};
  let flowId = "";
  let projectId = "";
  let deleteProject: ((req?: APIRequestContext) => Promise<void>) | null = null;

  test.afterEach(async ({ page }) => {
    // Flow first, then the project that holds it; both id-scoped. A leak fails
    // the test instead of accumulating on the shared superuser.
    const failures: string[] = [];
    if (flowId) {
      await deleteFlow(page.request, flowId, { headers }).catch((e) =>
        failures.push(`flow ${flowId}: ${e}`),
      );
    }
    if (deleteProject) {
      await deleteProject(page.request).catch((e) =>
        failures.push(`project ${projectId}: ${e}`),
      );
    }
    flowId = "";
    projectId = "";
    deleteProject = null;
    expect(failures, `teardown left state behind: ${failures.join(" | ")}`).toEqual([]);
  });

  test(
    "flow appears as MCP tool in MCP Server tab and endpoint responds",
    { tag: ["@stable", "@mcp", "@regression"] },
    async ({ page }) => {
      let slug = "";

      await test.step("Create a project of its own holding one MCP-enabled ChatInput → ChatOutput flow", async () => {
        headers = { Authorization: await getAuthToken(page.request) };
        const project = await createProjectViaApi(page.request, headers, {
          namePrefix: "e2e-mcp-regression",
          description: "MCP Server – flow exposed as MCP tool (#2198)",
        });
        projectId = project.projectId;
        deleteProject = project.deleteProject;

        // Letters, digits and single spaces only, so the expected tool name is the
        // name lowercased with spaces turned into `_` — `sanitize_mcp_name` changes
        // nothing else about it, and 24 characters stay under both of its cuts.
        const flowName = `E2E MCP ${randomUUID().replace(/-/g, "").slice(0, 16)}`;
        slug = flowName.toLowerCase().replace(/\s+/g, "_");

        const fixture = JSON.parse(readFileSync(CHAT_FLOW_FIXTURE, "utf-8"));
        flowId = await createFlow(
          page.request,
          {
            name: flowName,
            description: "Chat Input -> Chat Output passthrough",
            data: fixture.data,
            is_component: false,
            folder_id: projectId,
            // The column defaults to false (the SPA's `createNewFlow` hardcodes
            // true), and a flow without it is never exposed as a tool.
            mcp_enabled: true,
          },
          { headers },
        );
      });

      await test.step("The backend lists exactly this flow as an MCP-enabled tool of the project", async () => {
        // The request the tab itself makes. Asserted before the UI so a flow the
        // backend never lists fails here, naming the backend half, instead of
        // reading as a tab that did not render it.
        await expect
          .poll(
            async () => {
              const res = await page.request.get(
                `/api/v1/mcp/project/${projectId}?mcp_enabled=false`,
                { headers },
              );
              if (!res.ok()) return `HTTP ${res.status()}`;
              const tools = ((await res.json()).tools ?? []) as Array<{
                id: string;
                mcp_enabled?: boolean;
                action_name?: string;
              }>;
              return tools.map((t) => ({
                id: t.id,
                mcp_enabled: t.mcp_enabled,
                action_name: t.action_name,
              }));
            },
            {
              message: `GET /api/v1/mcp/project/${projectId} must list only flow ${flowId}`,
              timeout: 10000,
            },
          )
          .toEqual([{ id: flowId, mcp_enabled: true, action_name: slug }]);
      });

      await test.step("Open the project's MCP Server tab", async () => {
        await page.goto(`/all/folder/${projectId}`);
        await expect(page.getByTestId("mcp-btn")).toBeVisible({ timeout: 15000 });
        await page.getByTestId("mcp-btn").click();
        await expect(page.getByTestId("mcp-server-title")).toBeVisible({
          timeout: 10000,
        });
      });

      await test.step("The tools list shows this flow's badge and no other", async () => {
        const tools = page.getByTestId("div-mcp-server-tools");
        await expect(tools).toBeVisible({ timeout: 10000 });
        // `tool_<action name>` is the badge's own testid; exactly one badge
        // because the project holds exactly one flow.
        await expect(tools.getByTestId(`tool_${slug}`)).toBeVisible({
          timeout: 30000,
        });
        await expect(tools.getByTestId(/^tool_/)).toHaveCount(1);
      });

      await test.step("Verify the JSON config advertises this project's streamable endpoint", async () => {
        await page.getByRole("button", { name: "JSON" }).click();
        await expect(
          page.getByText(new RegExp(`mcp/project/${projectId}/streamable`)),
        ).toBeVisible({ timeout: 10000 });
      });

      await test.step("Verify the project's streamable endpoint answers JSON-RPC initialize", async () => {
        // The transport takes an API key as `x-api-key` and nothing else (#1522):
        // this POST used to carry no credential at all and assert 200, which
        // 1.12.0.dev31 answered — that build served the transport to anyone, so
        // the assertion passed without exercising auth. On 1.12.0.dev33 a keyless
        // caller is refused with 403.
        const apiKey = await createApiKey(page.request, headers, {
          namePrefix: "e2e-mcp-regression",
        });
        try {
          const initResp = await page.request.post(
            `/api/v1/mcp/project/${projectId}/streamable`,
            {
              headers: {
                "Content-Type": "application/json",
                Accept: "application/json, text/event-stream",
                "x-api-key": apiKey.key,
              },
              data: {
                jsonrpc: "2.0",
                id: 1,
                method: "initialize",
                params: {
                  protocolVersion: "2024-11-05",
                  capabilities: {},
                  clientInfo: { name: "langflow-e2e-test", version: "1" },
                },
              },
            },
          );
          expect(initResp.status()).toBe(200);
        } finally {
          await deleteApiKey(page.request, apiKey.id, headers).catch(() => {});
        }
      });
    },
  );
});
