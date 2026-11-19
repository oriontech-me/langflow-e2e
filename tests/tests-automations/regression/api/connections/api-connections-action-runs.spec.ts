import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { parseStreamEvents } from "../../../../fixtures/flow-error-policy";
import { createCatalogFlow, fetchComponentCatalog } from "../../../../helpers/flows/build-catalog-flow";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import { type ConnectionsOwner, createConnectionsOwner } from "../../../../helpers/integrations/connections-owner";
import {
  type ConnectionRead,
  type CreatedConnection,
  createConnectionViaApi,
  uniqueConnectionName,
} from "../../../../helpers/integrations/create-connection";
import { servedVersionAtLeast } from "../../../../helpers/other/served-version";

// The nine 1.14 providers' actions at run time, with no connection to resolve (#2501).
// Spec doc: docs/api/connections/api-connections-action-runs.md
//
// None of the nine accepts a planted credential, so every run here fails inside the
// instance, before any call could leave it. One throwaway user owns this file's flows and
// `pending` rows, so they spend that user's write bucket and never the superuser's.

const PROVIDERS_SINCE = "1.14.0.dev23";
const COLLECTION = "/api/v1/connections";

// Exact copy, measured on 1.14.0.dev32 (lfx/integrations/errors.py and each bundle's validators).
const INPUTS_HINT = "Check the action's inputs and try again.";
const unresolved = (handle: string) => {
  const hint = "Configure the connection for this execution environment.";
  return `Connection '${handle}' could not be resolved. ${hint}\n\n${hint}`;
};
const CONFLUENCE_SPACES_UNSET = "Configure one to 100 approved Confluence space IDs as a comma-separated server setting.";
const WHATSAPP_BAD_RECIPIENT = "Use a recipient phone number with country code and digits only.";

interface Malformed {
  field: string;
  value: unknown;
  message: string;
}

interface ProviderAction {
  provider: string;
  name: string;
  /** Catalog key of the action this file runs. */
  type: string;
  /** Inputs every validator accepts, so only the connection can stop the run. */
  wellFormed: Record<string, unknown>;
  /** A malformed input the bundle refuses before it looks the connection up. */
  malformed?: Malformed;
}

const ACTIONS: ProviderAction[] = [
  {
    provider: "github",
    name: "GitHub",
    type: "ext:github:GitHubGetRepositoryComponent@official",
    wellFormed: { repository: "octocat/hello-world" },
    malformed: {
      field: "repository",
      value: "not-a-repo",
      message: "Use a GitHub.com repository in owner/repository form.",
    },
  },
  {
    provider: "gitlab",
    name: "GitLab",
    type: "ext:gitlab:GitLabGetProjectComponent@official",
    wellFormed: { project_id: 278964 },
    malformed: {
      field: "project_id",
      value: 0,
      message: "Project ID must be an integer from 1 to 9223372036854775807 (the signed 64-bit range).",
    },
  },
  {
    provider: "jira",
    name: "Jira",
    type: "ext:jira:JiraReadIssueComponent@official",
    wellFormed: { issue: "DEMO-123" },
    malformed: { field: "issue", value: "demo-123", message: "Use a Jira issue key such as DEMO-123." },
  },
  {
    provider: "confluence",
    name: "Confluence",
    type: "ext:confluence_integrations:ConfluenceReadPageComponent@official",
    wellFormed: { page_id: "123", space_id: "456" },
    malformed: { field: "space_id", value: "abc", message: "Use a positive Confluence numeric ID within 19 digits." },
  },
  {
    provider: "salesforce",
    name: "Salesforce",
    type: "ext:salesforce:SalesforceReadRecordComponent@official",
    wellFormed: { record_id: "001000000000001AAA" },
    malformed: {
      field: "record_id",
      value: "123",
      message: "A Salesforce record ID must contain 15 or 18 alphanumeric characters.",
    },
  },
  {
    provider: "servicenow",
    name: "ServiceNow",
    type: "ext:servicenow:ServiceNowReadRecordComponent@official",
    wellFormed: { record_id: "0123456789abcdef0123456789abcdef" },
  },
  {
    provider: "discord",
    name: "Discord",
    type: "ext:discord:DiscordSendMessageComponent@official",
    wellFormed: { guild_id: "123456789012345678", channel_id: "123456789012345679", text: "hi" },
    malformed: { field: "channel_id", value: "abc", message: "Use a numeric Discord ID copied from developer mode." },
  },
  {
    provider: "telegram",
    name: "Telegram",
    type: "ext:telegram:TelegramSendMessageComponent@official",
    wellFormed: { chat_id: "12345", text: "hi" },
    malformed: { field: "chat_id", value: "abc", message: "Use a numeric Telegram ID." },
  },
  {
    provider: "whatsapp",
    name: "WhatsApp",
    type: "ext:whatsapp:WhatsAppSendTextComponent@official",
    wellFormed: { to: "+15551234567", text: "hi" },
  },
];
const action = (provider: string): ProviderAction => {
  const found = ACTIONS.find((candidate) => candidate.provider === provider);
  if (!found) throw new Error(`no action declared for ${provider}`);
  return found;
};

interface RunError {
  type: "RUN_ERROR";
  code?: string;
  message?: string;
}

test.describe("Connections API — the nine 1.14 providers' actions at run time", () => {
  let owner: ConnectionsOwner;
  let catalog: Record<string, unknown>;
  const flows: string[] = [];
  const rows: CreatedConnection[] = [];

  test.beforeAll(async ({ playwright }, testInfo) => {
    owner = await createConnectionsOwner(
      () => playwright.request.newContext({ baseURL: testInfo.project.use.baseURL }),
      "actionruns",
    );
  });

  test.beforeEach(async ({ request }) => {
    test.skip(
      !(await servedVersionAtLeast(request, PROVIDERS_SINCE)),
      `the nine providers' bundles are served from ${PROVIDERS_SINCE}`,
    );
  });

  test.afterEach(async ({ request }) => {
    const failures: string[] = [];
    for (const id of flows.splice(0)) {
      await deleteFlow(request, id, { headers: owner.headers }).catch((error) => failures.push(String(error)));
    }
    for (const row of rows.splice(0)) {
      await row.deleteConnection(request).catch((error) => failures.push(String(error)));
    }
    expect(failures, "every flow and row this test created is deleted").toEqual([]);
  });

  test.afterAll(async () => {
    // Deleting the user takes its connections with it.
    await owner?.dispose();
  });

  const unboundHandle = (provider: string) => `${provider}/${uniqueConnectionName("actionrun_missing")}`;

  /** Saves the action, one node, bound to `handle`. */
  async function saveAction(
    request: APIRequestContext,
    subject: ProviderAction,
    handle: string,
    values: Record<string, unknown>,
  ): Promise<string> {
    catalog ??= await fetchComponentCatalog(request, owner.headers);
    const flowId = await createCatalogFlow(
      request,
      catalog,
      { nodes: [{ id: "Action-1", type: subject.type, values: { ...values, connection: handle } }], edges: [] },
      { name: `e2e-2501-action-runs-${uniqueConnectionName(subject.provider)}`, headers: owner.headers },
    );
    flows.push(flowId);
    return flowId;
  }

  /** Runs a saved flow the way the canvas does (AG-UI stream) and returns its one `RUN_ERROR`. */
  async function runForError(request: APIRequestContext, flowId: string): Promise<RunError> {
    const res = await request.post("/api/v2/workflows", {
      headers: owner.headers,
      data: { flow_id: flowId, input_value: "", mode: "stream", stream_protocol: "agui" },
      timeout: 60_000,
    });
    const body = await res.text();
    expect(res.status(), body.slice(0, 500)).toBe(200);
    const errors = parseStreamEvents(body).filter(
      (event): event is RunError => (event as { type?: unknown } | null)?.type === "RUN_ERROR",
    );
    expect(errors, `exactly one RUN_ERROR in: ${body.slice(0, 500)}`).toHaveLength(1);
    return errors[0];
  }

  async function createPendingRow(request: APIRequestContext, provider: string): Promise<CreatedConnection> {
    const row = await createConnectionViaApi(request, owner.headers, {
      label: "actionrun_pending",
      providerKey: provider,
      credentials: null,
    });
    rows.push(row);
    return row;
  }

  async function expectStillPending(request: APIRequestContext, row: CreatedConnection): Promise<void> {
    const res = await request.get(COLLECTION, { headers: owner.headers });
    expect(res.status(), await res.text()).toBe(200);
    const read = ((await res.json()) as ConnectionRead[]).find((candidate) => candidate.id === row.id);
    expect(read, "the row is still listed after the run").toMatchObject({
      status: "pending",
      has_credentials: false,
    });
  }

  for (const subject of ACTIONS.filter((candidate) => candidate.provider !== "confluence")) {
    test(
      `${subject.name}: an unbound handle and a pending row both fail the run with connection-unresolved, naming the handle`,
      { tag: ["@stable", "@api", "@integrations"] },
      async ({ request, apiCoverage }) => {
        apiCoverage.declare(["POST /api/v2/workflows", "POST /api/v1/connections", "GET /api/v1/connections"]);

        await test.step("a handle no row carries is unresolved, and the message names it", async () => {
          const handle = unboundHandle(subject.provider);
          const error = await runForError(request, await saveAction(request, subject, handle, subject.wellFormed));
          expect(error).toMatchObject({ code: "connection-unresolved", message: unresolved(handle) });
        });

        const row = await createPendingRow(request, subject.provider);
        const handle = `${subject.provider}/${row.name}`;

        await test.step("a pending row reads exactly the same, naming its own handle", async () => {
          const error = await runForError(request, await saveAction(request, subject, handle, subject.wellFormed));
          expect(error).toMatchObject({ code: "connection-unresolved", message: unresolved(handle) });
        });

        await test.step("the run leaves the row pending, with no credential", async () => {
          await expectStillPending(request, row);
        });

        if (subject.provider === "servicenow") {
          await test.step("ServiceNow resolves before it validates: a malformed record id still reads unresolved", async () => {
            const unbound = unboundHandle(subject.provider);
            const error = await runForError(
              request,
              await saveAction(request, subject, unbound, { ...subject.wellFormed, record_id: "XYZ" }),
            );
            expect(error).toMatchObject({ code: "connection-unresolved", message: unresolved(unbound) });
          });
        }
      },
    );
  }

  for (const subject of ACTIONS.filter((candidate) => candidate.malformed)) {
    const malformed = subject.malformed as Malformed;

    test(
      `${subject.name}: a malformed ${malformed.field} is refused before the connection is looked up, with the bundle's own copy`,
      { tag: ["@stable", "@api", "@integrations"] },
      async ({ request, apiCoverage }) => {
        apiCoverage.declare(["POST /api/v2/workflows"]);
        const values = { ...subject.wellFormed, [malformed.field]: malformed.value };
        const error = await runForError(
          request,
          await saveAction(request, subject, unboundHandle(subject.provider), values),
        );
        // The handle is unbound, so reading invalid-request IS the proof that validation ran first.
        expect(error).toMatchObject({ code: "invalid-request", message: `${malformed.message}\n\n${INPUTS_HINT}` });
      },
    );
  }

  test(
    "WhatsApp: a malformed recipient is refused before the connection is looked up, as a plain error with no integration code",
    { tag: ["@stable", "@api", "@integrations"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare(["POST /api/v2/workflows"]);
      const subject = action("whatsapp");
      const error = await runForError(
        request,
        await saveAction(request, subject, unboundHandle(subject.provider), { ...subject.wellFormed, to: "abc" }),
      );
      expect(error.message, "the recipient check's own copy, with no hint after it").toBe(WHATSAPP_BAD_RECIPIENT);
      // recipient() raises a bare ValueError, unlike the other bundles' InvalidRequestError (measured, 1.14.0.dev32).
      // If WhatsApp moves onto the integration error, this fails by name: update the spec doc with it.
      expect(error.code, "a ValueError carries no integration code").toBeUndefined();
    },
  );

  test(
    "Confluence: an unconfigured approved-space setting stops the action before its connection is looked up",
    { tag: ["@stable", "@api", "@integrations"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare(["POST /api/v2/workflows", "POST /api/v1/connections", "GET /api/v1/connections"]);
      const subject = action("confluence");
      const expected = { code: "invalid-request", message: `${CONFLUENCE_SPACES_UNSET}\n\n${INPUTS_HINT}` };

      await test.step("an unbound handle never reaches the resolver", async () => {
        const error = await runForError(
          request,
          await saveAction(request, subject, unboundHandle(subject.provider), subject.wellFormed),
        );
        expect(error).toMatchObject(expected);
      });

      const row = await createPendingRow(request, subject.provider);

      await test.step("a pending row reads the same setting, and stays pending", async () => {
        const error = await runForError(
          request,
          await saveAction(request, subject, `${subject.provider}/${row.name}`, subject.wellFormed),
        );
        expect(error).toMatchObject(expected);
        await expectStillPending(request, row);
      });
    },
  );
});
