import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { type CreatedApiKey, createApiKey, deleteApiKey } from "../../../../helpers/auth/create-api-key";
import { createCatalogFlow, fetchComponentCatalog } from "../../../../helpers/flows/build-catalog-flow";
import { createProjectViaApi } from "../../../../helpers/flows/create-project-via-api";
import { messageSendEnvelope, postA2AJsonRpc } from "../../../../helpers/a2a/post-a2a-jsonrpc";
import { requireA2aEnabled } from "../../../../helpers/a2a/require-a2a-enabled";
import { mcpCall, mcpHandshake } from "../../../../helpers/mcp/mcp-streamable-client";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import {
  ANONYMOUS_PRINCIPAL_HINT,
  driveListFlowSpec,
  NOT_AUTHORIZED_MESSAGE,
  parseProbeOutput,
  probeFlowSpec,
} from "../../../../helpers/integrations/connection-probe";
import { type CreatedConnection, createConnectionViaApi } from "../../../../helpers/integrations/create-connection";

// Which entry points may resolve a connection (#2296).
// Spec doc: docs/api/connections/api-connections-resolution-entry-points.md
//
// Every entry point stamps an execution family on its run, and the server decides
// per run whether that caller may use a connection: an anonymous principal resolves
// nothing; an authenticated interactive one resolves its own and the instance's.
// Upstream proves this in-process only. Here a flow is RUN through each entry point
// and the verdict is read from what the run produced:
//   - authenticated paths: a probe component reports, per handle, `resolved` with
//     the connection id and owner kind, or `denied` with the code and typed reason;
//   - anonymous paths: the server swaps custom code for its stock copy there, so the
//     oracle is a real read-only connector (Drive: List Files) whose error must name
//     `connection-not-authorized` with the anonymous hint — and which, run
//     authenticated, gets past identity to `scope-missing`.
// No provider is ever called: the probe stops before any adapter, and the Drive
// connector is refused before one (or, authenticated, on its missing scope).
test.describe("Connections — which entry points may resolve a connection", () => {
  const USER_FIELD = "user_connection";
  const INSTANCE_FIELD = "instance_connection";

  // Planted credentials, unique per run, swept as TEXT from every response (#1967):
  // a verdict that echoed the token would pass every other assertion here.
  const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`.toUpperCase();
  const SENTINELS = {
    user: `E2E-PROBE-USER-SENTINEL-${run}`,
    instance: `E2E-PROBE-INSTANCE-SENTINEL-${run}`,
  };

  let superHeaders: Record<string, string>;
  let apiKey: CreatedApiKey;
  let userConnection: CreatedConnection;
  let instanceConnection: CreatedConnection;
  let probeFlowId: string;
  let catalog: Record<string, unknown>;
  const driveFlowIds: { user?: string; instance?: string } = {};
  // Each cleanup takes the afterAll's own `request`: Playwright forbids reusing the
  // beforeAll one.
  const cleanups: Array<(request: APIRequestContext) => Promise<void>> = [];

  test.beforeAll(async ({ request }) => {
    superHeaders = { Authorization: await getAuthToken(request) };
    // Four superuser writes a run: two seeds here, two deletes in afterAll (#2295).
    userConnection = await createConnectionViaApi(request, superHeaders, {
      label: "resolution_user",
      credentials: { access_token: SENTINELS.user },
    });
    cleanups.push((req) => userConnection.deleteConnection(req));
    instanceConnection = await createConnectionViaApi(request, superHeaders, {
      label: "resolution_instance",
      ownershipMode: "instance",
      credentials: { access_token: SENTINELS.instance },
    });
    cleanups.push((req) => instanceConnection.deleteConnection(req));
    // `/run`, `/responses` and `/api/v2/workflows` refuse a bare session under
    // auto_login ("Since v1.5, LANGFLOW_AUTO_LOGIN requires a valid API key").
    apiKey = await createApiKey(request, superHeaders, { namePrefix: "e2e-resolution" });
    cleanups.push((req) => deleteApiKey(req, apiKey.id, superHeaders));

    catalog = await fetchComponentCatalog(request, superHeaders);
    probeFlowId = await createCatalogFlow(
      request,
      catalog,
      probeFlowSpec([
        { field: USER_FIELD, handle: `google/${userConnection.name}` },
        { field: INSTANCE_FIELD, handle: `google/${instanceConnection.name}` },
      ]),
      { name: `E2E resolution probe ${run}`, headers: superHeaders },
    );
    cleanups.push((req) => deleteFlow(req, probeFlowId, { headers: superHeaders }));
    for (const kind of ["user", "instance"] as const) {
      const connection = kind === "user" ? userConnection : instanceConnection;
      const flowId = await createCatalogFlow(request, catalog, driveListFlowSpec(`google/${connection.name}`), {
        name: `E2E resolution drive ${kind} ${run}`,
        headers: superHeaders,
      });
      driveFlowIds[kind] = flowId;
      cleanups.push((req) => deleteFlow(req, flowId, { headers: superHeaders }));
      // Public, so the anonymous rows can reach it at all. An authenticated caller
      // still runs it as the owner, which is what the contrast below relies on.
      const res = await request.patch(`/api/v1/flows/${flowId}`, {
        headers: superHeaders,
        data: { access_type: "PUBLIC" },
      });
      expect(res.status(), await res.text()).toBe(200);
    }
  });

  test.afterAll(async ({ request }) => {
    // Reverse order, every step attempted: a failed delete must not leak the rest.
    const failures: string[] = [];
    for (const cleanup of cleanups.splice(0).reverse()) {
      await cleanup(request).catch((error) => failures.push(String(error)));
    }
    expect(failures, "every flow, key and connection this file created is deleted").toEqual([]);
  });

  /** The planted tokens must not appear anywhere in what a run sent back. */
  function expectNoSentinel(text: string, where: string): void {
    expect(text, `${where} must not carry the user connection's token`).not.toContain(SENTINELS.user);
    expect(text, `${where} must not carry the instance connection's token`).not.toContain(SENTINELS.instance);
  }

  /** Both handles resolved — and to exactly the rows planted, with their owner kind. */
  function expectBothResolved(text: string, where: string): void {
    expectNoSentinel(text, where);
    const outcomes = parseProbeOutput(text);
    expect(outcomes[USER_FIELD], `${where}: the user connection, in ${text.slice(0, 600)}`).toEqual({
      state: "resolved",
      ownerKind: "user",
      connectionId: userConnection.id,
    });
    expect(outcomes[INSTANCE_FIELD], `${where}: the instance connection`).toEqual({
      state: "resolved",
      ownerKind: "instance",
      connectionId: instanceConnection.id,
    });
  }

  /**
   * An anonymous run of a Drive flow was refused on the principal, before any
   * provider. The playground paths send the client error shape, so the code and the
   * `anonymous-principal` hint are both asserted.
   */
  function expectAnonymousDenial(text: string, where: string): void {
    expectNoSentinel(text, where);
    expect(text, `${where}: the refusal names its code`).toContain("connection-not-authorized");
    expect(text, `${where}: the refusal carries the anonymous-principal hint`).toContain(ANONYMOUS_PRINCIPAL_HINT);
    // Scopes are checked AFTER the principal: reaching them would mean the anonymous
    // run resolved the connection.
    expect(text, `${where}: no scope check was reached`).not.toContain("scope-missing");
  }

  /**
   * Same verdict where only the exception's MESSAGE reaches the reader (a public MCP
   * tool call, a public A2A run): refused on the principal, never on the provider and
   * never past it to the scope check. The typed reason is not observable here.
   */
  function expectPrincipalRefused(text: string, where: string): void {
    expectNoSentinel(text, where);
    expect(text, `${where}: the principal is refused`).toContain(NOT_AUTHORIZED_MESSAGE);
    expect(text, `${where}: no scope check was reached`).not.toContain("scope-missing");
    expect(text, `${where}: it is not the provider that refused`).not.toContain("The provider denied this action.");
  }

  /**
   * For a request that RUNS the Drive flow. Measured on 1.13.0.dev47, one such run
   * takes 2–4 s serially (the Google bundle loads on each build) and queues behind
   * the other worker's runs on a single-worker backend: at `--workers=2` two of them
   * passed the config's 20 s `actionTimeout` and failed with no verdict at all. A
   * real graph build gets real time, the reason `postA2AJsonRpc` defaults to 120 s.
   */
  const DRIVE_RUN_TIMEOUT_MS = 60_000;

  function keyHeaders(): Record<string, string> {
    return { "x-api-key": apiKey.key };
  }

  /** A context with no session at all, only the visitor cookie the public paths key on. */
  function visitorHeaders(): Record<string, string> {
    return { Cookie: `client_id=e2e-resolution-${run.toLowerCase()}-${Math.random().toString(36).slice(2, 8)}` };
  }

  /**
   * A flow of its own in a project of its own, for the entry points that publish a
   * project (MCP) or a flow (A2A). The project's `auth_type` decides who the caller
   * is: `apikey` runs the flow's own code as the key's user, `none` is a public call
   * (the stock-code policy, the public principal). Cleanup is registered in `local`,
   * flow before project.
   */
  async function publishedFlow(
    request: APIRequestContext,
    kind: "probe" | "drive",
    authType: "apikey" | "none",
    local: Array<(request: APIRequestContext) => Promise<void>>,
  ): Promise<{ flowId: string; projectId: string }> {
    const project = await createProjectViaApi(request, superHeaders, {
      namePrefix: "e2eres",
      description: "Connection-resolution entry points (#2296)",
      authSettings: { auth_type: authType },
    });
    local.push((req) => project.deleteProject(req));
    const spec =
      kind === "probe"
        ? probeFlowSpec([
            { field: USER_FIELD, handle: `google/${userConnection.name}` },
            { field: INSTANCE_FIELD, handle: `google/${instanceConnection.name}` },
          ])
        : driveListFlowSpec(`google/${userConnection.name}`);
    const flowId = await createCatalogFlow(request, catalog, spec, {
      name: `E2E resolution ${kind} ${authType} ${run} ${Math.random().toString(36).slice(2, 6)}`,
      headers: superHeaders,
    });
    local.push((req) => deleteFlow(req, flowId, { headers: superHeaders }));
    const res = await request.patch(`/api/v1/flows/${flowId}`, {
      headers: superHeaders,
      data: { folder_id: project.projectId, flow_type: "agent", a2a_enabled: true },
    });
    expect(res.status(), await res.text()).toBe(200);
    // Asserted, not assumed: a move that silently no-ops leaves the flow where its
    // project's auth does not apply, and the row would test the wrong caller.
    expect((await res.json()).folder_id, "the flow moved into its own project").toBe(project.projectId);
    return { flowId, projectId: project.projectId };
  }

  /** Expose `flowId` as an MCP tool of `projectId` under `actionName`. */
  async function exposeAsTool(
    request: APIRequestContext,
    projectId: string,
    flowId: string,
    actionName: string,
  ): Promise<void> {
    const res = await request.patch(`/api/v1/mcp/project/${projectId}`, {
      headers: superHeaders,
      data: {
        settings: [{ id: flowId, mcp_enabled: true, action_name: actionName, action_description: "resolution probe" }],
      },
    });
    expect(res.status(), await res.text()).toBe(200);
  }

  /**
   * A JSON-RPC request to a streamable MCP endpoint with NO credential at all: the
   * public project call `mcpCall` cannot send, since it always carries a key.
   */
  async function anonymousMcp(
    request: APIRequestContext,
    url: string,
    method: string,
    params: Record<string, unknown> | undefined,
    id?: number,
  ): Promise<{ status: number; text: string }> {
    const res = await request.post(url, {
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      data: { jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method, ...(params ? { params } : {}) },
      timeout: DRIVE_RUN_TIMEOUT_MS,
    });
    return { status: res.status(), text: await res.text() };
  }

  async function runCleanups(
    request: APIRequestContext,
    local: Array<(request: APIRequestContext) => Promise<void>>,
  ): Promise<void> {
    const failures: string[] = [];
    for (const cleanup of local.splice(0).reverse()) {
      await cleanup(request).catch((error) => failures.push(String(error)));
    }
    expect(failures, "this test's project and flow are deleted").toEqual([]);
  }

  test(
    "the Playground build resolves the owner's and the instance's connection",
    { tag: ["@stable", "@api", "@integrations"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare(["POST /api/v1/build/{flow_id}/flow"]);
      const res = await request.post(`/api/v1/build/${probeFlowId}/flow?event_delivery=direct`, {
        headers: superHeaders,
        data: { inputs: { input_value: "probe" } },
      });
      const text = await res.text();
      expect(res.status(), text.slice(0, 400)).toBe(200);
      expectBothResolved(text, "the Playground build");
    },
  );

  test(
    "POST /api/v1/run resolves the owner's and the instance's connection",
    { tag: ["@stable", "@api", "@integrations"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare(["POST /api/v1/run/{flow_id_or_name}"]);
      const res = await request.post(`/api/v1/run/${probeFlowId}?stream=false`, {
        headers: keyHeaders(),
        data: { input_value: "probe", input_type: "chat", output_type: "chat" },
      });
      const text = await res.text();
      expect(res.status(), text.slice(0, 400)).toBe(200);
      expectBothResolved(text, "/api/v1/run");
    },
  );

  test(
    "POST /api/v1/responses resolves the owner's and the instance's connection",
    { tag: ["@stable", "@api", "@integrations"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare(["POST /api/v1/responses"]);
      const res = await request.post("/api/v1/responses", {
        headers: keyHeaders(),
        data: { model: probeFlowId, input: "probe", stream: false },
      });
      const text = await res.text();
      expect(res.status(), text.slice(0, 400)).toBe(200);
      expectBothResolved(text, "/api/v1/responses");
    },
  );

  test(
    "POST /api/v2/workflows resolves the owner's and the instance's connection",
    { tag: ["@stable", "@api", "@integrations"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare(["POST /api/v2/workflows"]);
      const res = await request.post("/api/v2/workflows", {
        headers: keyHeaders(),
        data: { flow_id: probeFlowId, input_value: "probe" },
      });
      const text = await res.text();
      expect(res.status(), text.slice(0, 400)).toBe(200);
      expectBothResolved(text, "/api/v2/workflows");
    },
  );

  test(
    "an MCP tool call behind an API key resolves the owner's and the instance's connection",
    { tag: ["@stable", "@api", "@integrations", "@mcp"] },
    async ({ request }) => {
      const local: Array<(request: APIRequestContext) => Promise<void>> = [];
      try {
        const { flowId, projectId } = await publishedFlow(request, "probe", "apikey", local);
        const actionName = `resolution_probe_${run.toLowerCase().slice(0, 8)}`;
        await exposeAsTool(request, projectId, flowId, actionName);
        const url = `/api/v1/mcp/project/${projectId}/streamable`;
        const credential = { apiKey: apiKey.key };
        await mcpHandshake(request, url, credential);
        const resp = await mcpCall(
          request,
          url,
          credential,
          "tools/call",
          { name: actionName, arguments: { input_value: "probe" } },
          2,
        );
        const text = JSON.stringify(resp);
        expect(resp.error, text.slice(0, 400)).toBeUndefined();
        expectBothResolved(text, "an MCP tool call behind an API key");
      } finally {
        await runCleanups(request, local);
      }
    },
  );

  test(
    "the legacy global MCP server, behind an API key, resolves the owner's and the instance's connection",
    { tag: ["@stable", "@api", "@integrations", "@mcp"] },
    async ({ request }) => {
      // The pre-project MCP server (`/api/v1/mcp/streamable`, family `legacy_mcp`):
      // it serves every MCP-enabled flow of the key's user. A `tools/call` is looked
      // up by the FLOW's name ("Flow with name '<x>' not found" otherwise, measured
      // on 1.13.0.dev47), so the flow is named after the tool.
      const local: Array<(request: APIRequestContext) => Promise<void>> = [];
      try {
        const actionName = `resolution_legacy_${run.toLowerCase().slice(0, 8)}`;
        const flowId = await createCatalogFlow(
          request,
          catalog,
          probeFlowSpec([
            { field: USER_FIELD, handle: `google/${userConnection.name}` },
            { field: INSTANCE_FIELD, handle: `google/${instanceConnection.name}` },
          ]),
          { name: actionName, headers: superHeaders },
        );
        local.push((req) => deleteFlow(req, flowId, { headers: superHeaders }));
        const res = await request.patch(`/api/v1/flows/${flowId}`, {
          headers: superHeaders,
          data: { mcp_enabled: true, action_name: actionName, action_description: "resolution probe" },
        });
        expect(res.status(), await res.text()).toBe(200);
        const url = "/api/v1/mcp/streamable";
        const credential = { apiKey: apiKey.key };
        const info = await mcpHandshake(request, url, credential);
        // Asserted first: a project server answering here would test the other family.
        expect(info?.serverInfo?.name, "the global, pre-project MCP server answers").toBe("langflow-mcp-server");
        const resp = await mcpCall(
          request,
          url,
          credential,
          "tools/call",
          { name: actionName, arguments: { input_value: "probe" } },
          2,
        );
        const text = JSON.stringify(resp);
        expect(resp.error, text.slice(0, 400)).toBeUndefined();
        expectBothResolved(text, "the legacy global MCP server");
      } finally {
        await runCleanups(request, local);
      }
    },
  );

  test(
    "the shareable playground resolves no connection for an anonymous visitor",
    { tag: ["@stable", "@api", "@integrations"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare(["POST /api/v1/run/{flow_id_or_name}", "POST /api/v1/build_public_tmp/{flow_id}/flow"]);

      await test.step("the oracle, run authenticated, gets past identity and stops at its missing scope", async () => {
        // The contrast that gives the anonymous refusal its meaning: the same flow,
        // run by its owner, is NOT refused on the principal.
        const res = await request.post(`/api/v1/run/${driveFlowIds.user}?stream=false`, {
          headers: keyHeaders(),
          data: { input_value: "", input_type: "chat", output_type: "any" },
          timeout: DRIVE_RUN_TIMEOUT_MS,
        });
        const text = await res.text();
        expectNoSentinel(text, "the authenticated Drive run");
        expect(text, "authenticated, the Drive run reaches its scope check").toContain("scope-missing");
        expect(text, "authenticated, the Drive run is not refused on the principal").not.toContain(
          "connection-not-authorized",
        );
      });

      for (const kind of ["user", "instance"] as const) {
        await test.step(`an anonymous build of the ${kind}-connection flow is refused on the principal`, async () => {
          const res = await request.post(`/api/v1/build_public_tmp/${driveFlowIds[kind]}/flow?event_delivery=direct`, {
            headers: visitorHeaders(),
            data: {},
            timeout: DRIVE_RUN_TIMEOUT_MS,
          });
          const text = await res.text();
          expect(res.status(), text.slice(0, 400)).toBe(200);
          expectAnonymousDenial(text, `the shareable playground (${kind} connection)`);
        });
      }
    },
  );

  test(
    "POST /api/v2/workflows/public resolves no connection for an anonymous visitor",
    { tag: ["@stable", "@api", "@integrations"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare(["POST /api/v2/workflows/public"]);
      for (const kind of ["user", "instance"] as const) {
        await test.step(`an anonymous run of the ${kind}-connection flow is refused on the principal`, async () => {
          const res = await request.post("/api/v2/workflows/public", {
            headers: visitorHeaders(),
            data: { flow_id: driveFlowIds[kind], input_value: "" },
            timeout: DRIVE_RUN_TIMEOUT_MS,
          });
          const text = await res.text();
          expect(res.status(), text.slice(0, 400)).toBe(200);
          expectAnonymousDenial(text, `/api/v2/workflows/public (${kind} connection)`);
        });
      }
    },
  );

  test(
    "a public MCP project resolves no connection for an anonymous caller",
    { tag: ["@stable", "@api", "@integrations", "@mcp"] },
    async ({ request }) => {
      const local: Array<(request: APIRequestContext) => Promise<void>> = [];
      try {
        const { flowId, projectId } = await publishedFlow(request, "drive", "none", local);
        const actionName = `resolution_drive_${run.toLowerCase().slice(0, 8)}`;
        await exposeAsTool(request, projectId, flowId, actionName);
        const url = `/api/v1/mcp/project/${projectId}/streamable`;
        const init = await anonymousMcp(
          request,
          url,
          "initialize",
          { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "langflow-e2e", version: "0.1" } },
          1,
        );
        expect(init.status, `a public project accepts a caller with no credential: ${init.text.slice(0, 300)}`).toBe(200);
        await anonymousMcp(request, url, "notifications/initialized", undefined);
        const call = await anonymousMcp(request, url, "tools/call", { name: actionName, arguments: { input_value: "" } }, 2);
        expect(call.status, call.text.slice(0, 300)).toBe(200);
        // The tool result is an error carrying str(exception) and nothing else.
        expect(call.text, "the tool call reports an error").toContain('"isError":true');
        expectPrincipalRefused(call.text, "a public MCP tool call");
      } finally {
        await runCleanups(request, local);
      }
    },
  );

  test(
    "a public A2A agent resolves no connection for an anonymous caller",
    { tag: ["@stable", "@api", "@integrations", "@a2a"] },
    async ({ request }) => {
      await requireA2aEnabled(request, superHeaders);
      const local: Array<(request: APIRequestContext) => Promise<void>> = [];
      try {
        const { flowId } = await publishedFlow(request, "drive", "none", local);
        const result = await postA2AJsonRpc(
          request,
          flowId,
          messageSendEnvelope("probe", { id: `rpc-${run}`, messageId: `msg-${run}-public` }),
        );
        expect(result.status, result.raw.slice(0, 300)).toBe(200);
        expectNoSentinel(result.raw, "a public A2A agent");
        // The caller only learns that the task failed...
        const task = (result.body as { result?: { status?: { state?: string } } } | null)?.result;
        expect(task?.status?.state, `the A2A task fails: ${result.raw.slice(0, 300)}`).toBe("failed");
        // ...so the reason is read where the run recorded it, by the flow's owner.
        const messages = await request.get(`/api/v1/monitor/messages?flow_id=${flowId}`, { headers: superHeaders });
        const recorded = await messages.text();
        expect(messages.status(), recorded.slice(0, 300)).toBe(200);
        expectPrincipalRefused(recorded, "the public A2A run's recorded error");
      } finally {
        await runCleanups(request, local);
      }
    },
  );

  test(
    "an A2A agent behind an API key resolves no connection either — both sub-paths run as the anonymous family",
    { tag: ["@stable", "@api", "@integrations", "@a2a"] },
    async ({ request }) => {
      await requireA2aEnabled(request, superHeaders);
      const local: Array<(request: APIRequestContext) => Promise<void>> = [];
      try {
        const { flowId } = await publishedFlow(request, "probe", "apikey", local);
        const result = await postA2AJsonRpc(
          request,
          flowId,
          messageSendEnvelope("probe", { id: `rpc-${run}`, messageId: `msg-${run}-key` }),
          { "x-api-key": apiKey.key },
        );
        expect(result.status, result.raw.slice(0, 300)).toBe(200);
        expectNoSentinel(result.raw, "an A2A agent behind an API key");
        // The flow's own code runs behind a key (#2196), so the probe reports the
        // TYPED reason, which is stronger than the hint the public rows are judged by.
        const outcomes = parseProbeOutput(result.raw);
        const denied = { state: "denied", code: "connection-not-authorized", reason: "anonymous-principal" };
        expect(outcomes[USER_FIELD], `the user connection, in ${result.raw.slice(0, 600)}`).toEqual(denied);
        expect(outcomes[INSTANCE_FIELD], "the instance connection").toEqual(denied);
      } finally {
        await runCleanups(request, local);
      }
    },
  );
});
