import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { buildCatalogFlow, findCatalogComponent } from "../../../../helpers/flows/build-catalog-flow";
import { fetchComponentCatalog } from "../../../../helpers/flows/build-custom-component-graph";
import { createFlow } from "../../../../helpers/flows/create-flow";
import { type CreatedProject, createProjectViaApi } from "../../../../helpers/flows/create-project-via-api";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import { type ConnectionsOwner, createConnectionsOwner } from "../../../../helpers/integrations/connections-owner";
import {
  type ConnectionRead,
  type CreateConnectionOptions,
  type CreatedConnection,
  createConnectionViaApi,
  uniqueConnectionName,
} from "../../../../helpers/integrations/create-connection";

// The small reachable details of the connections surface (#2305): the positive
// provider filter, the revocation outcome and its toast, the deployment
// snapshot's required connections, the KB connector catalog, global-variable
// isolation, and the deployment context the manifest cannot filter on here.
// Spec doc: docs/api/connections/api-connections-surface-details.md
//
// Every row, flow and project belongs to a throwaway user created once per
// worker (#2295): its own write bucket, and no superuser row for any other spec
// to trip on. Only test 3 acts as the superuser, through the page, for one revoke.

const COLLECTION = "/api/v1/connections";
const SNAPSHOT = (projectId: string) => `/api/v1/projects/${projectId}/deployment-snapshot`;

const GMAIL_SEND = "ext:google:GmailSendComponent@official";
const DRIVE_LIST = "ext:google:GoogleDriveListComponent@official";
const CALENDAR_LIST = "ext:google:GoogleCalendarListComponent@official";

/** `DeploymentSnapshot`'s top-level keys. There is no `schema_version`: that is the artifact manifest's. */
const SNAPSHOT_KEYS = [
  "dependencies",
  "flows",
  "project",
  "required_connections",
  "required_mcp_projects",
  "required_mcp_variables",
  "required_models",
  "required_providers",
  "required_variables",
  "unresolved_model_fields",
];
/** `ConnectorCatalogEntry`'s keys. */
const CONNECTOR_KEYS = [
  "description",
  "display_name",
  "icon",
  "provider_key",
  "required_scopes",
  "requires_credentials",
  "source_type",
];

// Exact copy, measured on 1.13.0.dev47.
const SNAPSHOT_EMPTY = { detail: "project has no flows to package" };
const REVOKE_FAILED_TOAST =
  "Credential removed from Langflow, but provider revocation failed. Revoke the token in the provider's settings.";

type RevokeRead = ConnectionRead & { provider_revocation: string };

interface IntegrationCapability {
  id: string;
  required_scopes: string[];
  deployment_contexts: string[];
}
interface IntegrationList {
  deployment_context: string;
  providers: { provider_id: string; capabilities: IntegrationCapability[] }[];
}
interface ConnectorEntry {
  source_type: string;
  requires_credentials: boolean;
  provider_key: string | null;
  required_scopes: string[];
}

/** A Slack app-level token: accepted at create with no call to Slack, refused by `auth.revoke`. */
function slackAppToken(): string {
  return `xapp-1-E2E-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

test.describe("Connections — the small reachable surface details", () => {
  let owner: ConnectionsOwner;
  const rows: CreatedConnection[] = [];
  const flows: string[] = [];
  const projects: CreatedProject[] = [];

  test.beforeAll(async ({ playwright }, testInfo) => {
    owner = await createConnectionsOwner(
      () => playwright.request.newContext({ baseURL: testInfo.project.use.baseURL }),
      "connsurface",
    );
  });

  test.afterEach(async ({ request }) => {
    const failures: string[] = [];
    for (const id of flows.splice(0)) {
      await deleteFlow(request, id, { headers: owner.headers }).catch((error) => failures.push(String(error)));
    }
    for (const project of projects.splice(0)) {
      await project.deleteProject(request).catch((error) => failures.push(String(error)));
    }
    for (const row of rows.splice(0)) {
      await row.deleteConnection(request).catch((error) => failures.push(String(error)));
    }
    expect(failures, "every row, flow and project this test created is deleted").toEqual([]);
  });

  test.afterAll(async () => {
    // Deleting the user takes anything left with it. Idempotent.
    await owner?.dispose();
  });

  async function plant(
    request: APIRequestContext,
    label: string,
    options: CreateConnectionOptions = {},
  ): Promise<CreatedConnection> {
    const row = await createConnectionViaApi(request, owner.headers, { label: `connsurface_${label}`, ...options });
    rows.push(row);
    return row;
  }

  async function list(request: APIRequestContext, query = ""): Promise<ConnectionRead[]> {
    const res = await request.get(`${COLLECTION}${query}`, { headers: owner.headers });
    expect(res.status(), await res.text()).toBe(200);
    return (await res.json()) as ConnectionRead[];
  }

  async function revoke(request: APIRequestContext, id: string): Promise<RevokeRead> {
    const res = await request.post(`${COLLECTION}/${id}/revoke`, { headers: owner.headers });
    expect(res.status(), await res.text()).toBe(200);
    return (await res.json()) as RevokeRead;
  }

  async function readIntegrations(request: APIRequestContext): Promise<IntegrationList> {
    const res = await request.get("/api/v1/integrations", { headers: owner.headers });
    expect(res.status(), await res.text()).toBe(200);
    return (await res.json()) as IntegrationList;
  }

  test(
    "the provider filter lists that provider's rows and no other",
    { tag: ["@stable", "@api", "@integrations"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare(["POST /api/v1/connections", "GET /api/v1/connections"]);
      const google = await plant(request, "filter_google");
      const microsoft = await plant(request, "filter_microsoft", { providerKey: "microsoft" });

      await test.step("unfiltered, the list carries both rows", async () => {
        const names = (await list(request)).map((row) => row.name);
        expect(names).toEqual(expect.arrayContaining([google.name, microsoft.name]));
      });

      for (const [provider, kept, dropped] of [
        ["google", google, microsoft],
        ["microsoft", microsoft, google],
      ] as const) {
        await test.step(`?provider=${provider} keeps the ${provider} row and drops the other one`, async () => {
          const rowsOf = await list(request, `?provider=${provider}`);
          const names = rowsOf.map((row) => row.name);
          expect(names, `${provider} lists its own row`).toContain(kept.name);
          expect(names, `${provider} does not list the other provider's row`).not.toContain(dropped.name);
          expect(
            rowsOf.filter((row) => row.provider_key !== provider).map((row) => `${row.name} (${row.provider_key})`),
            `every row ?provider=${provider} lists is a ${provider} row`,
          ).toEqual([]);
        });
      }

      await test.step("a well-formed provider id that no row carries lists nothing", async () => {
        const unused = `e2enone${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
        expect(await list(request, `?provider=${unused}`)).toEqual([]);
      });
    },
  );

  test(
    "revoke reports what happened at the provider: nothing to revoke, or a revocation that failed",
    { tag: ["@stable", "@api", "@integrations"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare(["POST /api/v1/connections", "POST /api/v1/connections/{connection_id}/revoke"]);
      // Whatever the provider says, the local credential goes: the row is revoked
      // and holds none (`ConnectionService.revoke`).
      const revokedLocally = { status: "revoked", has_credentials: false };

      await test.step("a pending row holds no credential, so there is nothing to revoke", async () => {
        const pending = await plant(request, "revoke_pending", { credentials: null });
        expect(pending.connection.status, "a row created without credentials").toBe("pending");
        expect(await revoke(request, pending.id)).toMatchObject({
          ...revokedLocally,
          provider_revocation: "not_applicable",
        });
      });

      await test.step("a pasted Google token has no OAuth binding: not_applicable, then again on a repeat", async () => {
        const google = await plant(request, "revoke_google");
        expect(google.connection.status, "a row created with a planted token").toBe("ready");
        expect(await revoke(request, google.id)).toMatchObject({
          ...revokedLocally,
          provider_revocation: "not_applicable",
        });
        // The first revoke removed the secret, so the second has nothing to send.
        expect(await revoke(request, google.id)).toMatchObject({
          ...revokedLocally,
          provider_revocation: "not_applicable",
        });
      });

      await test.step("a pasted Slack app-level token is sent to auth.revoke, which refuses it: failed", async () => {
        // Slack refusing the fake token and the call not leaving the instance both
        // raise the same OAuthError, so the outcome does not depend on egress.
        const slack = await plant(request, "revoke_slack", {
          providerKey: "slack",
          identity: "bot",
          credentials: { access_token: slackAppToken() },
        });
        expect(slack.connection.status, "a row created with a planted app-level token").toBe("ready");
        expect(await revoke(request, slack.id)).toMatchObject({ ...revokedLocally, provider_revocation: "failed" });
      });
    },
  );

  test(
    "the page says the provider revocation failed when Slack refuses the token",
    { tag: ["@stable", "@integrations", "@settings"] },
    async ({ page, request }) => {
      // The owner's row, revoked by the superuser from the Other users tab: in OSS a
      // superuser may revoke another user's row (#2300), and the page spends one
      // superuser write where seeding there would spend three.
      const slack = await plant(request, "toast_slack", {
        providerKey: "slack",
        identity: "bot",
        credentials: { access_token: slackAppToken() },
      });
      const row = page.getByTestId(`connection-row-${slack.name}`);

      await test.step("the owner's row is on the Other users tab", async () => {
        await page.goto("/settings/connections");
        await page.getByRole("tab", { name: "Other users" }).click();
        await page.getByTestId("connections-search").fill(slack.name);
        await expect(row, `the seeded row ${slack.name}`).toBeVisible({ timeout: 30000 });
        await expect(row.getByText("Ready", { exact: true })).toBeVisible();
      });

      await test.step("Revoke answers failed, and the toast says so", async () => {
        await page.getByTestId(`connection-menu-${slack.name}`).click();
        const revokeCall = page.waitForResponse(
          (response) =>
            response.request().method() === "POST" &&
            new URL(response.url()).pathname === `${COLLECTION}/${slack.id}/revoke`,
        );
        await page.getByRole("menu").getByRole("menuitem", { name: "Revoke" }).click();
        const response = await revokeCall;
        expect(response.status(), "the revoke call").toBe(200);
        expect((await response.json()).provider_revocation, "the provider-side outcome").toBe("failed");
        await expect(page.getByRole("status").getByText(REVOKE_FAILED_TOAST, { exact: true })).toBeVisible();
        await expect(row.getByText("Revoked", { exact: true })).toBeVisible();
      });

      await test.step("the owner's list agrees: revoked, no credential", async () => {
        const read = (await list(request)).find((candidate) => candidate.id === slack.id);
        expect(read).toMatchObject({ status: "revoked", has_credentials: false });
      });
    },
  );

  test(
    "the deployment snapshot names each connection the project's flows need, with the union of their scopes",
    { tag: ["@api", "@integrations"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare(["GET /api/v1/projects/{project_id}/deployment-snapshot"]);
      const project = await createProjectViaApi(request, owner.headers, { namePrefix: "e2e-snapshot" });
      projects.push(project);
      // The handle names no connection: the snapshot reads the flows, not the table.
      const handle = uniqueConnectionName("snapshot");
      let expectedScopes: string[] = [];
      let flowId = "";

      await test.step("a project with no flows has nothing to snapshot", async () => {
        const res = await request.get(SNAPSHOT(project.projectId), { headers: owner.headers });
        expect(res.status(), await res.text()).toBe(422);
        expect(res.headers()["x-langflow-error-code"]).toBe("snapshot_empty");
        expect(await res.json()).toEqual(SNAPSHOT_EMPTY);
      });

      await test.step("a flow binds Gmail Send and Drive List to one handle and leaves Calendar List unbound", async () => {
        const catalog = await fetchComponentCatalog(request, owner.headers);
        const scopesOf = (type: string) =>
          (findCatalogComponent(catalog, type).template.connection?.required_scopes ?? []) as string[];
        const gmail = scopesOf(GMAIL_SEND);
        const drive = scopesOf(DRIVE_LIST);
        // Each node declares its own scope, and they differ: otherwise the union
        // below could not tell a merge from one node's scopes.
        expect(gmail.length, `${GMAIL_SEND} declares a required scope`).toBeGreaterThan(0);
        expect(drive.length, `${DRIVE_LIST} declares a required scope`).toBeGreaterThan(0);
        expect(gmail.filter((scope) => drive.includes(scope)), "the two nodes share no scope").toEqual([]);
        expect(scopesOf(CALENDAR_LIST).length, `${CALENDAR_LIST} declares a scope it must not add`).toBeGreaterThan(0);
        expectedScopes = [...gmail, ...drive].sort();

        const data = buildCatalogFlow(catalog, {
          nodes: [
            { id: "GmailSend-bound", type: GMAIL_SEND, values: { connection: `google/${handle}` } },
            { id: "DriveList-bound", type: DRIVE_LIST, values: { connection: `google/${handle}` } },
            { id: "CalendarList-unbound", type: CALENDAR_LIST, values: { connection: "" } },
          ],
          edges: [],
        });
        flowId = await createFlow(
          request,
          { name: `E2E snapshot ${handle}`, data, folder_id: project.projectId, is_component: false },
          { headers: owner.headers },
        );
        flows.push(flowId);
      });

      await test.step("the snapshot lists the handle once, with both nodes' scopes, and no schema_version", async () => {
        const res = await request.get(SNAPSHOT(project.projectId), { headers: owner.headers });
        expect(res.status(), await res.text()).toBe(200);
        expect(res.headers()["cache-control"]).toBe("no-store");
        const body = await res.json();
        expect(Object.keys(body).sort(), "the snapshot's top-level keys").toEqual(SNAPSHOT_KEYS);
        expect(body.project.id).toBe(project.projectId);
        expect(body.flows.map((flow: { id: string }) => flow.id)).toEqual([flowId]);
        expect(body.required_connections).toEqual([{ provider: "google", name: handle, scopes: expectedScopes }]);
      });
    },
  );

  test(
    "the KB connector catalog names a provider and its scopes for every connector that needs a credential",
    { tag: ["@stable", "@api", "@integrations"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare(["GET /api/v1/knowledge_bases/connectors", "GET /api/v1/integrations"]);
      const res = await request.get("/api/v1/knowledge_bases/connectors", { headers: owner.headers });
      expect(res.status(), await res.text()).toBe(200);
      const connectors = (await res.json()) as ConnectorEntry[];
      const bySource = (source: string) => connectors.find((entry) => entry.source_type === source);

      await test.step("every entry carries the exact catalog-entry key set", async () => {
        expect(connectors.length, "the catalog lists connectors").toBeGreaterThan(0);
        for (const entry of connectors) {
          expect(Object.keys(entry).sort(), `${entry.source_type}'s keys`).toEqual(CONNECTOR_KEYS);
        }
      });

      await test.step("the folder connector needs no credential, so it names no provider and no scope", async () => {
        expect(bySource("folder")).toMatchObject({ requires_credentials: false, provider_key: null, required_scopes: [] });
      });

      await test.step("Google Drive, OneDrive and SharePoint name their provider and scope", async () => {
        expect(bySource("google_drive")).toMatchObject({
          requires_credentials: true,
          provider_key: "google",
          required_scopes: ["https://www.googleapis.com/auth/drive.file"],
        });
        for (const source of ["onedrive", "sharepoint"]) {
          expect(bySource(source), source).toMatchObject({
            requires_credentials: true,
            provider_key: "microsoft",
            required_scopes: ["Files.Read"],
          });
        }
      });

      await test.step("each credentialed connector asks only for scopes its provider's capabilities declare", async () => {
        const declared = new Map(
          (await readIntegrations(request)).providers.map((provider) => [
            provider.provider_id,
            new Set(provider.capabilities.flatMap((capability) => capability.required_scopes)),
          ]),
        );
        const credentialed = connectors.filter((entry) => entry.requires_credentials);
        expect(credentialed.length, "at least one connector needs a credential").toBeGreaterThan(0);
        for (const entry of credentialed) {
          const scopes = declared.get(entry.provider_key ?? "");
          expect(scopes, `${entry.source_type}'s provider ${entry.provider_key} is in the manifest`).toBeDefined();
          expect(entry.required_scopes.length, `${entry.source_type} asks for a scope`).toBeGreaterThan(0);
          expect(
            entry.required_scopes.filter((scope) => !scopes?.has(scope)),
            `${entry.source_type}'s scopes that no ${entry.provider_key} capability declares`,
          ).toEqual([]);
        }
      });
    },
  );

  test(
    "creating, revoking and deleting a connection writes no global variable",
    { tag: ["@stable", "@api", "@integrations"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        "GET /api/v1/variables/",
        "POST /api/v1/connections",
        "POST /api/v1/connections/{connection_id}/revoke",
        "DELETE /api/v1/connections/{connection_id}",
      ]);
      const variables = async (): Promise<string[]> => {
        const res = await request.get("/api/v1/variables/", { headers: owner.headers });
        expect(res.status(), await res.text()).toBe(200);
        return ((await res.json()) as { id: string; name: string }[]).map((row) => `${row.name} (${row.id})`).sort();
      };
      const before = await variables();
      const row = await plant(request, "variables");

      await test.step("after the create, the user's variables are the same", async () => {
        expect(row.connection.has_credentials, "the row holds a credential").toBe(true);
        expect(await variables()).toEqual(before);
      });

      await test.step("after the revoke and the delete, they are still the same", async () => {
        await revoke(request, row.id);
        const res = await request.delete(`${COLLECTION}/${row.id}`, { headers: owner.headers });
        expect(res.status(), await res.text()).toBe(204);
        rows.splice(rows.indexOf(row), 1);
        expect(await variables()).toEqual(before);
      });
    },
  );

  test(
    "on this lane's deployment context no capability is filtered, and none could be",
    { tag: ["@stable", "@api", "@integrations"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare(["GET /api/v1/integrations"]);
      const body = await readIntegrations(request);
      const capabilities = body.providers.flatMap((provider) => provider.capabilities);

      // `deployment_context` is documented as filtering, and the handler reads the
      // capabilities' `deployment_contexts` nowhere (#2074 measured it under
      // `hosted`). On `self_managed` every capability includes the context, so
      // filtering and no filtering list the same set. When this fails, a capability
      // excludes the lane's context and the filter has become observable here.
      expect(body.deployment_context, "LANGFLOW_CONNECTION_OAUTH_CONTEXT is unset on this lane").toBe("self_managed");
      expect(capabilities.length, "the manifest lists capabilities").toBeGreaterThan(0);
      expect(
        capabilities
          .filter((capability) => !capability.deployment_contexts.includes(body.deployment_context))
          .map((capability) => `${capability.id} (${capability.deployment_contexts.join(", ")})`),
        `capabilities whose deployment_contexts exclude ${body.deployment_context}`,
      ).toEqual([]);
    },
  );
});
