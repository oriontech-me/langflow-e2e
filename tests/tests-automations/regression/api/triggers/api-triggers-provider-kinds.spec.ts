import type { APIRequestContext, APIResponse } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { type CatalogFlowSpec, createCatalogFlow, fetchComponentCatalog } from "../../../../helpers/flows/build-catalog-flow";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import { type ConnectionsOwner, createConnectionsOwner } from "../../../../helpers/integrations/connections-owner";
import {
  type ConnectionRead,
  type CreatedConnection,
  createConnectionViaApi,
  uniqueConnectionName,
} from "../../../../helpers/integrations/create-connection";
import { servedVersionAtLeast } from "../../../../helpers/other/served-version";
import { jsonBody, mintSigningSecret, signedWebhookHeaders, unixNow } from "../../../../helpers/triggers/sign-webhook";
import { getTrigger, listTriggers, type TriggerRead } from "../../../../helpers/triggers/trigger-api";

// The nine 1.14 providers' trigger kinds: the saved node, and enabling without a connection that could serve it (#2502).
// Spec doc: docs/api/triggers/api-triggers-provider-kinds.md
//
// None of the nine accepts a planted credential (#2501), so no trigger here can arm for real. What is tested is
// every gate `enable` passes before it would call the provider, in the order the server checks them: the handle,
// the provider's own config check, the delivery the deployment supports, `check_ready`, and the provider's
// pre-arm hook. One throwaway user per worker owns the flows, triggers and `pending` connections.

const SINCE = "1.14.0.dev34";
const NODE_ID = "ProviderTrigger-1";

interface Refusal {
  code: string | null;
  message: string;
}

// Exact copy, measured on 1.14.0.dev34.
const NOT_OWNED: Refusal = {
  code: "trigger_connection_not_owned",
  message:
    "The trigger's connection is unavailable. It may have been deleted or may not belong to you. Choose or create " +
    "one of your own connections. Shared and instance connections cannot back a trigger.",
};
const NOT_OWNED_AT_SAVE =
  "The flow owner does not own this connection. Shared and instance connections cannot back a source.";
const PUSH: Refusal = {
  code: null,
  message: "Push delivery requires a supported public HTTPS ingress on this deployment.",
};
const BACKGROUND_RUNS: Refusal = {
  code: "background_runs_not_allowed",
  message: "Turn on Allow background runs for this source connection.",
};
const CONFLUENCE_SPACES: Refusal = {
  code: null,
  message: "Space ID. Configure one to 100 approved Confluence space IDs as a comma-separated server setting.",
};
const WRONG_IDENTITY: Refusal = { code: null, message: "The source connection has the wrong executing identity." };
const missingScopes = (scopes: string): Refusal => ({
  code: null,
  message: `The source connection is missing required scopes: ${scopes}.`,
});
const plain = (message: string): Refusal => ({ code: null, message });
const createRefusal = (kind: string) =>
  `A '${kind}' trigger is created by adding its component to the flow, not through this API.`;
const NO_PROVIDER_INGRESS = "Only inbound webhook triggers have an owner-managed signing secret.";
const NOT_FOUND = '{"detail":"Not found"}';

interface Kind {
  kind: string;
  type: string;
}

interface ProviderTriggers {
  provider: string;
  name: string;
  /** The catalog category every kind of this provider sits in. */
  category: string;
  kinds: Kind[];
  /** Config every one of the provider's checks accepts, so only the connection can stop `enable`. */
  values: Record<string, unknown>;
  /** What the save writes to `last_error` for a handle no connection carries. */
  unboundAtSave: string;
  /** The provider's own refusal of another provider's connection. */
  foreign: string;
  /** Push and Confluence stop before the connection is bound; poll and gateway kinds bind it at save. */
  bindsPending: boolean;
  pendingOff: Refusal;
  pendingOn: Refusal;
  /** A `pending` row shaped to pass `check_ready`, refused by the provider's own pre-arm hook. */
  prearm?: { identity: "user_delegated" | "bot" | "service"; scopes: string[]; refusal: Refusal };
}

const PROVIDERS: ProviderTriggers[] = [
  {
    provider: "github",
    name: "GitHub",
    category: "github",
    kinds: [
      { kind: "github.issue", type: "ext:github:GitHubOnIssueTriggerComponent@official" },
      { kind: "github.pull_request", type: "ext:github:GitHubOnPullRequestTriggerComponent@official" },
    ],
    values: { repository: "octocat/hello-world" },
    unboundAtSave: NOT_OWNED_AT_SAVE,
    foreign: "Choose a GitHub App installation connection.",
    bindsPending: false,
    pendingOff: PUSH,
    pendingOn: PUSH,
  },
  {
    provider: "gitlab",
    name: "GitLab",
    category: "gitlab",
    kinds: [
      { kind: "gitlab.issue", type: "ext:gitlab:GitLabOnIssueTriggerComponent@official" },
      { kind: "gitlab.merge_request", type: "ext:gitlab:GitLabOnMergeRequestTriggerComponent@official" },
    ],
    values: { project_id: 278964 },
    unboundAtSave: NOT_OWNED_AT_SAVE,
    foreign: "Choose a GitLab connection.",
    bindsPending: false,
    pendingOff: PUSH,
    pendingOn: PUSH,
  },
  {
    provider: "whatsapp",
    name: "WhatsApp",
    category: "whatsapp",
    kinds: [{ kind: "whatsapp.event", type: "ext:whatsapp:WhatsAppOnEventTriggerComponent@official" }],
    values: {},
    unboundAtSave: NOT_OWNED_AT_SAVE,
    foreign: "Use a WhatsApp connection.",
    bindsPending: false,
    pendingOff: PUSH,
    pendingOn: PUSH,
  },
  {
    provider: "jira",
    name: "Jira",
    category: "jira",
    kinds: [
      { kind: "jira.issue_created", type: "ext:jira:JiraOnIssueCreatedTriggerComponent@official" },
      { kind: "jira.issue_updated", type: "ext:jira:JiraOnIssueUpdatedTriggerComponent@official" },
      { kind: "jira.issue_status", type: "ext:jira:JiraOnIssueStatusChangedTriggerComponent@official" },
    ],
    values: { project: "DEMO" },
    unboundAtSave: NOT_OWNED_AT_SAVE,
    foreign: "Choose an owned Jira connection.",
    bindsPending: true,
    pendingOff: BACKGROUND_RUNS,
    pendingOn: missingScopes("offline_access, read:jira-work"),
  },
  {
    provider: "confluence",
    name: "Confluence",
    category: "confluence_integrations",
    kinds: [
      {
        kind: "confluence.page_created",
        type: "ext:confluence_integrations:ConfluenceOnPageCreatedTriggerComponent@official",
      },
      {
        kind: "confluence.page_updated",
        type: "ext:confluence_integrations:ConfluenceOnPageUpdatedTriggerComponent@official",
      },
    ],
    values: { space_id: "456" },
    unboundAtSave: CONFLUENCE_SPACES.message,
    foreign: "Choose an owned Confluence connection.",
    bindsPending: false,
    pendingOff: CONFLUENCE_SPACES,
    pendingOn: CONFLUENCE_SPACES,
  },
  {
    provider: "salesforce",
    name: "Salesforce",
    category: "salesforce",
    kinds: [{ kind: "salesforce.record", type: "ext:salesforce:SalesforceOnRecordTriggerComponent@official" }],
    values: {},
    unboundAtSave: NOT_OWNED_AT_SAVE,
    foreign: "Choose an owned Salesforce connection.",
    bindsPending: true,
    pendingOff: BACKGROUND_RUNS,
    pendingOn: missingScopes("api, refresh_token"),
  },
  {
    provider: "servicenow",
    name: "ServiceNow",
    category: "servicenow",
    kinds: [
      { kind: "servicenow.ticket_created", type: "ext:servicenow:ServiceNowOnTicketCreatedTriggerComponent@official" },
      { kind: "servicenow.status_changed", type: "ext:servicenow:ServiceNowOnStatusChangeTriggerComponent@official" },
    ],
    values: {},
    unboundAtSave: NOT_OWNED_AT_SAVE,
    // The server's generic sentence, which names the provider by its id.
    foreign: "Choose a servicenow connection for this source.",
    bindsPending: true,
    pendingOff: BACKGROUND_RUNS,
    pendingOn: missingScopes("langflow_table_read"),
    prearm: {
      identity: "user_delegated",
      scopes: ["langflow_table_read"],
      refusal: plain("Reconnect ServiceNow to the configured instance before enabling this source."),
    },
  },
  {
    provider: "discord",
    name: "Discord",
    category: "discord",
    kinds: [
      { kind: "discord.message", type: "ext:discord:DiscordOnMessageTriggerComponent@official" },
      { kind: "discord.mention", type: "ext:discord:DiscordOnMentionTriggerComponent@official" },
    ],
    values: { guild_id: "123456789012345678", channel_ids: ["123456789012345679"] },
    unboundAtSave: NOT_OWNED_AT_SAVE,
    foreign: "Choose a Discord connection.",
    bindsPending: true,
    pendingOff: BACKGROUND_RUNS,
    pendingOn: WRONG_IDENTITY,
    prearm: { identity: "bot", scopes: [], refusal: plain("Reconnect Discord to verify the bot identity.") },
  },
  {
    provider: "telegram",
    name: "Telegram",
    category: "telegram",
    kinds: [
      { kind: "telegram.message", type: "ext:telegram:TelegramOnMessageTriggerComponent@official" },
      { kind: "telegram.command", type: "ext:telegram:TelegramOnCommandTriggerComponent@official" },
    ],
    values: { allowed_chats: ["12345"] },
    unboundAtSave: NOT_OWNED_AT_SAVE,
    foreign: "Choose a Telegram connection for this trigger.",
    bindsPending: true,
    pendingOff: BACKGROUND_RUNS,
    pendingOn: WRONG_IDENTITY,
    prearm: {
      identity: "bot",
      scopes: [],
      refusal: plain("Reconnect Telegram to verify the bot identity before enabling a trigger."),
    },
  },
];
const ALL_KINDS = PROVIDERS.flatMap((p) => p.kinds.map((k) => ({ ...k, category: p.category })));
const providerOf = (provider: string): ProviderTriggers => {
  const found = PROVIDERS.find((candidate) => candidate.provider === provider);
  if (!found) throw new Error(`no provider declared for ${provider}`);
  return found;
};

test.describe("Triggers API — the nine 1.14 providers' trigger kinds", () => {
  let owner: ConnectionsOwner;
  let catalog: Record<string, unknown>;
  // Another provider's connection, one per worker: every provider test binds its nodes to it.
  let foreign: CreatedConnection;
  const flows: string[] = [];

  test.beforeAll(async ({ playwright }, testInfo) => {
    owner = await createConnectionsOwner(
      () => playwright.request.newContext({ baseURL: testInfo.project.use.baseURL }),
      "trgkinds",
    );
    const context = await playwright.request.newContext({ baseURL: testInfo.project.use.baseURL });
    try {
      foreign = await createConnectionViaApi(context, owner.headers, {
        label: "trgkind_foreign",
        providerKey: "google",
        credentials: null,
      });
    } finally {
      await context.dispose();
    }
  });

  test.beforeEach(async ({ request }) => {
    test.skip(
      !(await servedVersionAtLeast(request, SINCE)),
      `the nine providers' trigger refusals were measured on ${SINCE}; this build may answer differently`,
    );
  });

  test.afterEach(async ({ request }) => {
    const failures: string[] = [];
    // Deleting a flow takes its trigger rows with it.
    for (const id of flows.splice(0)) {
      await deleteFlow(request, id, { headers: owner.headers }).catch((error) => failures.push(String(error)));
    }
    expect(failures, "every flow this test created is deleted").toEqual([]);
  });

  test.afterAll(async () => {
    // The connections are left to this: deleting the user takes them with it. A DELETE per
    // connection would spend the same per-user write bucket (30/min) the creates need.
    await owner?.dispose();
  });

  const unboundHandle = (provider: string) => `${provider}/${uniqueConnectionName("trgkind_missing")}`;

  async function saveFlow(request: APIRequestContext, nodes: CatalogFlowSpec["nodes"], edges: CatalogFlowSpec["edges"] = []) {
    catalog ??= await fetchComponentCatalog(request, owner.headers);
    const flowId = await createCatalogFlow(
      request,
      catalog,
      { nodes, edges },
      { name: `e2e-2502-trigger-kinds-${uniqueConnectionName("flow")}`, headers: owner.headers },
    );
    flows.push(flowId);
    return flowId;
  }

  /** Saves one trigger node bound to `handle` and returns the one row the save reconciled. */
  async function saveTrigger(
    request: APIRequestContext,
    subject: ProviderTriggers,
    kind: Kind,
    handle: string,
  ): Promise<TriggerRead> {
    const flowId = await saveFlow(request, [{ id: NODE_ID, type: kind.type, values: { ...subject.values, connection: handle } }]);
    let saved: TriggerRead[] = [];
    await expect
      .poll(async () => (saved = await listTriggers(request, owner.headers, { flow_id: flowId })).length, {
        message: `the save reconciles the ${kind.kind} node into one row`,
        timeout: 15_000,
      })
      .toBe(1);
    expect(saved[0], "the row is the node's, of its kind and provider, and not armed").toMatchObject({
      kind: kind.kind,
      provider: subject.provider,
      node_id: NODE_ID,
      state: "pending",
    });
    return saved[0];
  }

  async function createPending(
    request: APIRequestContext,
    provider: string,
    shape: { allowNonInteractive?: boolean; identity?: "user_delegated" | "bot" | "service"; grantedScopes?: string[] } = {},
  ): Promise<CreatedConnection> {
    return createConnectionViaApi(request, owner.headers, {
      label: "trgkind_pending",
      providerKey: provider,
      credentials: null,
      ...shape,
    });
  }

  async function readConnection(request: APIRequestContext, connection: CreatedConnection): Promise<ConnectionRead> {
    const res = await request.get("/api/v1/connections", { headers: owner.headers });
    const text = await res.text();
    expect(res.status(), text).toBe(200);
    const read = (JSON.parse(text) as ConnectionRead[]).find((candidate) => candidate.id === connection.id);
    expect(read, `connection ${connection.name} is listed`).toBeDefined();
    return read as ConnectionRead;
  }

  async function enable(request: APIRequestContext, triggerId: string): Promise<APIResponse> {
    return request.post(`/api/v1/triggers/${triggerId}/enable`, { headers: owner.headers });
  }

  /** `enable` is refused with exactly `refusal`, and the row is left as the save wrote it. */
  async function expectRefused(request: APIRequestContext, row: TriggerRead, refusal: Refusal): Promise<void> {
    const res = await enable(request, row.id);
    const text = await res.text();
    expect(res.status(), text).toBe(409);
    expect(JSON.parse(text)).toEqual({ detail: refusal });
    const after = await getTrigger(request, owner.headers, row.id);
    expect(after, "a refused enable leaves the row as the save wrote it").toMatchObject({
      state: "pending",
      reason: row.reason,
      last_error: row.last_error,
      connection_id: row.connection_id,
    });
  }

  /** The row a save writes over a `pending` connection of the trigger's own provider, background runs off. */
  function savedOverPending(subject: ProviderTriggers, connection: CreatedConnection): Partial<TriggerRead> {
    return subject.bindsPending
      ? { connection_id: connection.id, reason: "pending", last_error: null }
      : { connection_id: null, reason: "config_invalid", last_error: subject.pendingOff.message };
  }

  /** The provider's pre-arm case, when it has one: a `pending` row shaped to pass `check_ready`. */
  async function createPrearmed(
    request: APIRequestContext,
    subject: ProviderTriggers,
  ): Promise<Array<{ connection: CreatedConnection; refusal: Refusal }>> {
    if (!subject.prearm) return [];
    const connection = await createPending(request, subject.provider, {
      allowNonInteractive: true,
      identity: subject.prearm.identity,
      grantedScopes: subject.prearm.scopes,
    });
    return [{ connection, refusal: subject.prearm.refusal }];
  }

  test(
    "the seventeen 1.14 provider kinds are served as trigger components and cannot be created through the triggers API",
    { tag: ["@stable", "@api", "@integrations"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare(["GET /api/v1/all", "POST /api/v1/triggers", "GET /api/v1/triggers"]);
      expect(ALL_KINDS, "nine providers, seventeen kinds").toHaveLength(17);

      await test.step("each kind is a component in its provider's category, carrying its trigger kind", async () => {
        const res = await request.get("/api/v1/all", { headers: owner.headers });
        expect(res.status()).toBe(200);
        const all = (await res.json()) as Record<string, Record<string, { metadata?: { trigger_kind?: string } }>>;
        for (const { kind, type, category } of ALL_KINDS) {
          expect(all[category]?.[type]?.metadata?.trigger_kind, `${type} in ${category}`).toBe(kind);
        }
      });

      await test.step("POST /api/v1/triggers refuses every one of them, and writes nothing", async () => {
        const flowId = await saveFlow(request, [{ id: "ChatOutput-1", type: "ChatOutput" }]);
        for (const { kind } of ALL_KINDS) {
          const res = await request.post("/api/v1/triggers", {
            headers: owner.headers,
            data: { flow_id: flowId, name: `E2E ${kind}`, kind },
          });
          const text = await res.text();
          expect(res.status(), `${kind}: ${text}`).toBe(422);
          expect(JSON.parse(text)).toEqual({ detail: createRefusal(kind) });
        }
        expect(await listTriggers(request, owner.headers, { flow_id: flowId })).toEqual([]);
      });
    },
  );

  for (const subject of PROVIDERS) {
    test(
      `${subject.name}: each kind's saved node reconciles one pending trigger, and enable refuses it until a ${subject.name} connection could serve it`,
      { tag: ["@stable", "@api", "@integrations"] },
      async ({ request, apiCoverage }) => {
        apiCoverage.declare([
          "POST /api/v1/connections",
          "GET /api/v1/connections",
          "GET /api/v1/triggers",
          "GET /api/v1/triggers/{trigger_id}",
          "POST /api/v1/triggers/{trigger_id}/enable",
        ]);
        const pendingOff = await createPending(request, subject.provider);
        const pendingOn = await createPending(request, subject.provider, { allowNonInteractive: true });
        const prearms = await createPrearmed(request, subject);

        for (const kind of subject.kinds) {
          await test.step(`${kind.kind}: a handle no connection carries is refused as not owned`, async () => {
            const row = await saveTrigger(request, subject, kind, unboundHandle(subject.provider));
            expect(row).toMatchObject({ connection_id: null, reason: "config_invalid", last_error: subject.unboundAtSave });
            await expectRefused(request, row, NOT_OWNED);
          });

          await test.step(`${kind.kind}: another provider's connection is refused with ${subject.name}'s own sentence`, async () => {
            const row = await saveTrigger(request, subject, kind, `google/${foreign.name}`);
            expect(row).toMatchObject({ connection_id: null, reason: "config_invalid", last_error: subject.foreign });
            await expectRefused(request, row, plain(subject.foreign));
          });

          await test.step(`${kind.kind}: a pending connection, background runs off`, async () => {
            const row = await saveTrigger(request, subject, kind, `${subject.provider}/${pendingOff.name}`);
            expect(row, "poll and gateway kinds bind the connection at save; push and Confluence stop first").toMatchObject(
              savedOverPending(subject, pendingOff),
            );
            await expectRefused(request, row, subject.pendingOff);
          });

          await test.step(`${kind.kind}: a pending connection, background runs on`, async () => {
            const row = await saveTrigger(request, subject, kind, `${subject.provider}/${pendingOn.name}`);
            await expectRefused(request, row, subject.pendingOn);
          });

          for (const { connection, refusal } of prearms) {
            await test.step(`${kind.kind}: a pending connection that passes check_ready is refused by ${subject.name}'s pre-arm hook`, async () => {
              const row = await saveTrigger(request, subject, kind, `${subject.provider}/${connection.name}`);
              await expectRefused(request, row, refusal);
            });
          }
        }

        await test.step("no connection was changed by the refusals", async () => {
          for (const connection of [pendingOff, pendingOn, ...prearms.map((p) => p.connection)]) {
            expect(await readConnection(request, connection)).toMatchObject({ status: "pending", has_credentials: false });
          }
        });
      },
    );
  }

  test(
    "a delivery to a push provider's ingress answers the uniform 404, for an id that exists and one that does not",
    { tag: ["@stable", "@api", "@integrations"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        "POST /api/v1/triggers/{trigger_id}/enable",
        "POST /api/v1/triggers/{trigger_id}/signing-secret",
        "GET /api/v1/triggers/{trigger_id}/ingress",
        "POST /api/v1/triggers/ingress/{provider}/{public_id}",
        "GET /api/v1/triggers/ingress/{provider}/{public_id}",
      ]);
      const ingress = (provider: string, id: string) => `/api/v1/triggers/ingress/${provider}/${id}`;
      const randomId = `e2e${Math.random().toString(36).slice(2, 14)}${Date.now().toString(36)}`;
      const delivery = (label: string) => jsonBody({ e2e: label, at: Date.now() });

      // An armed inbound webhook gives a real public id and a secret it accepts.
      const webhookFlow = await saveFlow(
        request,
        [
          { id: "InboundWebhookTrigger-k01", type: "InboundWebhookTrigger" },
          { id: "ChatOutput-k01", type: "ChatOutput" },
        ],
        [{ source: "InboundWebhookTrigger-k01", output: "trigger_event", target: "ChatOutput-k01", field: "input_value" }],
      );
      let webhook: TriggerRead[] = [];
      await expect
        .poll(async () => (webhook = await listTriggers(request, owner.headers, { flow_id: webhookFlow })).length, {
          timeout: 15_000,
        })
        .toBe(1);
      const armed = await enable(request, webhook[0].id);
      expect(armed.status(), await armed.text()).toBe(200);
      const minted = await mintSigningSecret(request, webhook[0].id, owner.headers);

      const post = async (path: string, headers: Record<string, string>, body: Buffer) => {
        const res = await request.post(path, { headers, data: body });
        return { status: res.status(), body: await res.text() };
      };
      const signed = (body: Buffer) => signedWebhookHeaders(minted.secret, unixNow(), body);

      await test.step("control: the signed delivery is accepted on the webhook segment", async () => {
        const body = delivery("control");
        expect((await post(ingress("webhook", minted.publicId), signed(body), body)).status).toBe(202);
      });

      const baseline = await post(ingress("nosuch", minted.publicId), signed(delivery("nosuch")), delivery("nosuch"));
      expect(baseline, "an unknown provider segment is the uniform 404").toEqual({ status: 404, body: NOT_FOUND });

      await test.step("a provider trigger has no ingress of its own to read", async () => {
        const row = await saveTrigger(request, providerOf("github"), providerOf("github").kinds[0], unboundHandle("github"));
        const res = await request.get(`/api/v1/triggers/${row.id}/ingress`, { headers: owner.headers });
        const text = await res.text();
        expect(res.status(), text).toBe(409);
        expect(JSON.parse(text)).toEqual({ detail: NO_PROVIDER_INGRESS });

        for (const provider of ["github", "gitlab", "telegram", "whatsapp"]) {
          const body = delivery(provider);
          expect(await post(ingress(provider, row.id), signed(body), body), `${provider}: the trigger's own UUID`).toEqual(
            baseline,
          );
        }
      });

      for (const provider of ["github", "gitlab", "telegram", "whatsapp"]) {
        await test.step(`${provider}: an existing id, a random one and the provider's own headers all read the same 404`, async () => {
          const body = delivery(provider);
          expect(await post(ingress(provider, minted.publicId), signed(body), body), "the webhook's real public id").toEqual(
            baseline,
          );
          expect(await post(ingress(provider, randomId), signed(body), body), "an id that names nothing").toEqual(baseline);
          const providerHeaders: Record<string, Record<string, string>> = {
            github: { "X-GitHub-Event": "issues", "X-GitHub-Delivery": "e2e-2502", "X-Hub-Signature-256": "sha256=00" },
            gitlab: { "X-Gitlab-Event": "Issue Hook", "X-Gitlab-Token": minted.secret },
            telegram: { "X-Telegram-Bot-Api-Secret-Token": minted.secret },
            whatsapp: { "X-Hub-Signature-256": "sha256=00" },
          };
          expect(
            await post(ingress(provider, minted.publicId), { "content-type": "application/json", ...providerHeaders[provider] }, body),
            "a delivery shaped like the provider's own",
          ).toEqual(baseline);
        });
      }

      await test.step("WhatsApp's GET verification handshake reads the same 404", async () => {
        for (const id of [minted.publicId, randomId]) {
          const res = await request.get(ingress("whatsapp", id), {
            params: { "hub.mode": "subscribe", "hub.verify_token": minted.secret, "hub.challenge": "2502" },
          });
          expect({ status: res.status(), body: await res.text() }).toEqual(baseline);
        }
      });
    },
  );

  test(
    "Lead (no upstream ticket yet): a Jira or Salesforce trigger arms on a pending connection that holds no credential",
    { tag: ["@stable", "@api", "@integrations"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        "POST /api/v1/connections",
        "GET /api/v1/connections",
        "GET /api/v1/triggers/{trigger_id}",
        "POST /api/v1/triggers/{trigger_id}/enable",
      ]);
      const cases = [
        { subject: providerOf("jira"), kind: providerOf("jira").kinds[0], scopes: ["read:jira-work", "offline_access"] },
        { subject: providerOf("salesforce"), kind: providerOf("salesforce").kinds[0], scopes: ["api", "refresh_token"] },
      ];
      for (const { subject, kind, scopes } of cases) {
        await test.step(`${kind.kind}: enable answers 200 over a connection with no credential`, async () => {
          const connection = await createPending(request, subject.provider, {
            allowNonInteractive: true,
            grantedScopes: scopes,
          });
          expect(await readConnection(request, connection)).toMatchObject({ status: "pending", has_credentials: false });
          const row = await saveTrigger(request, subject, kind, `${subject.provider}/${connection.name}`);
          const res = await enable(request, row.id);
          const text = await res.text();
          // Today's behaviour, not the contract: check_ready treats only revoked and expired as unusable.
          // When this goes red because pending is refused, the refusal is the contract — flip the test to it.
          expect(res.status(), text).toBe(200);
          expect(JSON.parse(text)).toMatchObject({ state: "active", last_error: null, connection_id: connection.id });

          await new Promise((resolve) => setTimeout(resolve, 5_000));
          expect(await getTrigger(request, owner.headers, row.id), "it stays armed, with nothing to say why it cannot fire").toMatchObject({
            state: "active",
            last_error: null,
          });
          expect(await readConnection(request, connection)).toMatchObject({ status: "pending", has_credentials: false });
        });
      }
    },
  );
});
