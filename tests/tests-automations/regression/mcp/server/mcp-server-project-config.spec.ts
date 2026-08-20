import { readFileSync } from "fs";
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
import {
  type McpTransportCredential,
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
 *  - **De-selection is asserted at BOTH layers** — absent from `tools/list` and
 *    refused by `tools/call`. The second half is the #1408 regression guard: on
 *    1.12.0.dev20 a de-selected flow was unlisted and still ran (`isError: false`,
 *    and not a cache — a tool never called while enabled behaved the same), because
 *    `handle_call_tool` resolved by action name and never read `mcp_enabled`. Fixed
 *    upstream by langflow#14522 (LE-2175), which pushes `project_id` and
 *    `mcp_enabled_only` into the query instead of post-filtering; re-measured on
 *    1.12.0.dev32 and green on dev33. `get_flow_snake_case`'s `mcp_enabled_only` still defaults to
 *    `False` (the global server needs that), so a caller that stops passing it
 *    re-opens the hole silently — which is what this assertion watches.
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
  // The MCP transport takes an API key and nothing else; `headers` still
  // authenticates the REST calls in this spec (#1522).
  let credential: McpTransportCredential;
  let apiKeyId: string;
  let projectId: string;
  let deleteProjectFn: (req?: APIRequestContext) => Promise<void>;
  let flowId: string;
  let streamableUrl: string;

  // Unique per run, and a valid MCP tool name (snake_case): `tools/list`
  // containment is then an assertion about THIS run's flow.
  //
  // Deliberately SHORT, and deliberately already in the sanitizer's normal form.
  // Neither endpoint echoes `action_name` verbatim: the REST listing serves
  // `sanitize_mcp_name(action_name)` at its default cap of 46
  // (`mcp_projects.py:314`), and the protocol serves
  // `get_unique_name(sanitize_mcp_name(action_name), 30, …)` —
  // `MAX_MCP_TOOL_NAME_LENGTH` is 30 (`src/lfx/src/lfx/base/mcp/constants.py`).
  // So the two agree only for a name that is ALREADY lowercase `[a-z0-9_]` and
  // within 30 characters; a 35-character one comes back whole from `GET` and
  // **truncated** from `tools/list`, which reads exactly like a tool that failed
  // to publish. Measured on 1.12.0.dev20 while writing this spec — it cost a red
  // run. Base-36 keeps this ~21 characters and inside the character class, so
  // the name the client sees is the one written here.
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

    const created = await createApiKey(request, headers, {
      namePrefix: "e2e-mcp-project-config",
    });
    credential = { apiKey: created.key };
    apiKeyId = created.id;

    // Fixture guard, not product coverage: the assertions below compare the
    // served tool name to `actionName` for equality, which holds only while the
    // name survives BOTH transformations unchanged — the 30-char cap and the
    // sanitizer's character class. Fails here, naming the rule, rather than as a
    // confusing tools/list miss if someone lengthens the prefix or writes a
    // hyphen or a capital into it.
    expect(
      actionName.length,
      `the action name must stay within MAX_MCP_TOOL_NAME_LENGTH (30) or the ` +
        `protocol will serve a truncated name: ${actionName}`,
    ).toBeLessThanOrEqual(30);
    expect(
      actionName,
      `the action name must already be in sanitize_mcp_name's normal form ` +
        `(lowercase, [a-z0-9_]) or both endpoints will serve a different string`,
    ).toMatch(/^[a-z][a-z0-9_]*$/);

    // The prefix LENGTH is load-bearing rather than terse. Creating a project
    // derives an MCP server named `lf-${sanitize_mcp_name(name)[:26]}`
    // (`MAX_MCP_SERVER_NAME_LENGTH` is 30, minus the `lf-` prefix), and that
    // derived name must be unique per user. `createProjectViaApi` appends
    // `-${Date.now()}-${rand5}` — 20 characters — so **≤6 is what guarantees the
    // whole unique part survives the cut**. Past 6 the suffix is truncated from
    // the right and the conflict risk grows with the prefix rather than becoming
    // certain at once: at 7 characters four of the five random characters still
    // survive, while the 22-character prefix the first version of this spec used
    // (`e2e_mcp_project_config`) left nothing past the first three digits of the
    // timestamp — so there every project it created collided with the previous
    // one: `POST /api/v1/projects/` → 409 "MCP server name conflict:
    // 'lf-e2e_mcp_project_config_178' already exists for a different project".
    // Measured on 1.12.0.dev20 with `--workers=4 --repeat-each=3`, which is how
    // that version failed. Filed as #1409 — it reproduces with two ordinary
    // project names. Five characters give 5+1+13+1+5 = 25, one inside the cut, so
    // the whole suffix survives with slack.
    const project = await createProjectViaApi(request, headers, {
      namePrefix: "e2ecf",
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
    //
    // Errors are collected rather than swallowed: `deleteFlow` and
    // `deleteProject` are written to THROW so a cleanup regression stays visible
    // (#545/#965), and a bare `.catch(() => {})` re-introduces exactly the silent
    // leak they guard against — here a leak is two things, a project and the
    // `lf-<name>` entry it registers in the shared MCP server list that
    // `mcp-server-starter-projects.spec.ts` asserts on. Collecting also keeps the
    // second cleanup running when the first fails, which a bare `await` would not.
    const failures: string[] = [];
    if (flowId) {
      await deleteFlow(request, flowId, { headers }).catch((e) =>
        failures.push(`flow ${flowId}: ${e}`),
      );
    }
    if (deleteProjectFn) {
      await deleteProjectFn(request).catch((e) =>
        failures.push(`project ${projectId}: ${e}`),
      );
    }
    if (apiKeyId) {
      await deleteApiKey(request, apiKeyId, headers).catch((e) =>
        failures.push(`api key ${apiKeyId}: ${e}`),
      );
    }
    expect(
      failures,
      `teardown left state on the shared instance: ${failures.join(" | ")}`,
    ).toEqual([]);
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

  // `@regression` on this test only: its last two steps are the guard for #1408,
  // a real defect fixed upstream (langflow#14522). Test 1 has no bug history and
  // stays without the tag.
  test("an exposed flow is served over the protocol, and de-selecting withdraws it", { tag: ["@stable", "@regression", "@api", "@mcp"] },
    async ({ request }) => {
      await test.step("the handshake identifies THIS project's MCP server", async () => {
        // Asserted first: a misdirected endpoint would otherwise produce an
        // empty tools/list that reads exactly like correct de-selection.
        const info = await mcpHandshake(request, streamableUrl, credential);
        expect(info.serverInfo.name).toBe(`langflow-mcp-project-${projectId}`);
      });

      await test.step("tools/list exposes the selected flow under its action name", async () => {
        const resp = await mcpCall(
          request,
          streamableUrl,
          credential,
          "tools/list",
          undefined,
          2,
        );
        // Checked, not defaulted: `resp.result?.tools ?? []` turns ANY failed
        // response into an empty list, which passes the de-selection assertion
        // below for entirely the wrong reason. Verified by mutation — pointing
        // this step at a bogus JSON-RPC method left the spec green.
        expect(resp.error, JSON.stringify(resp.error)).toBeUndefined();
        expect(
          Array.isArray(resp.result?.tools),
          `tools/list must answer with a tools array; got ${JSON.stringify(resp.result)}`,
        ).toBe(true);
        const tools: Array<{ name: string; description?: string }> =
          resp.result.tools;
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
          credential,
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
          credential,
          "tools/list",
          undefined,
          4,
        );
        // The load-bearing guard of this spec: an absent action proves
        // de-selection ONLY if the call itself succeeded.
        expect(resp.error, JSON.stringify(resp.error)).toBeUndefined();
        expect(
          Array.isArray(resp.result?.tools),
          `tools/list must answer with a tools array; got ${JSON.stringify(resp.result)}`,
        ).toBe(true);
        const names: string[] = resp.result.tools.map(
          (t: { name: string }) => t.name,
        );
        expect(
          names,
          "a de-selected flow must be gone from tools/list over the protocol",
        ).not.toContain(actionName);
      });

      await test.step("tools/call refuses it — the withdrawal reaches invocation", async () => {
        // The #1408 guard. Meaningful only because step 3 ran this exact action
        // successfully: an unknown name produces the SAME message, so on a fresh
        // name this assertion would prove nothing.
        const sentinel = `mcp-cfg-off-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const resp = await mcpCall(
          request,
          streamableUrl,
          credential,
          "tools/call",
          { name: actionName, arguments: { input_value: sentinel } },
          5,
        );
        expect(resp.error, JSON.stringify(resp.error)).toBeUndefined();
        expect(
          resp.result?.isError,
          `a de-selected flow must not be callable; got ${JSON.stringify(resp.result)}`,
        ).toBe(true);
        const text: string = resp.result?.content?.[0]?.text ?? "";
        // Pinned to the RESOLUTION failure, not to "any error": a permission or
        // transport failure would otherwise read as a correct withdrawal.
        expect(
          text,
          "the refusal must be the resolution failure naming the action",
        ).toContain(`Flow with name '${actionName}' not found`);
        // `isError: true` alone would also be satisfied by a build that ran the
        // flow and then failed downstream. The absence of the echo is what proves
        // it did not execute.
        expect(
          text,
          "the flow must not have run — its input must not be echoed back",
        ).not.toContain(sentinel);
      });

      await test.step("GET agrees, and ?mcp_enabled=false still finds the flow", async () => {
        const enabled = await request.get(
          `/api/v1/mcp/project/${projectId}`,
          { headers },
        );
        expect(enabled.status(), await enabled.text()).toBe(200);
        expect((await enabled.json()).tools).toEqual([]);

        // `?mcp_enabled=false` does not invert the filter — it removes it.
        // `_build_project_tools_response` adds `WHERE mcp_enabled = true` ONLY
        // when the parameter is truthy (`mcp_projects.py:301`), so `false`
        // returns every flow in the project. This project holds exactly one, so
        // the assertion below is about that flow either way, and what it proves
        // is that the flow was withdrawn from exposure rather than deleted or
        // detached from the project.
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
