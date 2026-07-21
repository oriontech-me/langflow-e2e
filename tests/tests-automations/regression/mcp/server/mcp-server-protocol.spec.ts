import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import {
  createRunnableChatFlowViaApi,
  type RunnableChatFlow,
} from "../../../../helpers/flows/create-runnable-chat-flow-via-api";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import { mcpCall, mcpHandshake } from "../../../../helpers/mcp/mcp-streamable-client";

/**
 * MCP Server — flow-as-server endpoint & tool execution over the MCP protocol
 * (QA-CHECKLIST §14.1, the two coverable items: "Flow exposed as MCP server —
 * verify generated endpoint" and "Execute MCP server tool via MCP protocol").
 *
 * A ChatInput -> ChatOutput passthrough flow is created via API and enabled as
 * an MCP tool on the default project. The test then speaks the real MCP protocol
 * to the project's generated streamable endpoint:
 *   T1 — the generated endpoint advertises this project and lists the enabled
 *        flow (composer-url shapes + initialize serverInfo + tools/list).
 *   T2 — tools/call runs the flow and echoes a unique sentinel back through the
 *        protocol (deterministic, no LLM).
 *
 * §14.1 resource-by-URI and prompt-template are NOT covered: Langflow's MCP
 * server exposes flows only as tools — resources/list and prompts/list return []
 * on 1.11.0.dev49 (no product surface). See docs/mcp/server/mcp-server-protocol.md.
 *
 * `@stable` withheld — promotion gated (#829; MCP flaky cluster #773, surface
 * deps #809/#643).
 */

// Shared project MCP settings are instance-wide; run serially so a second
// project-MCP spec (if added) can't race this one's tool namespace.
test.describe.configure({ mode: "serial" });

test.describe("MCP Server — flow-as-server protocol", () => {
  let authorization: string;
  let projectId: string;
  let streamableUrl: string;
  let flow: RunnableChatFlow;
  const actionName = `e2e_echo_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

  test.beforeAll(async ({ request }) => {
    authorization = await getAuthToken(request);
    const headers = { Authorization: authorization };

    // Default project ("Starter Project") — its id is the MCP project id.
    const projectsRes = await request.get("/api/v1/projects/", { headers });
    expect(projectsRes.ok()).toBeTruthy();
    const projects = await projectsRes.json();
    const list = Array.isArray(projects) ? projects : projects.items ?? [];
    expect(list.length).toBeGreaterThan(0);
    projectId = list[0].id;
    streamableUrl = `/api/v1/mcp/project/${projectId}/streamable`;

    // Deterministic passthrough flow (ChatInput -> ChatOutput, echoes input).
    flow = await createRunnableChatFlowViaApi(request, headers);

    // Expose it as an MCP tool on the project (merges into existing settings).
    const patchRes = await request.patch(`/api/v1/mcp/project/${projectId}`, {
      headers,
      data: {
        settings: [
          {
            id: flow.flowId,
            mcp_enabled: true,
            action_name: actionName,
            action_description: "E2E passthrough echo tool",
          },
        ],
      },
    });
    expect(patchRes.ok()).toBeTruthy();
  });

  test.afterAll(async ({ request }) => {
    // Deleting the flow removes it from the project's exposed tools. Use the
    // afterAll's own live `request` (Playwright forbids reusing the beforeAll
    // one) and the id captured at setup.
    if (flow?.flowId) {
      await deleteFlow(request, flow.flowId, {
        headers: { Authorization: authorization },
      }).catch(() => {});
    }
  });

  test(
    "generated endpoint advertises the project and lists the enabled flow",
    { tag: ["@regression", "@api", "@mcp"] },
    async ({ request }) => {
      await test.step("composer-url returns the generated endpoint URLs", async () => {
        const res = await request.get(
          `/api/v1/mcp/project/${projectId}/composer-url`,
          { headers: { Authorization: authorization } },
        );
        expect(res.ok()).toBeTruthy();
        const body = await res.json();
        expect(body.streamable_http_url).toContain(
          `/api/v1/mcp/project/${projectId}/streamable`,
        );
        expect(body.legacy_sse_url).toContain(
          `/api/v1/mcp/project/${projectId}/sse`,
        );
      });

      await test.step("initialize identifies this project's MCP server", async () => {
        const info = await mcpHandshake(request, streamableUrl, authorization);
        expect(info.serverInfo.name).toBe(`langflow-mcp-project-${projectId}`);
      });

      await test.step("tools/list exposes the enabled flow", async () => {
        const resp = await mcpCall(
          request,
          streamableUrl,
          authorization,
          "tools/list",
          undefined,
          2,
        );
        const names: string[] = (resp.result?.tools ?? []).map(
          (t: { name: string }) => t.name,
        );
        expect(names).toContain(actionName);
      });
    },
  );

  test(
    "execute the exposed tool over the MCP protocol echoes the input",
    { tag: ["@regression", "@api", "@mcp"] },
    async ({ request }) => {
      // Unique sentinel: a canned/empty/cached response cannot echo this exact
      // string, so a pass proves the call round-tripped through the flow.
      const sentinel = `mcp-echo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      await mcpHandshake(request, streamableUrl, authorization);

      const resp = await mcpCall(
        request,
        streamableUrl,
        authorization,
        "tools/call",
        { name: actionName, arguments: { input_value: sentinel } },
        3,
      );

      expect(resp.error, JSON.stringify(resp.error)).toBeUndefined();
      expect(resp.result?.isError).toBe(false);
      const text: string = resp.result?.content?.[0]?.text ?? "";
      expect(text).toBe(sentinel);
    },
  );
});
