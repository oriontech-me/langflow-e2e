import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { type CreatedApiKey, createApiKey, deleteApiKey } from "../../../../helpers/auth/create-api-key";
import {
  type CatalogFlowSpec,
  createCatalogFlow,
  fetchComponentCatalog,
} from "../../../../helpers/flows/build-catalog-flow";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import { parseProbeOutput, probeFlowSpec, type ProbeTarget } from "../../../../helpers/integrations/connection-probe";
import { type ConnectionsOwner, createConnectionsOwner } from "../../../../helpers/integrations/connections-owner";
import {
  type CreateConnectionOptions,
  type CreatedConnection,
  createConnectionViaApi,
} from "../../../../helpers/integrations/create-connection";
import { createKnowledgeBase, deleteKnowledgeBase } from "../../../../helpers/knowledge/knowledge-base";
import {
  listPendingRequests,
  type PendingRequestRow,
  readJobStatus,
  resumeJob,
  submitBackgroundRun,
} from "../../../../helpers/serving/serving-jobs";

// A non-interactive caller needs the owner's opt-in (#2306).
// Spec doc: docs/api/connections/api-connections-resolution-non-interactive.md
//
// `allow_non_interactive` is off by default (#1970). This file asserts its EFFECT:
// a run with nobody present — a webhook, a resumed HITL job, a KB connector ingest —
// is refused a user's connection unless that user opted in, while an instance
// connection never reads the flag. Plus the two refusals the database resolver adds:
// an owned row shadows an instance row with the same handle and never falls back to
// it, and a Slack app-level token resolves only inside the trigger listener.
//
// The verdict is read from the #2296 probe: per handle, `resolved` with the row's id
// and owner kind, or `denied` with the code and the typed reason. No provider is ever
// called. Every non-interactive DENY has an interactive contrast on the same row, so a
// refusal reads as the family's and not as a connection that does not work.
test.describe("Connections — a non-interactive caller needs the owner's opt-in", () => {
  const OPT_IN_REASON = "non-interactive-opt-in-required";
  const OPT_IN_HINT = "Ask the connection owner to enable allow_non_interactive on this connection, then retry.";
  const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";
  // The marker the server writes on an app-level token row, whatever the client sent.
  const APP_TOKEN_SCOPE = "connections:write";

  // Planted credentials, unique per run, swept as TEXT from everything a run sends
  // back (#1967): a verdict that echoed a token would pass every other assertion.
  const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`.toUpperCase();
  const sentinels: string[] = [];
  function sentinel(label: string): string {
    const token = `E2E-NONINT-${label.toUpperCase()}-SENTINEL-${run}`;
    sentinels.push(token);
    return token;
  }

  // Every connection, flow, key and knowledge base the owner holds rides on the test's
  // own `request` (#2295): the writes land in the throwaway owner's buckets and
  // apiCoverage records the calls. Instance rows are the superuser's — only a
  // superuser may create one (403 otherwise, measured on 1.13.0.dev47).
  let owner: ConnectionsOwner;
  let superHeaders: Record<string, string>;
  let apiKey: CreatedApiKey;
  let instanceConnection: CreatedConnection;
  let catalog: Record<string, unknown>;
  // Each cleanup takes the afterAll's own `request`: Playwright forbids reusing a
  // test's or the beforeAll's.
  const cleanups: Array<(request: APIRequestContext) => Promise<void>> = [];

  test.beforeAll(async ({ playwright, request }, testInfo) => {
    owner = await createConnectionsOwner(
      () => playwright.request.newContext({ baseURL: testInfo.project.use.baseURL }),
      "connnonint",
    );
    superHeaders = { Authorization: await getAuthToken(request) };
    // The flag sent explicitly OFF: an instance row that resolves for a
    // non-interactive caller must do so because the flag is not read, not because
    // it happened to be on.
    instanceConnection = await createConnectionViaApi(request, superHeaders, {
      label: "nonint_instance",
      ownershipMode: "instance",
      allowNonInteractive: false,
      credentials: { access_token: sentinel("instance") },
    });
    cleanups.push((req) => instanceConnection.deleteConnection(req));
    expect(instanceConnection.connection.allow_non_interactive, "the instance row's own flag is off").toBe(false);
    // The webhook and the v2 jobs doors refuse a bare session under auto_login. The
    // key is the OWNER's: a webhook runs as the flow's owner and a resume as the job's.
    apiKey = await createApiKey(request, owner.headers, { namePrefix: "e2e-nonint" });
    cleanups.push((req) => deleteApiKey(req, apiKey.id, owner.headers));
    catalog = await fetchComponentCatalog(request, owner.headers);
  });

  test.afterAll(async ({ request }) => {
    // Reverse order, every step attempted: a failed delete must not leak the rest.
    const failures: string[] = [];
    for (const cleanup of cleanups.splice(0).reverse()) {
      await cleanup(request).catch((error) => failures.push(String(error)));
    }
    // Deleting the owner takes any row it still owns with it.
    await owner?.dispose();
    expect(failures, "every flow, key, knowledge base and connection this file created is deleted").toEqual([]);
  });

  /** No planted token may appear anywhere in what a run sent back. */
  function expectNoSentinel(text: string, where: string): void {
    for (const token of sentinels) expect(text, `${where} must not carry a planted token`).not.toContain(token);
  }

  /** A user row of the owner's, carrying a sentinel token. Its 201 body is returned as-is. */
  async function plantUserRow(
    request: APIRequestContext,
    label: string,
    options: CreateConnectionOptions = {},
  ): Promise<CreatedConnection> {
    const connection = await createConnectionViaApi(request, owner.headers, {
      label,
      credentials: { access_token: sentinel(label) },
      ...options,
    });
    cleanups.push((req) => connection.deleteConnection(req));
    return connection;
  }

  async function ownerFlow(request: APIRequestContext, spec: CatalogFlowSpec, label: string): Promise<string> {
    const flowId = await createCatalogFlow(request, catalog, spec, {
      name: `E2E non-interactive ${label} ${run} ${Math.random().toString(36).slice(2, 6)}`,
      headers: owner.headers,
    });
    cleanups.push((req) => deleteFlow(req, flowId, { headers: owner.headers }));
    return flowId;
  }

  async function setOptIn(request: APIRequestContext, connection: CreatedConnection, on: boolean): Promise<void> {
    const res = await request.patch(`/api/v1/connections/${connection.id}`, {
      headers: owner.headers,
      data: { allow_non_interactive: on },
    });
    const text = await res.text();
    expect(res.status(), text).toBe(200);
    expect(JSON.parse(text).allow_non_interactive, `the opt-in now reads ${on}`).toBe(on);
  }

  function keyHeaders(): Record<string, string> {
    return { "x-api-key": apiKey.key };
  }

  /** The Playground build — the interactive contrast. */
  async function buildText(request: APIRequestContext, flowId: string): Promise<string> {
    const res = await request.post(`/api/v1/build/${flowId}/flow?event_delivery=direct`, {
      headers: owner.headers,
      data: { inputs: { input_value: "probe" } },
    });
    const text = await res.text();
    expect(res.status(), text.slice(0, 400)).toBe(200);
    expectNoSentinel(text, "the Playground build");
    return text;
  }

  /**
   * One webhook run, read back where it lands. The route answers 202 and runs the flow
   * in the background; its Chat Output is recorded in the owner's message log ~0.6–1.6 s
   * later (measured on 1.13.0.dev47). New messages are told apart by id, never by count
   * or position, and the poll interval stays under the 2 s keep-alive.
   */
  async function webhookText(request: APIRequestContext, flowId: string): Promise<string> {
    const readMessages = async () => {
      const res = await request.get(`/api/v1/monitor/messages?flow_id=${flowId}`, { headers: owner.headers });
      expect(res.status()).toBe(200);
      return (await res.json()) as Array<{ id: string; text: string }>;
    };
    const seen = new Set((await readMessages()).map((m) => m.id));
    const res = await request.post(`/api/v1/webhook/${flowId}`, { headers: keyHeaders(), data: { e2e: run } });
    expect(res.status(), await res.text()).toBe(202);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const fresh = (await readMessages()).filter((m) => !seen.has(m.id) && m.text.includes("PROBE "));
      if (fresh.length > 0) {
        const text = fresh.map((m) => m.text).join("\n");
        expectNoSentinel(text, "the webhook run's message");
        return text;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`the webhook run of ${flowId} recorded no probe message within 30 s`);
  }

  const resolvedAs = (connection: CreatedConnection, ownerKind: "user" | "instance") => ({
    state: "resolved",
    ownerKind,
    connectionId: connection.id,
  });
  /** The typed body an `IntegrationError` is sent as (`integration_http_error`). */
  interface IntegrationErrorDetail {
    error_code?: string;
    hint?: string;
    details?: { reason?: string; missing?: string[] };
  }

  const deniedFor = (reason: string) => ({ state: "denied", code: "connection-not-authorized", reason });

  test(
    "a webhook run resolves the owner's connection only while the opt-in is on, and the instance connection either way",
    { tag: ["@stable", "@api", "@integrations"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        "POST /api/v1/webhook/{flow_id_or_name}",
        "GET /api/v1/monitor/messages",
        "PATCH /api/v1/connections/{connection_id}",
        "POST /api/v1/build/{flow_id}/flow",
      ]);
      const userConnection = await plantUserRow(request, "nonint_webhook");
      expect(userConnection.connection.allow_non_interactive, "a fresh row's opt-in is off").toBe(false);
      const flowId = await ownerFlow(
        request,
        probeFlowSpec([
          { field: "user_connection", handle: `google/${userConnection.name}` },
          { field: "instance_connection", handle: `google/${instanceConnection.name}` },
        ]),
        "webhook",
      );

      await test.step("Contrast: the Playground build resolves the same user row with the opt-in off", async () => {
        const outcomes = parseProbeOutput(await buildText(request, flowId));
        expect(outcomes.user_connection).toEqual(resolvedAs(userConnection, "user"));
        expect(outcomes.instance_connection).toEqual(resolvedAs(instanceConnection, "instance"));
      });

      await test.step("Opt-in off: the webhook run is refused the user row, never the instance row", async () => {
        const outcomes = parseProbeOutput(await webhookText(request, flowId));
        expect(outcomes.user_connection).toEqual(deniedFor(OPT_IN_REASON));
        expect(outcomes.instance_connection).toEqual(resolvedAs(instanceConnection, "instance"));
      });

      await test.step("Opt-in on: the next webhook run resolves the user row", async () => {
        await setOptIn(request, userConnection, true);
        const outcomes = parseProbeOutput(await webhookText(request, flowId));
        expect(outcomes.user_connection).toEqual(resolvedAs(userConnection, "user"));
        expect(outcomes.instance_connection).toEqual(resolvedAs(instanceConnection, "instance"));
      });

      await test.step("Opt-in off again: the very next webhook run is refused again", async () => {
        await setOptIn(request, userConnection, false);
        const outcomes = parseProbeOutput(await webhookText(request, flowId));
        expect(outcomes.user_connection).toEqual(deniedFor(OPT_IN_REASON));
        expect(outcomes.instance_connection).toEqual(resolvedAs(instanceConnection, "instance"));
      });
    },
  );

  /**
   * Submit in background mode, read the pending request at the pause, approve it, and
   * return what the probe BEFORE the pause reported (it became the Human Input prompt)
   * and what the probe AFTER it reported (the resumed run's Chat Output).
   */
  async function hitlRun(request: APIRequestContext, flowId: string): Promise<{ before: string; after: string }> {
    const jobId = await submitBackgroundRun(request, keyHeaders(), {
      flowId,
      sessionId: `e2e-nonint-${run}-${Math.random().toString(36).slice(2, 8)}`,
      inputValue: "probe",
    });
    const waitFor = async (wanted: string): Promise<Record<string, unknown>> => {
      const deadline = Date.now() + 60_000;
      let body: Record<string, unknown> = {};
      while (Date.now() < deadline) {
        const reading = await readJobStatus(request, keyHeaders(), jobId);
        expect(reading.status, reading.text.slice(0, 300)).toBe(200);
        body = reading.body as Record<string, unknown>;
        if (body.status === wanted) return body;
        expect(["queued", "in_progress", "running", "resuming", "suspended"], reading.text.slice(0, 600)).toContain(
          body.status,
        );
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      throw new Error(`job ${jobId} never reached ${wanted}; last status ${JSON.stringify(body).slice(0, 400)}`);
    };
    await waitFor("suspended");
    const pending = await listPendingRequests(request, keyHeaders(), flowId);
    expect(pending.status, pending.text.slice(0, 300)).toBe(200);
    expectNoSentinel(pending.text, "the pending request");
    const row = (pending.body as PendingRequestRow[]).find((r) => r.job_id === jobId) as
      | (PendingRequestRow & { prompt?: string })
      | undefined;
    expect(row, `job ${jobId} is listed as pending`).toBeTruthy();
    const resumed = await resumeJob(request, keyHeaders(), jobId, {
      request_id: row!.request_id,
      decision: { action_id: "approve" },
    });
    expect(resumed.status, resumed.text.slice(0, 300)).toBe(200);
    const done = await waitFor("completed");
    const doneText = JSON.stringify(done);
    expectNoSentinel(doneText, "the completed job");
    const outputs = done.outputs as Record<string, { content?: string }> | undefined;
    return { before: String(row!.prompt ?? ""), after: String(outputs?.["ChatOutput-probe"]?.content ?? "") };
  }

  test(
    "a resumed HITL run is refused the job owner's connection without the opt-in, though the same job resolved it before the pause",
    { tag: ["@stable", "@api", "@integrations"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        "POST /api/v2/workflows",
        "GET /api/v2/workflows",
        "GET /api/v2/workflows/pending",
        "POST /api/v2/workflows/{job_id}/resume",
        "PATCH /api/v1/connections/{connection_id}",
      ]);
      const userConnection = await plantUserRow(request, "nonint_hitl");
      const before = probeFlowSpec([{ field: "before_pause", handle: `google/${userConnection.name}` }]);
      const after = probeFlowSpec([
        { field: "user_connection", handle: `google/${userConnection.name}` },
        { field: "instance_connection", handle: `google/${instanceConnection.name}` },
      ]);
      const beforeProbe = { ...before.nodes[1], id: "CustomComponent-before" };
      const flowId = await ownerFlow(
        request,
        {
          nodes: [after.nodes[0], beforeProbe, { id: "HumanInput-pause", type: "HumanInput" }, after.nodes[1], after.nodes[2]],
          edges: [
            { source: "ChatInput-probe", output: "message", target: "CustomComponent-before", field: "in_text" },
            { source: "CustomComponent-before", output: "output", target: "HumanInput-pause", field: "prompt" },
            { source: "HumanInput-pause", output: "branch_approve", target: "CustomComponent-probe", field: "in_text" },
            after.edges[1],
          ],
        },
        "hitl",
      );

      await test.step("Opt-in off: resolved before the pause, refused after the resume — same job, same caller", async () => {
        const { before: beforeText, after: afterText } = await hitlRun(request, flowId);
        expect(parseProbeOutput(beforeText).before_pause, `before the pause: ${beforeText}`).toEqual(
          resolvedAs(userConnection, "user"),
        );
        const outcomes = parseProbeOutput(afterText);
        expect(outcomes.user_connection, `after the resume: ${afterText}`).toEqual(deniedFor(OPT_IN_REASON));
        expect(outcomes.instance_connection).toEqual(resolvedAs(instanceConnection, "instance"));
      });

      await test.step("Opt-in on: a new job resolves the user row after its resume too", async () => {
        await setOptIn(request, userConnection, true);
        const { after: afterText } = await hitlRun(request, flowId);
        const outcomes = parseProbeOutput(afterText);
        expect(outcomes.user_connection, `after the resume: ${afterText}`).toEqual(resolvedAs(userConnection, "user"));
        expect(outcomes.instance_connection).toEqual(resolvedAs(instanceConnection, "instance"));
      });
    },
  );

  test(
    "a KB connector ingest fails closed without the opt-in, before any ingestion run exists",
    { tag: ["@stable", "@api", "@integrations"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        "POST /api/v1/knowledge_bases/{kb_name}/ingest/connector",
        "GET /api/v1/knowledge_bases/{kb_name}/runs",
        "PATCH /api/v1/connections/{connection_id}",
      ]);
      // No embedding credential is needed to create one, and the ingest never gets
      // far enough to embed anything.
      const kbName = await createKnowledgeBase(
        request,
        {
          name: `E2E nonint ${run} ${Math.random().toString(36).slice(2, 6)}`,
          embeddingProvider: "OpenAI",
          embeddingModel: "text-embedding-3-small",
        },
        { headers: owner.headers },
      );
      cleanups.push((req) => deleteKnowledgeBase(req, kbName, { headers: owner.headers }));
      const userConnection = await plantUserRow(request, "nonint_kb");
      const ingest = async () => {
        const res = await request.post(`/api/v1/knowledge_bases/${kbName}/ingest/connector`, {
          headers: owner.headers,
          data: { source_type: "google_drive", source_config: { connection: `google/${userConnection.name}` } },
        });
        const text = await res.text();
        expectNoSentinel(text, "the ingest response");
        return { status: res.status(), text, detail: (JSON.parse(text) as { detail?: IntegrationErrorDetail }).detail };
      };

      await test.step("Opt-in off: 403, refused on the principal with the opt-in reason and its remedy", async () => {
        const refused = await ingest();
        expect(refused.status, refused.text).toBe(403);
        expect(refused.detail?.error_code).toBe("connection-not-authorized");
        expect(refused.detail?.details?.reason).toBe(OPT_IN_REASON);
        expect(refused.detail?.hint).toBe(OPT_IN_HINT);
      });

      await test.step("Opt-in on: past the principal, to the scope check that comes after it", async () => {
        await setOptIn(request, userConnection, true);
        const refused = await ingest();
        expect(refused.status, refused.text).toBe(403);
        expect(refused.detail?.error_code, "the principal was accepted; the missing scope is what stops it").toBe(
          "scope-missing",
        );
        expect(refused.detail?.details?.missing).toEqual([DRIVE_FILE_SCOPE]);
      });

      await test.step("Neither request started an ingestion run", async () => {
        const res = await request.get(`/api/v1/knowledge_bases/${kbName}/runs`, { headers: owner.headers });
        const text = await res.text();
        expect(res.status(), text).toBe(200);
        expect((JSON.parse(text) as { total: number }).total, text).toBe(0);
      });
    },
  );

  test(
    "an owned connection shadows an instance connection with the same handle, and a refused one never falls back to it",
    { tag: ["@stable", "@api", "@integrations"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        "POST /api/v1/build/{flow_id}/flow",
        "POST /api/v1/webhook/{flow_id_or_name}",
        "DELETE /api/v1/connections/{connection_id}",
      ]);
      // The owned row is deleted mid-test as the contrast; its cleanup is then skipped,
      // because a 404 delete still costs a write.
      const owned = await createConnectionViaApi(request, owner.headers, {
        label: "nonint_shadow",
        credentials: { access_token: sentinel("shadow_owned") },
      });
      let ownedGone = false;
      cleanups.push((req) => (ownedGone ? Promise.resolve() : owned.deleteConnection(req)));
      // Same name, so the same handle. Its own flag is ON: if the refused owned row
      // fell back to it, the webhook run would resolve it.
      const shadowed = await createConnectionViaApi(request, superHeaders, {
        name: owned.name,
        ownershipMode: "instance",
        allowNonInteractive: true,
        credentials: { access_token: sentinel("shadow_instance") },
      });
      cleanups.push((req) => shadowed.deleteConnection(req));
      expect(shadowed.name, "both rows answer to one handle").toBe(owned.name);
      const target: ProbeTarget = { field: "shared_handle", handle: `google/${owned.name}` };
      const flowId = await ownerFlow(request, probeFlowSpec([target]), "shadow");

      await test.step("Interactive: the handle resolves to the owned row, not the instance row", async () => {
        expect(parseProbeOutput(await buildText(request, flowId)).shared_handle).toEqual(resolvedAs(owned, "user"));
      });

      await test.step("Webhook, owned row's opt-in off: refused, with no fallback to the instance row", async () => {
        expect(parseProbeOutput(await webhookText(request, flowId)).shared_handle).toEqual(deniedFor(OPT_IN_REASON));
      });

      await test.step("Contrast: once the owned row is gone, the same webhook resolves the instance row", async () => {
        await owned.deleteConnection(request);
        ownedGone = true;
        expect(parseProbeOutput(await webhookText(request, flowId)).shared_handle).toEqual(
          resolvedAs(shadowed, "instance"),
        );
      });
    },
  );

  test(
    "a Slack app-level token is refused outside the trigger listener, interactive or not",
    { tag: ["@stable", "@api", "@integrations"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        "POST /api/v1/connections",
        "POST /api/v1/build/{flow_id}/flow",
        "POST /api/v1/webhook/{flow_id_or_name}",
        "PATCH /api/v1/connections/{connection_id}",
      ]);
      const appToken = await createConnectionViaApi(request, owner.headers, {
        label: "nonint_xapp",
        providerKey: "slack",
        identity: "bot",
        credentials: { access_token: `xapp-${sentinel("xapp")}` },
      });
      cleanups.push((req) => appToken.deleteConnection(req));
      expect(appToken.connection.granted_scopes, "the server marks the row as an app-level token").toEqual([
        APP_TOKEN_SCOPE,
      ]);
      const flowId = await ownerFlow(request, probeFlowSpec([{ field: "app_token", handle: `slack/${appToken.name}` }]), "xapp");

      await test.step("Interactive: the Playground build is refused with listener-only", async () => {
        expect(parseProbeOutput(await buildText(request, flowId)).app_token).toEqual(deniedFor("listener-only"));
      });

      await test.step("Webhook with the opt-in ON: still listener-only, so the opt-in is not what refuses it", async () => {
        await setOptIn(request, appToken, true);
        expect(parseProbeOutput(await webhookText(request, flowId)).app_token).toEqual(deniedFor("listener-only"));
      });
    },
  );
});
