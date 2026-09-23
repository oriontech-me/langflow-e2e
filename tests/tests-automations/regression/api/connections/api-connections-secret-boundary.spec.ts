import type { APIRequestContext, APIResponse } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { type ConnectionRead, uniqueConnectionName } from "../../../../helpers/integrations/create-connection";
import { deleteConnection } from "../../../../helpers/integrations/delete-connection";

// The secret boundary: a planted token must reach no client response.
// Spec doc: docs/api/connections/api-connections-secret-boundary.md
//
// Every call is a RAW request.* because the response TEXT is the subject —
// createConnectionViaApi parses to an object, which is exactly what this file
// must not do: a token nested under an unexpected key survives a key check.
// The helper is used for teardown only.
//
// No allowHttpErrors() for the deliberate 422s: the fixture's HTTP monitor is
// installed on `page`, and this spec has none (the sibling lifecycle spec drives
// six deliberate 422s the same way).
test.describe("Connections API — the secret boundary", () => {
  const COLLECTION = "/api/v1/connections";
  const INTEGRATIONS = "/api/v1/integrations";
  const VARIABLES = "/api/v1/variables/";
  const GMAIL_SEND = "https://www.googleapis.com/auth/gmail.send";
  const DRIVE_FILE = "https://www.googleapis.com/auth/drive.file";

  /**
   * `ConnectionRead`'s 16 fields, measured on `1.13.0.dev21`. Asserted as the
   * EXACT set rather than as an absence list for `access_token` /
   * `refresh_token` / `credentials`: a denylist would miss a new field called
   * `token`, `secret` or `envelope`, which is the regression this file exists to
   * catch.
   */
  const CONNECTION_READ_KEYS = [
    "allow_non_interactive",
    "created_at",
    "display_name",
    "executing_identity",
    "granted_scopes",
    "has_credentials",
    "health",
    "health_checked_at",
    "id",
    "name",
    "owner_id",
    "ownership_mode",
    "provider_key",
    "status",
    "status_reason",
    "updated_at",
  ];

  /** `ConnectionRevokeRead` is `ConnectionRead` plus `provider_revocation`. */
  const CONNECTION_REVOKE_KEYS = [...CONNECTION_READ_KEYS, "provider_revocation"].sort();

  /** `PersistedConnectionStatus`, all five values. */
  const STATUSES = ["pending", "ready", "expired", "revoked", "error"];

  /** `ConnectionHealth`. */
  const HEALTHS = ["unknown", "healthy", "unhealthy"];

  // Every name / display-name marker a test sends, registered BEFORE it is sent.
  // A connection is owner-scoped and every worker is the same superuser, so the
  // teardown must find this test's rows among other workers' — and must find one
  // that a refused body created anyway.
  const sent: string[] = [];

  test.afterEach(async ({ request }) => {
    const markers = sent.splice(0);
    if (markers.length === 0) return;
    const headers = { Authorization: await getAuthToken(request) };
    const res = await request.get(COLLECTION, { headers });
    if (!res.ok()) {
      console.warn(`⚠️ Connection sweep could not list (${res.status()}) — markers left: ${markers.join(", ")}`);
      return;
    }
    const rows = (await res.json()) as ConnectionRead[];
    // One list read, then a DELETE only for rows still present: a DELETE that
    // answers 404 is still charged to the per-user write bucket.
    const mine = rows.filter((row) =>
      markers.some((marker) => row.name === marker || row.display_name.includes(marker)),
    );
    for (const row of mine) {
      await deleteConnection(request, row.id, { headers }).catch((error) => {
        console.warn(`⚠️ Orphan connection left behind (${row.name}): ${error}`);
      });
    }
  });

  /**
   * Two sentinels, unique per test AND per run, so a sweep can never match a
   * neighbouring worker's material and report it as this connection's leak.
   */
  function newSentinels(label: string): { access: string; refresh: string } {
    const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`.toUpperCase();
    return {
      access: `E2E-ACCESS-SENTINEL-${label}-${run}`,
      refresh: `E2E-REFRESH-SENTINEL-${label}-${run}`,
    };
  }

  /**
   * The whole point of the file: assert on the raw TEXT, never on the parsed
   * object. A token nested under a key nobody expected survives a key check, and
   * a key check is what upstream's in-process tests already do.
   */
  async function expectNoSentinel(
    response: APIResponse,
    sentinels: { access: string; refresh: string },
    surface: string,
  ): Promise<string> {
    const text = await response.text();
    expect(text, `${surface} must not carry the planted access token`).not.toContain(sentinels.access);
    expect(text, `${surface} must not carry the planted refresh token`).not.toContain(sentinels.refresh);
    return text;
  }

  async function listConnections(
    request: APIRequestContext,
    headers: Record<string, string>,
  ): Promise<{ rows: ConnectionRead[]; response: APIResponse }> {
    const response = await request.get(COLLECTION, { headers });
    expect(response.status(), await response.text()).toBe(200);
    return { rows: (await response.json()) as ConnectionRead[], response };
  }

  test(
    "a planted token reaches no client response across the connection's lifecycle, and scope coverage describes the request rather than the credential",
    { tag: ["@stable", "@api", "@regression", "@integrations"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        `POST ${COLLECTION}`,
        `GET ${COLLECTION}`,
        `PATCH ${COLLECTION}/{connection_id}`,
        `POST ${COLLECTION}/{connection_id}/test`,
        `POST ${COLLECTION}/{connection_id}/revoke`,
        `GET ${INTEGRATIONS}`,
        `GET ${VARIABLES}`,
      ]);
      const headers = { Authorization: await getAuthToken(request) };
      const sentinels = newSentinels("LIFECYCLE");
      const name = uniqueConnectionName("secret_boundary");
      sent.push(name);
      let created: ConnectionRead | undefined;

      await test.step("the create response reports the credential without carrying it", async () => {
        const response = await request.post(COLLECTION, {
          headers,
          data: {
            provider_key: "google",
            name,
            display_name: `E2E secret boundary ${name}`,
            granted_scopes: [GMAIL_SEND],
            executing_identity: { identity: "user_delegated" },
            credentials: {
              access_token: sentinels.access,
              refresh_token: sentinels.refresh,
              token_type: "Bearer",
              expires_at: "2099-01-01T00:00:00Z",
            },
          },
        });
        expect(response.status(), await response.text()).toBe(201);
        await expectNoSentinel(response, sentinels, "the create response");
        created = (await response.json()) as ConnectionRead;
        // The exact set, not an absence list: a new field carrying material
        // fails here whatever it is called.
        expect(Object.keys(created).sort(), "the create response carries exactly the ConnectionRead keys").toEqual(
          CONNECTION_READ_KEYS,
        );
        expect(created.has_credentials, "the credential is stored and reported").toBe(true);
        expect(created.status, "a planted credential lands ready").toBe("ready");
        expect(created.status_reason, "a ready connection carries no status reason").toBeNull();
        expect(created.health, "health starts unknown — nothing has checked it yet").toBe("unknown");
        expect(created.health_checked_at, "nothing has checked it yet").toBeNull();
      });

      await test.step("the list carries the row and neither sentinel", async () => {
        const { rows, response } = await listConnections(request, headers);
        await expectNoSentinel(response, sentinels, "the connection list");
        const mine = rows.filter((row) => row.name === name);
        expect(mine, `exactly one row carries the name "${name}"`).toHaveLength(1);
        expect(Object.keys(mine[0]).sort(), "the list row carries exactly the ConnectionRead keys").toEqual(
          CONNECTION_READ_KEYS,
        );
      });

      await test.step("PATCH is a different serializer and leaks nothing either", async () => {
        const response = await request.patch(`${COLLECTION}/${(created as ConnectionRead).id}`, {
          headers,
          data: { display_name: `E2E secret boundary renamed ${name}` },
        });
        expect(response.status(), await response.text()).toBe(200);
        await expectNoSentinel(response, sentinels, "the PATCH response");
      });

      await test.step("a scope it does not hold is answered 200, and describes the request rather than the credential", async () => {
        const response = await request.post(`${COLLECTION}/${(created as ConnectionRead).id}/test`, {
          headers,
          data: { required_scopes: [DRIVE_FILE] },
        });
        // Not a refusal: check_health catches ScopeMissingError as an
        // IntegrationError and answers an ordinary ConnectionRead. The body does
        // not name the missing scope either.
        expect(response.status(), await response.text()).toBe(200);
        await expectNoSentinel(response, sentinels, "the test response for a missing scope");
        const row = (await response.json()) as ConnectionRead;
        // The enum transition only. `healthy` is a recorded deviation on this
        // build — it came back healthy for a literal sentinel with no provider —
        // so this file never treats health as proof that a credential works.
        expect(HEALTHS, `health "${row.health}" is a declared ConnectionHealth`).toContain(row.health);
        expect(row.health, "the missing scope makes this request unsatisfiable").toBe("unhealthy");
        expect(row.health_checked_at, "the check stamps when it ran").not.toBeNull();
        // The load-bearing half: scope coverage describes THIS REQUEST, so the
        // stored credential's status is untouched.
        expect(row.status, "the stored credential is still ready").toBe("ready");
        expect(row.status_reason, "a scope denial is not a credential fault").toBeNull();
      });

      await test.step("the stored row agrees — the scope denial persisted nothing", async () => {
        // Re-read rather than a second POST /test: the persisted row is the
        // stronger evidence, and it costs none of the 5-per-minute test budget.
        const { rows } = await listConnections(request, headers);
        const mine = rows.filter((row) => row.name === name);
        expect(mine, `exactly one row carries the name "${name}"`).toHaveLength(1);
        expect(mine[0].status, "the stored credential is still ready").toBe("ready");
        expect(mine[0].status_reason, "a scope denial left no reason behind").toBeNull();
        expect(mine[0].has_credentials, "a scope denial did not drop the credential").toBe(true);
        expect(mine[0].health, "the unhealthy verdict is what persisted").toBe("unhealthy");
      });

      await test.step("revoke answers the wider shape, drops the credential and leaks nothing", async () => {
        const response = await request.post(`${COLLECTION}/${(created as ConnectionRead).id}/revoke`, { headers });
        expect(response.status(), await response.text()).toBe(200);
        await expectNoSentinel(response, sentinels, "the revoke response");
        const row = await response.json();
        expect(Object.keys(row).sort(), "revoke answers exactly the ConnectionRevokeRead keys").toEqual(
          CONNECTION_REVOKE_KEYS,
        );
        expect(row.has_credentials, "revoking drops the stored credential").toBe(false);
        expect(row.status, "the connection is revoked").toBe("revoked");
      });

      await test.step("the integration manifest counts this connection and carries none of its material", async () => {
        const response = await request.get(INTEGRATIONS, { headers });
        expect(response.status(), await response.text()).toBe(200);
        await expectNoSentinel(response, sentinels, "the integrations manifest");
      });

      await test.step("a connection credential has not become a global variable", async () => {
        const response = await request.get(VARIABLES, { headers });
        expect(response.status(), await response.text()).toBe(200);
        // Absence only: the global-variable list is shared instance state, so
        // nothing here reads a length or a row.
        await expectNoSentinel(response, sentinels, "the global variable list");
      });
    },
  );

  /**
   * The regression this file pins from outside: before `1.13.0.dev10`
   * (langflow#15038) a validation `422` echoed the offending `input`, so a create
   * body carrying `credentials.access_token` echoed the token back to the client.
   * A `422` is refused before the handler runs, so these cost no write budget.
   *
   * One literal-titled test per cause rather than a loop: the title names the
   * cause that stopped being redacted, and the force-fail gate reads titles from
   * the AST, where a template literal resolves to nothing.
   */
  async function refusedAndRedacted(
    request: APIRequestContext,
    cause: string,
    mutate: (body: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<{ type: string; loc: string[] }> {
    const headers = { Authorization: await getAuthToken(request) };
    const sentinels = newSentinels("REFUSED");
    const marker = uniqueConnectionName("secret_boundary_refused");
    // Registered although the body is expected to be refused: a body accepted
    // anyway is exactly the regression, and its row must not survive.
    sent.push(marker);
    const body: Record<string, unknown> = {
      provider_key: "google",
      name: marker,
      display_name: `E2E refused ${marker}`,
      executing_identity: { identity: "user_delegated" },
      credentials: { access_token: sentinels.access, refresh_token: sentinels.refresh },
    };

    const response = await request.post(COLLECTION, { headers, data: mutate(body) });
    expect(response.status(), await response.text()).toBe(422);
    const text = await expectNoSentinel(response, sentinels, `the 422 refusing ${cause}`);

    // Returned rather than asserted here: each caller names its OWN cause, so a
    // failure points at the body that stopped failing for its own reason. The
    // one-entry check stays here because it is the same for every cause, and
    // because a 422 that stopped carrying `loc` at all must not read as redacted.
    const { detail } = JSON.parse(text);
    expect(detail, `the refusal of ${cause} names exactly one cause`).toHaveLength(1);
    return detail[0];
  }

  test(
    "a create body refused for a hyphenated name does not echo the credential it carried",
    { tag: ["@stable", "@api", "@regression", "@integrations"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([`POST ${COLLECTION}`]);
      const refusal = await refusedAndRedacted(request, "a hyphenated name", (body) => ({ ...body, name: `${body.name as string}-hyphenated` }));
      expect(refusal.type, `the refusal of a hyphenated name names its own type`).toBe("string_pattern_mismatch");
      expect(refusal.loc, `the refusal of a hyphenated name names its own field`).toEqual(["body", "name"]);
    },
  );

  test(
    "a create body refused for a missing provider_key does not echo the credential it carried",
    { tag: ["@stable", "@api", "@regression", "@integrations"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([`POST ${COLLECTION}`]);
      const refusal = await refusedAndRedacted(request, "a missing provider_key", (body) => Object.fromEntries(Object.entries(body).filter(([key]) => key !== "provider_key")));
      expect(refusal.type, `the refusal of a missing provider_key names its own type`).toBe("missing");
      expect(refusal.loc, `the refusal of a missing provider_key names its own field`).toEqual(["body", "provider_key"]);
    },
  );

  test(
    "a create body refused for an undeclared key does not echo the credential it carried",
    { tag: ["@stable", "@api", "@regression", "@integrations"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([`POST ${COLLECTION}`]);
      const refusal = await refusedAndRedacted(request, "an undeclared key", (body) => ({ ...body, provider_id: "google" }));
      expect(refusal.type, `the refusal of an undeclared key names its own type`).toBe("extra_forbidden");
      expect(refusal.loc, `the refusal of an undeclared key names its own field`).toEqual(["body", "provider_id"]);
    },
  );

  test(
    "status_reason stays null on every status a client can drive the connection into",
    { tag: ["@stable", "@api", "@regression", "@integrations"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        `POST ${COLLECTION}`,
        `POST ${COLLECTION}/{connection_id}/health`,
        `POST ${COLLECTION}/{connection_id}/revoke`,
      ]);
      const headers = { Authorization: await getAuthToken(request) };
      const sentinels = newSentinels("STATUS");
      const name = uniqueConnectionName("secret_boundary_status");
      sent.push(name);
      let connectionId = "";

      // `error` is deliberately absent: it needs the instance key to change under
      // a stored envelope, the envelope row to vanish, or a configured OAuth
      // registration (the nightly answers registrations: []). The spec doc says
      // so rather than a passing test implying it is covered.
      const expectStatus = (row: ConnectionRead, status: string, when: string) => {
        expect(STATUSES, `${when}: "${row.status}" is a declared PersistedConnectionStatus`).toContain(row.status);
        expect(row.status, `${when}: the status`).toBe(status);
        // Asserted as null, never as absent: the field is always present.
        expect(row.status_reason, `${when}: a ${status} connection carries no status reason`).toBeNull();
      };

      await test.step("a credential already past its expiry still lands ready", async () => {
        const response = await request.post(COLLECTION, {
          headers,
          data: {
            provider_key: "google",
            name,
            display_name: `E2E status ${name}`,
            executing_identity: { identity: "user_delegated" },
            credentials: {
              access_token: sentinels.access,
              refresh_token: sentinels.refresh,
              expires_at: "2020-01-01T00:00:00Z",
            },
          },
        });
        expect(response.status(), await response.text()).toBe(201);
        await expectNoSentinel(response, sentinels, "the create response for an already-expired credential");
        const row = (await response.json()) as ConnectionRead;
        connectionId = row.id;
        expectStatus(row, "ready", "on create");
        expect(row.has_credentials, "the envelope is stored").toBe(true);
      });

      await test.step("the health check ages it out to expired", async () => {
        const response = await request.post(`${COLLECTION}/${connectionId}/health`, { headers });
        expect(response.status(), await response.text()).toBe(200);
        // The file's only POST /health, so this is also where that route is swept.
        await expectNoSentinel(response, sentinels, "the health response");
        const row = (await response.json()) as ConnectionRead;
        expectStatus(row, "expired", "after the health check");
        expect(row.health_checked_at, "the check stamps when it ran").not.toBeNull();
        // The envelope is still stored — it is the token that aged out, which is
        // what separates `expired` from the unreachable `error` states.
        expect(row.has_credentials, "an expired connection still holds its envelope").toBe(true);
        expect(row.health, "an expired credential is unhealthy").toBe("unhealthy");
      });

      await test.step("revoking drops the credential and still reports no reason", async () => {
        const response = await request.post(`${COLLECTION}/${connectionId}/revoke`, { headers });
        expect(response.status(), await response.text()).toBe(200);
        await expectNoSentinel(response, sentinels, "the revoke response");
        const row = (await response.json()) as ConnectionRead;
        expectStatus(row, "revoked", "after the revoke");
        expect(row.has_credentials, "revoking drops the stored credential").toBe(false);
      });
    },
  );
});
