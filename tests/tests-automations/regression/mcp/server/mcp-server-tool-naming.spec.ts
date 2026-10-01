import { readFileSync } from "fs";
import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { createApiKey, deleteApiKey } from "../../../../helpers/auth/create-api-key";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { createFlow } from "../../../../helpers/flows/create-flow";
import { createProjectViaApi } from "../../../../helpers/flows/create-project-via-api";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import {
  type McpTransportCredential,
  mcpCall,
  mcpHandshake,
} from "../../../../helpers/mcp/mcp-streamable-client";

/**
 * MCP Server — every published tool name is callable (#1411, upstream LE-2657,
 * fixed by langflow-ai/langflow#15179). Spec doc: `docs/mcp/server/mcp-server-tool-naming.md`.
 */

const CHAT_FLOW_FIXTURE = "tests/assets/flows/chat-io-ok-trace-fixture.json";
const MAX_MCP_TOOL_NAME_LENGTH = 30;

const runId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

test.describe("MCP Server — published tool names are callable", () => {
  let headers: Record<string, string>;
  let credential: McpTransportCredential;
  let apiKeyId: string;

  // Per test, so the three triggers never share a project's tool namespace.
  let flowIds: string[] = [];
  let deleteProject: ((req?: APIRequestContext) => Promise<void>) | null = null;
  let projectId = "";

  test.beforeAll(async ({ request }) => {
    const authorization = await getAuthToken(request);
    expect(authorization, "auth token is empty").toBeTruthy();
    headers = { Authorization: authorization };
    const key = await createApiKey(request, headers, { namePrefix: "e2e-mcp-tool-naming" });
    credential = { apiKey: key.key };
    apiKeyId = key.id;
  });

  test.afterEach(async ({ request }) => {
    const failures: string[] = [];
    for (const id of flowIds) {
      await deleteFlow(request, id, { headers }).catch((e) => failures.push(`flow ${id}: ${e}`));
    }
    if (deleteProject) {
      await deleteProject(request).catch((e) => failures.push(`project ${projectId}: ${e}`));
    }
    flowIds = [];
    deleteProject = null;
    expect(failures, `teardown left state behind: ${failures.join(" | ")}`).toEqual([]);
  });

  test.afterAll(async ({ request }) => {
    if (apiKeyId) await deleteApiKey(request, apiKeyId, headers);
  });

  async function newProject(request: APIRequestContext): Promise<string> {
    const project = await createProjectViaApi(request, headers, {
      namePrefix: "e2etn",
      description: "MCP tool naming (#1411)",
    });
    projectId = project.projectId;
    deleteProject = project.deleteProject;
    return `/api/v1/mcp/project/${projectId}/streamable`;
  }

  async function newChatFlow(request: APIRequestContext, name: string): Promise<string> {
    const fixture = JSON.parse(readFileSync(CHAT_FLOW_FIXTURE, "utf-8"));
    const id = await createFlow(
      request,
      { name, description: "Chat Input -> Chat Output passthrough", data: fixture.data, is_component: false, folder_id: projectId },
      { headers },
    );
    flowIds.push(id);
    return id;
  }

  async function expose(
    request: APIRequestContext,
    tools: Array<{ id: string; actionName: string }>,
  ): Promise<void> {
    const res = await request.patch(`/api/v1/mcp/project/${projectId}`, {
      headers,
      data: {
        settings: tools.map((t) => ({
          id: t.id,
          mcp_enabled: true,
          action_name: t.actionName,
          action_description: "E2E tool naming",
        })),
      },
    });
    expect(res.ok(), `PATCH mcp/project answered ${res.status()}: ${await res.text()}`).toBe(true);
  }

  async function publishedNames(request: APIRequestContext, url: string): Promise<string[]> {
    await mcpHandshake(request, url, credential);
    const resp = await mcpCall(request, url, credential, "tools/list", undefined, 2);
    expect(resp.error, JSON.stringify(resp.error)).toBeUndefined();
    return ((resp.result?.tools ?? []) as Array<{ name: string }>).map((t) => t.name).sort();
  }

  /** Calls a published name and asserts the flow echoed the sentinel back. */
  async function callEchoes(
    request: APIRequestContext,
    url: string,
    name: string,
    sentinel: string,
  ): Promise<void> {
    const resp = await mcpCall(request, url, credential, "tools/call", {
      name,
      arguments: { input_value: sentinel },
    }, 3);
    expect(resp.error, JSON.stringify(resp.error)).toBeUndefined();
    expect(
      resp.result?.isError,
      `the server published '${name}' and then refused it: ${resp.result?.content?.[0]?.text}`,
    ).toBe(false);
    expect(resp.result?.content?.[0]?.text).toBe(sentinel);
  }

  test(
    "a tool whose action name exceeds 30 characters is published truncated and can be called",
    { tag: ["@stable", "@api", "@mcp"] },
    async ({ request }) => {
      const url = await newProject(request);
      const actionName = `e2e_tool_naming_long_action_${runId()}`;
      const published = actionName.slice(0, MAX_MCP_TOOL_NAME_LENGTH);

      await test.step("expose a flow under an action name longer than 30 characters", async () => {
        // Fixture guard: the expected name is a plain slice only while the action
        // name is already in sanitize_mcp_name's normal form and over the cap.
        expect(actionName).toMatch(/^[a-z0-9_]+$/);
        expect(actionName.length).toBeGreaterThan(MAX_MCP_TOOL_NAME_LENGTH);
        const id = await newChatFlow(request, `MCP tool naming long ${runId()}`);
        await expose(request, [{ id, actionName }]);
      });

      await test.step("tools/list publishes its first 30 characters", async () => {
        expect(await publishedNames(request, url)).toEqual([published]);
      });

      await test.step("tools/call accepts the published name and runs the flow", async () => {
        await callEchoes(request, url, published, `mcp-tn-long-${runId()}`);
      });
    },
  );

  test(
    "a tool named after a long flow name is published truncated and can be called",
    { tag: ["@stable", "@api", "@mcp"] },
    async ({ request }) => {
      const url = await newProject(request);
      // The MCP Server tab's default action name IS the flow name.
      const flowName = `Customer Support Ticket Triage ${runId()}`;

      await test.step("expose a flow under its own (long, spaced, capitalised) name", async () => {
        const id = await newChatFlow(request, flowName);
        await expose(request, [{ id, actionName: flowName }]);
      });

      await test.step("tools/list publishes the sanitized name cut at 30 characters", async () => {
        expect(await publishedNames(request, url)).toEqual(["customer_support_ticket_triage"]);
      });

      await test.step("tools/call accepts it and runs the flow", async () => {
        await callEchoes(request, url, "customer_support_ticket_triage", `mcp-tn-flowname-${runId()}`);
      });
    },
  );

  test(
    "two tools with the same action name are both callable and each runs its own flow",
    { tag: ["@stable", "@api", "@mcp"] },
    async ({ request }) => {
      const url = await newProject(request);
      const actionName = `same_${runId()}`;
      const ids: string[] = [];
      const sentinels: Record<string, string> = {};

      await test.step("expose two flows under the same action name", async () => {
        ids.push(await newChatFlow(request, `MCP tool naming dup A ${runId()}`));
        ids.push(await newChatFlow(request, `MCP tool naming dup B ${runId()}`));
        await expose(request, ids.map((id) => ({ id, actionName })));
      });

      await test.step("tools/list publishes the name and a de-duplicated _1", async () => {
        expect(await publishedNames(request, url)).toEqual([actionName, `${actionName}_1`]);
      });

      await test.step("both published names are accepted and run", async () => {
        for (const name of [actionName, `${actionName}_1`]) {
          sentinels[name] = `mcp-tn-${name}-${runId()}`;
          await callEchoes(request, url, name, sentinels[name]);
        }
      });

      await test.step("each published name ran a different flow", async () => {
        const all = Object.values(sentinels);
        const heldBy = await Promise.all(
          ids.map(async (id) => {
            const res = await request.get(`/api/v1/monitor/messages?flow_id=${id}`, { headers });
            expect(res.ok(), `GET monitor/messages answered ${res.status()}`).toBe(true);
            const texts = ((await res.json()) as Array<{ text?: string }>).map((m) => m.text ?? "");
            return all.filter((s) => texts.includes(s));
          }),
        );
        expect(heldBy[0], "flow A must hold exactly one of the two calls").toHaveLength(1);
        expect(heldBy[1], "flow B must hold exactly one of the two calls").toHaveLength(1);
        expect(heldBy[0][0], "both names reached the same flow").not.toBe(heldBy[1][0]);
      });
    },
  );
});
