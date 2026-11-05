import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { parseStreamEvents } from "../../../../fixtures/flow-error-policy";
import { createCatalogFlow, fetchComponentCatalog } from "../../../../helpers/flows/build-catalog-flow";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import { driveListFlowSpec } from "../../../../helpers/integrations/connection-probe";
import { type ConnectionsOwner, createConnectionsOwner } from "../../../../helpers/integrations/connections-owner";
import {
  type ConnectionRead,
  type CreateConnectionOptions,
  type CreatedConnection,
  createConnectionViaApi,
  uniqueConnectionName,
} from "../../../../helpers/integrations/create-connection";

// The health of a connection once it exists (#2355): what a run writes back to the row, and what a pasted Slack
// token is checked against before it is stored. Spec doc: docs/api/connections/api-connections-health.md
//
// Owned by a throwaway user (#2295), so the writes, /test and /health calls spend that user's buckets.

const COLLECTION = "/api/v1/connections";
const DRIVE_FILE = "https://www.googleapis.com/auth/drive.file";
const LONG_EXPIRED = "2020-01-01T00:00:00Z";

// Exact copy, measured on 1.14.0.dev7 (lfx/integrations/errors.py, slack_credentials.py).
const AUTH_EXPIRED = {
  code: "auth-expired",
  message: "The provider credential is expired or was rejected.\n\nReconnect the integration and try again.",
};
const SCOPE_MISSING = {
  code: "scope-missing",
  message: "The connection does not grant every scope required by this action.\n\nGrant the missing scopes and reconnect.",
};
const SLACK_REJECTED = "Slack rejected this token. Paste a valid token and try again.";
const NOT_FOUND = "Connection not found";

interface RunError {
  type: "RUN_ERROR";
  code?: string;
  message?: string;
}

/** A token value no provider issued, recognisable if it ever comes back in a response. */
function sentinel(label: string): string {
  return `E2E-SENTINEL-${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** A Slack app-level token: stored with no call to Slack, and refused by `auth.revoke`. */
function slackAppToken(): string {
  return `xapp-1-E2E-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

test.describe("Connections — health after creation, and what a pasted Slack token is checked against", () => {
  let owner: ConnectionsOwner;
  let catalog: Record<string, unknown>;
  const rows: CreatedConnection[] = [];
  const flows: string[] = [];

  test.beforeAll(async ({ playwright }, testInfo) => {
    owner = await createConnectionsOwner(
      () => playwright.request.newContext({ baseURL: testInfo.project.use.baseURL }),
      "connhealth",
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
    expect(failures, "every row and flow this test created is deleted").toEqual([]);
  });

  test.afterAll(async () => {
    await owner?.dispose();
  });

  async function plant(
    request: APIRequestContext,
    label: string,
    options: CreateConnectionOptions = {},
  ): Promise<CreatedConnection> {
    const row = await createConnectionViaApi(request, owner.headers, { label: `connhealth_${label}`, ...options });
    rows.push(row);
    return row;
  }

  async function readRow(request: APIRequestContext, id: string): Promise<ConnectionRead | undefined> {
    const res = await request.get(COLLECTION, { headers: owner.headers });
    expect(res.status(), await res.text()).toBe(200);
    return ((await res.json()) as ConnectionRead[]).find((row) => row.id === id);
  }

  /** A saved Drive *List Files* flow bound to `handle`. */
  async function driveListFlow(request: APIRequestContext, handle: string): Promise<string> {
    catalog ??= await fetchComponentCatalog(request, owner.headers);
    const flowId = await createCatalogFlow(request, catalog, driveListFlowSpec(handle), {
      name: `e2e-2355-health-${uniqueConnectionName("flow")}`,
      headers: owner.headers,
    });
    flows.push(flowId);
    return flowId;
  }

  /** Runs a saved flow the way the canvas does (AG-UI stream) and returns its one `RUN_ERROR` and the raw body. */
  async function runForError(request: APIRequestContext, flowId: string): Promise<{ error: RunError; body: string }> {
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
    return { error: errors[0], body };
  }

  test(
    "a run refused for an expired credential marks the connection expired and unhealthy, with no health check, while a run refused for a missing scope leaves its connection as it was",
    { tag: ["@stable", "@api", "@integrations"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare(["POST /api/v1/connections", "GET /api/v1/connections", "POST /api/v2/workflows"]);
      const expiredToken = sentinel("expired");
      const narrowToken = sentinel("narrow");
      const expired = await plant(request, "expired", {
        grantedScopes: [DRIVE_FILE],
        credentials: { access_token: expiredToken, expires_at: LONG_EXPIRED },
      });
      const narrow = await plant(request, "narrow", { grantedScopes: ["openid"], credentials: { access_token: narrowToken } });

      await test.step("both rows start ready, never checked", async () => {
        for (const row of [expired, narrow]) {
          expect(row.connection, row.name).toMatchObject({ status: "ready", health: "unknown", health_checked_at: null });
        }
      });

      await test.step("the expired row's run fails with auth-expired and its hint, and leaks no token", async () => {
        const { error, body } = await runForError(request, await driveListFlow(request, `google/${expired.name}`));
        expect(error).toMatchObject(AUTH_EXPIRED);
        expect(body).not.toContain(expiredToken);
      });

      await test.step("the run itself wrote expired and unhealthy on the row, and kept the credential", async () => {
        const after = await readRow(request, expired.id);
        expect(after).toMatchObject({ status: "expired", health: "unhealthy", has_credentials: true });
        expect(after!.health_checked_at, "the run stamped a health check").not.toBeNull();
        expect(after!.updated_at, "the run updated the row").not.toBe(expired.connection.updated_at);
      });

      await test.step("control: a run refused for a missing scope leaves its row exactly as created", async () => {
        const { error, body } = await runForError(request, await driveListFlow(request, `google/${narrow.name}`));
        expect(error).toMatchObject(SCOPE_MISSING);
        expect(body).not.toContain(narrowToken);
        expect(await readRow(request, narrow.id)).toMatchObject({
          status: "ready",
          health: "unknown",
          health_checked_at: null,
          updated_at: narrow.connection.updated_at,
        });
      });
    },
  );

  test(
    "a pasted Slack token is checked with Slack before it is saved, and an app-level token breaking its rules is refused locally, each with its reason",
    { tag: ["@stable", "@api", "@integrations"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare(["POST /api/v1/connections", "GET /api/v1/connections"]);
      const stamp = Date.now().toString(36);
      // A token Slack never issued goes to auth.test from the server; the next three are refused before it.
      const cases: Array<{ label: string; detail: string; body: Record<string, unknown> }> = [
        {
          label: "xoxb",
          detail: SLACK_REJECTED,
          body: { executing_identity: { identity: "bot" }, credentials: { access_token: `xoxb-e2e-${stamp}-unknown` } },
        },
        {
          label: "notslack",
          detail: SLACK_REJECTED,
          body: { executing_identity: { identity: "user_delegated" }, credentials: { access_token: `not-a-slack-token-${stamp}` } },
        },
        {
          label: "xappuser",
          detail: "A Slack app-level token acts as the app, so its identity must be 'bot'.",
          body: { executing_identity: { identity: "user_delegated" }, credentials: { access_token: slackAppToken() } },
        },
        {
          label: "xapprefresh",
          detail: "Slack app-level tokens neither expire nor refresh; remove refresh_token and expires_at.",
          body: {
            executing_identity: { identity: "bot" },
            credentials: { access_token: slackAppToken(), refresh_token: `E2E-R-${stamp}` },
          },
        },
        {
          label: "xoxbappscope",
          detail: "The connections:write scope belongs to Slack app-level tokens (xapp-) only.",
          body: {
            executing_identity: { identity: "bot" },
            granted_scopes: ["connections:write"],
            credentials: { access_token: `xoxb-e2e-${stamp}-scope` },
          },
        },
      ];
      const names = cases.map((item) => uniqueConnectionName(`connhealth_${item.label}`));

      for (const [index, item] of cases.entries()) {
        await test.step(`${item.label}: 422 with its reason`, async () => {
          const res = await request.post(COLLECTION, {
            headers: owner.headers,
            data: { provider_key: "slack", name: names[index], display_name: `E2E ${names[index]}`, ...item.body },
          });
          const text = await res.text();
          expect(res.status(), text).toBe(422);
          expect(JSON.parse(text)).toEqual({ detail: item.detail });
        });
      }

      await test.step("none of the refused tokens left a row", async () => {
        const res = await request.get(COLLECTION, { headers: owner.headers });
        expect(res.status()).toBe(200);
        const listed = ((await res.json()) as ConnectionRead[]).map((row) => row.name);
        expect(listed.filter((name) => names.includes(name))).toEqual([]);
      });
    },
  );

  test(
    "checking an app-level token does not report it healthy",
    { tag: ["@stable", "@api", "@integrations"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        "POST /api/v1/connections",
        "POST /api/v1/connections/{connection_id}/test",
        "POST /api/v1/connections/{connection_id}/health",
        "GET /api/v1/connections",
      ]);
      const app = await plant(request, "xappcheck", {
        providerKey: "slack",
        identity: "bot",
        credentials: { access_token: slackAppToken() },
      });
      expect(app.connection).toMatchObject({ status: "ready", health: "unknown" });

      await test.step("Check credential and the health check answer 200 and stay unknown", async () => {
        for (const route of ["test", "health"]) {
          const res = await request.post(`${COLLECTION}/${app.id}/${route}`, {
            headers: owner.headers,
            ...(route === "test" ? { data: {} } : {}),
          });
          const text = await res.text();
          expect(res.status(), `${route}: ${text}`).toBe(200);
          expect(JSON.parse(text), route).toMatchObject({ status: "ready", health: "unknown" });
        }
      });

      await test.step("the row says the same", async () => {
        expect(await readRow(request, app.id)).toMatchObject({ status: "ready", health: "unknown" });
      });
    },
  );

  test(
    "deleting a connection whose provider revocation fails removes it whole",
    { tag: ["@stable", "@api", "@integrations"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        "POST /api/v1/connections",
        "DELETE /api/v1/connections/{connection_id}",
        "GET /api/v1/connections",
      ]);
      const app = await plant(request, "xappdelete", {
        providerKey: "slack",
        identity: "bot",
        credentials: { access_token: slackAppToken() },
      });
      expect(app.connection.status).toBe("ready");

      await test.step("DELETE answers 204, though Slack refuses the revocation it attempts first", async () => {
        const res = await request.delete(`${COLLECTION}/${app.id}`, { headers: owner.headers });
        expect(res.status(), await res.text()).toBe(204);
      });

      await test.step("nothing of the row is left: not listed, and a second DELETE finds nothing", async () => {
        expect(await readRow(request, app.id)).toBeUndefined();
        const again = await request.delete(`${COLLECTION}/${app.id}`, { headers: owner.headers });
        expect(again.status()).toBe(404);
        expect(await again.json()).toEqual({ detail: NOT_FOUND });
      });
    },
  );
});
