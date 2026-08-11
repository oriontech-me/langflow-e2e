import { readFileSync } from "fs";
import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { createFlow } from "../../../../helpers/flows/create-flow";
import { createProjectViaApi } from "../../../../helpers/flows/create-project-via-api";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import {
  mcpCall,
  mcpHandshake,
} from "../../../../helpers/mcp/mcp-streamable-client";

/**
 * MCP Server — per-project tool exposure (QA-CHECKLIST §14.1, #1396).
 * Spec doc: `docs/mcp/server/mcp-server-project-config.md`.
 *
 * The selection surface: `PATCH /api/v1/mcp/project/{id}` decides which of a
 * project's flows are exposed as MCP tools, `GET` reads that selection back, and
 * the project's own streamable endpoint is what an MCP client actually sees.
 *
 * Two things make this more than a REST round trip:
 *
 *  - **The de-selection assertion is made over the protocol**, not against the
 *    REST listing the UI renders. They are different code paths — the REST
 *    endpoint filters in its own query, while the MCP server registers
 *    `handle_list_project_tools` with `mcp_enabled_only=True` — so asserting the
 *    REST side would not prove what a client discovers, which is the bullet.
 *  - **The positive case is anchored with a `tools/call`.** A build that listed
 *    a tool it could not run would pass a containment-only test.
 *
 * NOT asserted, and #1408 is why: `tools/call` on a **de-selected** flow still
 * runs it (measured on 1.12.0.dev20 — `isError: false`, and not a cache: a tool
 * never called while enabled behaves the same, while an unknown name answers
 * `Flow with name '…' not found`). `handle_call_tool` resolves by action name and
 * never reads `mcp_enabled`, so the selection is a discovery control only.
 * Asserting the corrected behaviour would ship a durably red `@stable` test.
 *
 * Everything runs against a project this spec creates, so it cannot race
 * `mcp-server-protocol.spec.ts` — which mutates the DEFAULT project's MCP
 * settings and carries a comment anticipating exactly this second spec.
 */

// Serial: test 1 leaves the flow exposed and test 2 starts from that state,
// then withdraws it. The two halves of one selection lifecycle, split so a
// failure names which half broke.
test.describe.configure({ mode: "serial" });

// The same passthrough flow the protocol spec runs (Chat Input -> Chat Output,
// no LLM, echoes its input verbatim).
const CHAT_FLOW_FIXTURE = "tests/assets/flows/chat-io-ok-trace-fixture.json";

/**
 * Create the passthrough flow INSIDE a given project.
 *
 * File-local rather than an extension of `createRunnableChatFlowViaApi`, which
 * takes no `folder_id`: that helper has 29 call sites across 21 specs, and the
 * import-graph selection (#1054) would pull every one of them into this PR's
 * impacted-E2E lane in exchange for two lines. Same fixture, same `createFlow`.
 */
async function createChatFlowInProject(
  request: APIRequestContext,
  headers: Record<string, string>,
  projectId: string,
): Promise<string> {
  const fixture = JSON.parse(readFileSync(CHAT_FLOW_FIXTURE, "utf-8"));
  // Unique name: Langflow enforces unique flow names per user and its auto-rename
  // fallback is not transaction-safe (#588) — same convention as the shared helper.
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  return createFlow(
    request,
    {
      name: `MCP project-config flow ${unique}`,
      description: "Chat Input -> Chat Output passthrough for MCP exposure tests",
      data: fixture.data,
      is_component: false,
      folder_id: projectId,
    },
    { headers },
  );
}

test.describe("MCP Server — per-project tool exposure", () => {
  let authorization: string;
  let headers: Record<string, string>;
  let projectId: string;
  let deleteProjectFn: (req?: APIRequestContext) => Promise<void>;
  let flowId: string;
  let streamableUrl: string;

  // Unique per run, and a valid MCP tool name (snake_case): `tools/list`
  // containment is then an assertion about THIS run's flow.
  //
  // Deliberately SHORT. The protocol does not serve `action_name` verbatim — it
  // serves `get_unique_name(sanitize_mcp_name(action_name), 30, …)`, and
  // `MAX_MCP_TOOL_NAME_LENGTH` is 30 (`src/lfx/src/lfx/base/mcp/constants.py`),
  // while the REST endpoint returns the stored name untouched. A 35-character
  // name therefore round-trips through `GET` and comes back **truncated** in
  // `tools/list`, which reads exactly like the tool having failed to publish.
  // Measured on 1.12.0.dev20 while writing this spec. Base-36 keeps it ~21 chars
  // and inside the sanitizer's character class, so the name reaching the client
  // is the one written here.
  const actionName = `e2e_cfg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const actionDescription = "E2E per-project exposure tool";

  test.beforeAll(async ({ request }) => {
    authorization = await getAuthToken(request);
    expect(
      authorization,
      "Auth token is empty — every assertion below would fail for an auth " +
        "reason rather than for the contract",
    ).toBeTruthy();
    headers = { Authorization: authorization };

    // Fixture guard, not product coverage: the assertions below compare the
    // protocol's tool name to `actionName` for equality, which only holds while
    // it survives the 30-char cap. Fails here, naming the cap, rather than as a
    // confusing tools/list miss if someone lengthens the prefix.
    expect(
      actionName.length,
      `the action name must stay within MAX_MCP_TOOL_NAME_LENGTH (30) or the ` +
        `protocol will serve a truncated name: ${actionName}`,
    ).toBeLessThanOrEqual(30);

    // The prefix is SIX characters, and that is load-bearing rather than terse.
    // Creating a project derives an MCP server named
    // `lf-${sanitize_mcp_name(name)[:26]}` (`MAX_MCP_SERVER_NAME_LENGTH` is 30,
    // minus the `lf-` prefix), and that derived name must be unique per user.
    // `createProjectViaApi` appends `-${Date.now()}-${rand5}` — 20 characters —
    // so a prefix longer than 6 pushes the unique part past the cut and every
    // project this spec creates collides with the previous one:
    // `POST /api/v1/projects/` → 409 "MCP server name conflict:
    // 'lf-e2e_mcp_project_config_178' already exists for a different project".
    // Measured on 1.12.0.dev20 with `--workers=4 --repeat-each=3`, which is how
    // the first version of this spec failed. At six characters the whole
    // timestamp and random suffix survive the truncation.
    const project = await createProjectViaApi(request, headers, {
      namePrefix: "e2ecfg",
      description: "Per-project MCP exposure (#1396)",
    });
    projectId = project.projectId;
    deleteProjectFn = project.deleteProject;
    streamableUrl = `/api/v1/mcp/project/${projectId}/streamable`;

    flowId = await createChatFlowInProject(request, headers, projectId);
  });

  test.afterAll(async ({ request }) => {
    // The afterAll's own live `request`: Playwright forbids reusing the
    // beforeAll one. Flow first, then the project — deleting a project with a
    // flow still in it is a different, untested path.
    if (flowId) {
      await deleteFlow(request, flowId, { headers }).catch(() => {});
    }
    if (deleteProjectFn) {
      await deleteProjectFn(request).catch(() => {});
    }
  });

  test("project MCP settings round-trip through GET and PATCH", { tag: ["@stable", "@api", "@mcp"] },
    async ({ request }) => {
      await test.step("a freshly created project exposes nothing", async () => {
        // The baseline every later assertion is measured against: without it, a
        // build that exposed every flow by default would still pass step 2.
        const res = await request.get(`/api/v1/mcp/project/${projectId}`, {
          headers,
        });
        expect(res.status(), await res.text()).toBe(200);
        const body = await res.json();
        expect(
          body.tools,
          "a new project must expose no MCP tools before anything is selected",
        ).toEqual([]);
      });

      await test.step("PATCH selects the flow as an exposed tool", async () => {
        const res = await request.patch(`/api/v1/mcp/project/${projectId}`, {
          headers,
          data: {
            settings: [
              {
                id: flowId,
                mcp_enabled: true,
                action_name: actionName,
                action_description: actionDescription,
              },
            ],
          },
        });
        expect(res.status(), await res.text()).toBe(200);
      });

      await test.step("GET reads the selection back", async () => {
        const res = await request.get(`/api/v1/mcp/project/${projectId}`, {
          headers,
        });
        expect(res.status(), await res.text()).toBe(200);
        const body = await res.json();

        expect(
          body.tools,
          "exactly the one flow just selected must be listed",
        ).toHaveLength(1);
        // The endpoint returns BOTH the action pair and the flow's own
        // name/description; they are not the same thing and a build that echoed
        // the flow name as the action name would pass a laxer check.
        expect(body.tools[0]).toMatchObject({
          id: flowId,
          mcp_enabled: true,
          action_name: actionName,
          action_description: actionDescription,
        });
        expect(
          body.tools[0].name,
          "the flow's own name must survive alongside the action name",
        ).toContain("MCP project-config flow");
      });
    },
  );

  test("an exposed flow is served over the protocol, and de-selecting withdraws it", { tag: ["@stable", "@api", "@mcp"] },
    async ({ request }) => {
      await test.step("the handshake identifies THIS project's MCP server", async () => {
        // Asserted first: a misdirected endpoint would otherwise produce an
        // empty tools/list that reads exactly like correct de-selection.
        const info = await mcpHandshake(request, streamableUrl, authorization);
        expect(info.serverInfo.name).toBe(`langflow-mcp-project-${projectId}`);
      });

      await test.step("tools/list exposes the selected flow under its action name", async () => {
        const resp = await mcpCall(
          request,
          streamableUrl,
          authorization,
          "tools/list",
          undefined,
          2,
        );
        const tools: Array<{ name: string; description?: string }> =
          resp.result?.tools ?? [];
        const tool = tools.find((t) => t.name === actionName);
        expect(
          tool,
          `tools/list must expose ${actionName}; got ${JSON.stringify(tools.map((t) => t.name))}`,
        ).toBeDefined();
        expect(
          tool?.description,
          "the tool is described by its ACTION description, not the flow's",
        ).toBe(actionDescription);
      });

      await test.step("tools/call runs it — the listing is a working capability", async () => {
        // Unique sentinel: a canned or cached response cannot echo this exact
        // string, so a pass proves the call round-tripped through the flow.
        const sentinel = `mcp-cfg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
        expect(resp.result?.content?.[0]?.text).toBe(sentinel);
      });

      await test.step("PATCH de-selects the flow", async () => {
        const res = await request.patch(`/api/v1/mcp/project/${projectId}`, {
          headers,
          data: {
            settings: [
              {
                id: flowId,
                mcp_enabled: false,
                action_name: actionName,
                action_description: actionDescription,
              },
            ],
          },
        });
        expect(res.status(), await res.text()).toBe(200);
      });

      await test.step("the protocol no longer serves it", async () => {
        // The assertion the bullet is about, made where a client would see it.
        const resp = await mcpCall(
          request,
          streamableUrl,
          authorization,
          "tools/list",
          undefined,
          4,
        );
        const names: string[] = (resp.result?.tools ?? []).map(
          (t: { name: string }) => t.name,
        );
        expect(
          names,
          "a de-selected flow must be gone from tools/list over the protocol",
        ).not.toContain(actionName);
      });

      await test.step("GET agrees, and ?mcp_enabled=false still finds the flow", async () => {
        const enabled = await request.get(
          `/api/v1/mcp/project/${projectId}`,
          { headers },
        );
        expect(enabled.status(), await enabled.text()).toBe(200);
        expect((await enabled.json()).tools).toEqual([]);

        // The query parameter selects WHICH set is listed — it does not toggle
        // anything — and this half also proves the flow was withdrawn from
        // exposure rather than deleted or detached from the project.
        const disabled = await request.get(
          `/api/v1/mcp/project/${projectId}?mcp_enabled=false`,
          { headers },
        );
        expect(disabled.status(), await disabled.text()).toBe(200);
        const body = await disabled.json();
        expect(body.tools).toHaveLength(1);
        expect(body.tools[0]).toMatchObject({
          id: flowId,
          mcp_enabled: false,
          action_name: actionName,
        });
      });
    },
  );
});
