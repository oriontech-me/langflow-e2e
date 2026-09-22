import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import {
  type ConnectionRead,
  createConnectionViaApi,
  uniqueConnectionName,
} from "../../../../helpers/integrations/create-connection";
import { deleteConnection } from "../../../../helpers/integrations/delete-connection";

// The create / list / update / delete lifecycle of /api/v1/connections.
// Spec doc: docs/api/connections/api-connections-lifecycle.md
//
// The endpoints are the subject here, so every call under test is a raw
// request.* — createConnectionViaApi is used only to SEED test 2, where the
// create is a precondition. The raw calls are never retried: a 429 from the
// per-user write bucket fails the test and names itself.
test.describe("Connections API — lifecycle contract", () => {
  const COLLECTION = "/api/v1/connections";
  const UNKNOWN_ID = "00000000-0000-4000-8000-000000000000";
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const GMAIL_SEND = "https://www.googleapis.com/auth/gmail.send";
  const DRIVE_FILE = "https://www.googleapis.com/auth/drive.file";

  // ConnectionRead's 16 fields, measured on 1.13.0.dev19 — on the create
  // response and on every list row. Asserted as the exact set: 17 is the REVOKE
  // shape (it adds provider_revocation), and a toHaveProperty per field would
  // pass a response that grew a credential key, which is #1967's whole concern.
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

  // Every name / display-name marker a test sends, registered BEFORE it is sent.
  // A connection is owner-scoped and every worker is the same superuser, so the
  // teardown must find this test's rows among other workers' — and must find one
  // a refused body created anyway, which is exactly the regression the 422 tests
  // exist to catch.
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

  async function listConnections(
    request: APIRequestContext,
    headers: Record<string, string>,
  ): Promise<ConnectionRead[]> {
    const res = await request.get(COLLECTION, { headers });
    expect(res.status(), await res.text()).toBe(200);
    const rows = await res.json();
    expect(Array.isArray(rows), "GET /api/v1/connections returns a list").toBe(true);
    return rows;
  }

  test(
    "a connection is created with its full body, listed by its unique name and deleted by id",
    { tag: ["@stable", "@api", "@integrations"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        "POST /api/v1/connections",
        "GET /api/v1/connections",
        "DELETE /api/v1/connections/{connection_id}",
      ]);
      const headers = { Authorization: await getAuthToken(request) };
      const name = uniqueConnectionName("lifecycle");
      sent.push(name);
      const body = {
        provider_key: "google",
        name,
        display_name: `E2E lifecycle ${name}`,
        ownership_mode: "user",
        granted_scopes: [GMAIL_SEND, DRIVE_FILE],
        executing_identity: {
          identity: "user_delegated",
          account: { id: `acct_${name}`, display: "qa@example.com", tenant_id: "example.com" },
        },
        allow_non_interactive: false,
        credentials: {
          access_token: `E2E-PLANTED-ACCESS-${name}`,
          refresh_token: `E2E-PLANTED-REFRESH-${name}`,
          token_type: "Bearer",
          expires_at: "2099-01-01T00:00:00Z",
        },
      };
      let created: ConnectionRead | undefined;

      await test.step("POST answers 201 with the ConnectionRead shape and the values sent", async () => {
        const res = await request.post(COLLECTION, { headers, data: body });
        expect(res.status(), await res.text()).toBe(201);
        created = (await res.json()) as ConnectionRead;
        expect(Object.keys(created).sort()).toEqual(CONNECTION_READ_KEYS);
        expect(created.id).toMatch(UUID);
        expect(created.owner_id ?? "").toMatch(UUID);
        expect(created).toMatchObject({
          provider_key: "google",
          name,
          display_name: body.display_name,
          ownership_mode: "user",
          granted_scopes: body.granted_scopes,
          allow_non_interactive: false,
          // A planted credential is what makes the row `ready` — the derivation
          // this batch's whole harness relies on.
          status: "ready",
          status_reason: null,
          has_credentials: true,
          health: "unknown",
          health_checked_at: null,
        });
        expect(created.executing_identity).toEqual(body.executing_identity);
      });

      await test.step("the list carries exactly one row with that name, equal to the create response", async () => {
        const rows = await listConnections(request, headers);
        // By the unique name, never by length or position: other workers share
        // this superuser's list.
        const mine = rows.filter((row) => row.name === name);
        expect(mine, `rows named ${name}`).toHaveLength(1);
        expect(Object.keys(mine[0]).sort()).toEqual(CONNECTION_READ_KEYS);
        expect(mine[0]).toEqual(created);
      });

      await test.step("DELETE answers 204 with an empty body", async () => {
        const res = await request.delete(`${COLLECTION}/${created!.id}`, { headers });
        expect(res.status(), await res.text()).toBe(204);
        expect(await res.text()).toBe("");
      });

      await test.step("the list no longer carries the id or the name", async () => {
        // The removal is re-read, not inferred from the 204 (#1759/#1777/#1807).
        // Not by GET on the item path: there is no such route, and the SPA
        // catch-all answers that GET with 404 for a LIVE connection too.
        const rows = await listConnections(request, headers);
        expect(rows.filter((row) => row.id === created!.id || row.name === name)).toEqual([]);
      });

      await test.step("a second DELETE of the same id answers the route's own 404", async () => {
        const res = await request.delete(`${COLLECTION}/${created!.id}`, { headers });
        expect(res.status()).toBe(404);
        expect(await res.json()).toEqual({ detail: "Connection not found" });
      });

      await test.step("a DELETE of an unknown UUID answers the same 404", async () => {
        const res = await request.delete(`${COLLECTION}/${UNKNOWN_ID}`, { headers });
        expect(res.status()).toBe(404);
        expect(await res.json()).toEqual({ detail: "Connection not found" });
      });
    },
  );

  test(
    "PATCH renames and grants the non-interactive opt-in, and refuses a field it does not declare",
    { tag: ["@stable", "@api", "@integrations"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        "PATCH /api/v1/connections/{connection_id}",
        "GET /api/v1/connections",
      ]);
      const headers = { Authorization: await getAuthToken(request) };
      // Seeded without allow_non_interactive, so the `false` read below is the
      // server's default and not an echo of the seed.
      const seeded = await createConnectionViaApi(request, headers, { label: "patch" });
      sent.push(seeded.name);
      const itemUrl = `${COLLECTION}/${seeded.id}`;
      const renamed = `E2E renamed ${seeded.name}`;
      let afterGrant: ConnectionRead | undefined;

      await test.step("PATCH display_name answers the renamed connection and moves nothing else", async () => {
        const res = await request.patch(itemUrl, { headers, data: { display_name: renamed } });
        expect(res.status(), await res.text()).toBe(200);
        const updated = (await res.json()) as ConnectionRead;
        expect(updated).toMatchObject({
          id: seeded.id,
          name: seeded.name,
          display_name: renamed,
          allow_non_interactive: false,
          status: "ready",
        });
      });

      await test.step("PATCH allow_non_interactive: true grants it and keeps the new name", async () => {
        const res = await request.patch(itemUrl, { headers, data: { allow_non_interactive: true } });
        expect(res.status(), await res.text()).toBe(200);
        afterGrant = (await res.json()) as ConnectionRead;
        expect(afterGrant).toMatchObject({
          id: seeded.id,
          display_name: renamed,
          allow_non_interactive: true,
        });
      });

      await test.step("the list agrees on both fields", async () => {
        const row = (await listConnections(request, headers)).find((r) => r.name === seeded.name);
        expect(row, `row named ${seeded.name}`).toBeTruthy();
        expect(row).toMatchObject({ display_name: renamed, allow_non_interactive: true });
      });

      await test.step("PATCH granted_scopes is refused as a field ConnectionUpdate does not declare", async () => {
        const res = await request.patch(itemUrl, { headers, data: { granted_scopes: [GMAIL_SEND] } });
        expect(res.status(), await res.text()).toBe(422);
        const { detail } = await res.json();
        expect(detail, JSON.stringify(detail)).toHaveLength(1);
        expect(detail[0]).toMatchObject({ type: "extra_forbidden", loc: ["body", "granted_scopes"] });
      });

      await test.step("PATCH status is refused the same way", async () => {
        const res = await request.patch(itemUrl, { headers, data: { status: "revoked" } });
        expect(res.status(), await res.text()).toBe(422);
        const { detail } = await res.json();
        expect(detail, JSON.stringify(detail)).toHaveLength(1);
        expect(detail[0]).toMatchObject({ type: "extra_forbidden", loc: ["body", "status"] });
      });

      await test.step("the refused PATCHes changed nothing", async () => {
        // Equal to the last ACCEPTED write, updated_at included: a refusal that
        // still wrote would move it.
        const row = (await listConnections(request, headers)).find((r) => r.name === seeded.name);
        expect(row).toEqual(afterGrant);
        expect(row).toMatchObject({ status: "ready", granted_scopes: [] });
      });
    },
  );

  // One test per cause, so a regression names the rule it broke instead of the
  // first failing step hiding the rest. Literal titles on purpose: the suite's
  // AST tooling (Phase 0, the listing-completeness detector) cannot resolve a
  // title built from a variable, and a force-fail greps for the exact title.
  test(
    "a create body with no provider_key is refused with one 422 naming it",
    { tag: ["@stable", "@api", "@integrations"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare(["POST /api/v1/connections"]);
      const refusal = await postMarkedCreate(request, (marker) => omit(validBody(marker), "provider_key"));
      expect(refusal.status, refusal.text).toBe(422);
      // Exactly one entry: the body fails for ITS defect, not a neighbour's.
      expect(refusal.detail, refusal.text).toHaveLength(1);
      expect(refusal.detail[0]).toMatchObject({ type: "missing", loc: ["body", "provider_key"] });
    },
  );

  test(
    "a create body with no name is refused with one 422 naming it",
    { tag: ["@stable", "@api", "@integrations"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare(["POST /api/v1/connections"]);
      const refusal = await postMarkedCreate(request, (marker) => omit(validBody(marker), "name"));
      expect(refusal.status, refusal.text).toBe(422);
      // Exactly one entry: the body fails for ITS defect, not a neighbour's.
      expect(refusal.detail, refusal.text).toHaveLength(1);
      expect(refusal.detail[0]).toMatchObject({ type: "missing", loc: ["body", "name"] });
    },
  );

  test(
    "a create body with no executing_identity is refused with one 422 naming it",
    { tag: ["@stable", "@api", "@integrations"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare(["POST /api/v1/connections"]);
      const refusal = await postMarkedCreate(request, (marker) => omit(validBody(marker), "executing_identity"));
      expect(refusal.status, refusal.text).toBe(422);
      // Exactly one entry: the body fails for ITS defect, not a neighbour's.
      expect(refusal.detail, refusal.text).toHaveLength(1);
      expect(refusal.detail[0]).toMatchObject({ type: "missing", loc: ["body", "executing_identity"] });
    },
  );

  test(
    "a create body with a hyphenated name is refused with one 422 naming it",
    { tag: ["@stable", "@api", "@integrations"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare(["POST /api/v1/connections"]);
      // The repo's own uniqueName(label) idiom joins with "-" — refused.
      const refusal = await postMarkedCreate(request, (marker) => ({ ...validBody(marker), name: marker.replace(/_/g, "-") }));
      expect(refusal.status, refusal.text).toBe(422);
      // Exactly one entry: the body fails for ITS defect, not a neighbour's.
      expect(refusal.detail, refusal.text).toHaveLength(1);
      expect(refusal.detail[0]).toMatchObject({ type: "string_pattern_mismatch", loc: ["body", "name"] });
    },
  );

  test(
    "a create body with an undeclared key is refused with one 422 naming it",
    { tag: ["@stable", "@api", "@integrations"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare(["POST /api/v1/connections"]);
      const refusal = await postMarkedCreate(request, (marker) => ({ ...validBody(marker), provider_id: "google" }));
      expect(refusal.status, refusal.text).toBe(422);
      // Exactly one entry: the body fails for ITS defect, not a neighbour's.
      expect(refusal.detail, refusal.text).toHaveLength(1);
      expect(refusal.detail[0]).toMatchObject({ type: "extra_forbidden", loc: ["body", "provider_id"] });
    },
  );

  test(
    "a create body with executing_identity as a string is refused with one 422 naming it",
    { tag: ["@stable", "@api", "@integrations"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare(["POST /api/v1/connections"]);
      const refusal = await postMarkedCreate(request, (marker) => ({ ...validBody(marker), executing_identity: "user_delegated" }));
      expect(refusal.status, refusal.text).toBe(422);
      // Exactly one entry: the body fails for ITS defect, not a neighbour's.
      expect(refusal.detail, refusal.text).toHaveLength(1);
      expect(refusal.detail[0]).toMatchObject({ type: "model_attributes_type", loc: ["body", "executing_identity"] });
    },
  );

  /**
   * POSTs a create body built around a fresh marker and returns what came back.
   * The marker is registered BEFORE the POST, so the teardown finds the row if a
   * body that should be refused is ever accepted.
   */
  async function postMarkedCreate(
    request: APIRequestContext,
    body: (marker: string) => Record<string, unknown>,
  ): Promise<{ status: number; text: string; detail: Array<Record<string, unknown>> }> {
    const headers = { Authorization: await getAuthToken(request) };
    const marker = uniqueConnectionName("refused");
    sent.push(marker);
    const res = await request.post(COLLECTION, { headers, data: body(marker) });
    const text = await res.text();
    let detail: Array<Record<string, unknown>> = [];
    try {
      detail = JSON.parse(text).detail ?? [];
    } catch {
      // Not JSON: the caller's status assertion names the real answer.
    }
    return { status: res.status(), text, detail };
  }

  /** A create body the server accepts, keyed on `marker` in name and display name. */
  function validBody(marker: string): Record<string, unknown> {
    return {
      provider_key: "google",
      name: marker,
      display_name: `E2E refused ${marker}`,
      executing_identity: { identity: "user_delegated" },
    };
  }

  function omit(body: Record<string, unknown>, key: string): Record<string, unknown> {
    const rest = { ...body };
    delete rest[key];
    return rest;
  }
});
