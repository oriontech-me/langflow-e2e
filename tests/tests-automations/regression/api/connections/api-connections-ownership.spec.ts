import { randomUUID } from "node:crypto";
import type { APIRequestContext, APIResponse } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { type ConnectionsOwner, createConnectionsOwner } from "../../../../helpers/integrations/connections-owner";
import { deleteConnection } from "../../../../helpers/integrations/delete-connection";
import {
  type ConnectionRead,
  type CreatedConnection,
  createConnectionViaApi,
  uniqueConnectionName,
} from "../../../../helpers/integrations/create-connection";

// Cross-user isolation and ownership of connections.
// Spec doc: docs/api/connections/api-connections-ownership.md
//
// Two throwaway non-superusers: A owns the rows, B is the other user; the
// superuser is the third principal. Serial on purpose: test 5 spends A's write
// bucket and deletes A, so it runs last and in the same worker as the rest.
test.describe.configure({ mode: "serial" });

const COLLECTION = "/api/v1/connections";
// Exact copy, measured on 1.13.0.dev47.
const NOT_FOUND = { detail: "Connection not found" };
const INSTANCE_CREATE_REFUSED = { detail: "Only a superuser may create an instance connection." };
const INSTANCE_CHANGE_REFUSED = { detail: "Only a superuser may change or remove an instance connection." };
const OPT_IN_OWNER_ONLY = { detail: "Only the connection owner may allow non-interactive use." };
const TOO_MANY = { detail: "Too many requests. Please try again later.", retry_after: "60" };
/** `connection_write_rate_limit_per_minute`'s default. */
const WRITE_BUCKET = 30;

test.describe("Connections — cross-user isolation and ownership", () => {
  let superHeaders: Record<string, string>;
  let ownerA: ConnectionsOwner;
  let userB: ConnectionsOwner;
  const rows: CreatedConnection[] = [];

  test.beforeAll(async ({ playwright, request }, testInfo) => {
    const newContext = () => playwright.request.newContext({ baseURL: testInfo.project.use.baseURL });
    superHeaders = { Authorization: await getAuthToken(request) };
    ownerA = await createConnectionsOwner(newContext, "connowna");
    userB = await createConnectionsOwner(newContext, "connownb");
  });

  test.afterEach(async ({ request }) => {
    const failures: string[] = [];
    for (const row of rows.splice(0)) {
      await row.deleteConnection(request).catch((error) => failures.push(String(error)));
    }
    expect(failures, "every connection this test created is deleted").toEqual([]);
  });

  test.afterAll(async () => {
    // Deleting a user takes its rows with it. Both are idempotent.
    await ownerA?.dispose();
    await userB?.dispose();
  });

  async function plant(
    request: APIRequestContext,
    headers: Record<string, string>,
    label: string,
    options: { ownershipMode?: "instance" } = {},
  ): Promise<CreatedConnection> {
    const row = await createConnectionViaApi(request, headers, { label: `connown_${label}`, ...options });
    rows.push(row);
    return row;
  }

  async function listOf(
    request: APIRequestContext,
    headers: Record<string, string>,
    query = "",
  ): Promise<ConnectionRead[]> {
    const res = await request.get(`${COLLECTION}${query}`, { headers });
    expect(res.status(), await res.text()).toBe(200);
    return (await res.json()) as ConnectionRead[];
  }

  async function rowIn(
    request: APIRequestContext,
    headers: Record<string, string>,
    id: string,
  ): Promise<ConnectionRead | undefined> {
    return (await listOf(request, headers)).find((row) => row.id === id);
  }

  /** The six routes that act on one connection, as B would send them. */
  function routesOn(request: APIRequestContext, headers: Record<string, string>, id: string) {
    const item = `${COLLECTION}/${id}`;
    return [
      ["PATCH", () => request.patch(item, { headers, data: { display_name: "E2E not yours" } })],
      ["test", () => request.post(`${item}/test`, { headers, data: {} })],
      ["health", () => request.post(`${item}/health`, { headers })],
      ["revoke", () => request.post(`${item}/revoke`, { headers })],
      [
        "oauth/start",
        () => request.post(`${item}/oauth/start`, { headers, data: { registration_id: randomUUID(), scopes: ["openid"] } }),
      ],
      ["DELETE", () => request.delete(item, { headers })],
    ] as Array<[string, () => Promise<APIResponse>]>;
  }

  test(
    "another user's connection answers 404 on every route, exactly like one that does not exist",
    { tag: ["@stable", "@api", "@auth", "@integrations"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        `POST ${COLLECTION}`,
        `GET ${COLLECTION}`,
        `PATCH ${COLLECTION}/{connection_id}`,
        `POST ${COLLECTION}/{connection_id}/test`,
        `POST ${COLLECTION}/{connection_id}/health`,
        `POST ${COLLECTION}/{connection_id}/revoke`,
        `POST ${COLLECTION}/{connection_id}/oauth/start`,
        `DELETE ${COLLECTION}/{connection_id}`,
      ]);
      const row = await plant(request, ownerA.headers, "isolated");

      await test.step("every route answers B the same 404 for A's row as for a missing one", async () => {
        const missing = randomUUID();
        const onRow = routesOn(request, userB.headers, row.id);
        const onMissing = routesOn(request, userB.headers, missing);
        for (let i = 0; i < onRow.length; i++) {
          const [name, send] = onRow[i];
          const mine = await send();
          const nobodys = await onMissing[i][1]();
          expect(mine.status(), `${name} on A's row`).toBe(404);
          expect(await mine.json(), `${name} on A's row`).toEqual(NOT_FOUND);
          expect(nobodys.status(), `${name} on a missing id`).toBe(404);
          expect(await nobodys.json(), `${name} on a missing id`).toEqual(NOT_FOUND);
        }
      });

      await test.step("A's row is unchanged", async () => {
        const after = await rowIn(request, ownerA.headers, row.id);
        expect(after, "A still lists its row").toBeTruthy();
        expect(after).toMatchObject({
          display_name: row.displayName,
          status: "ready",
          allow_non_interactive: false,
        });
      });

      await test.step("B's list does not carry it, filtered or not", async () => {
        expect((await listOf(request, userB.headers)).map((r) => r.id)).not.toContain(row.id);
        expect((await listOf(request, userB.headers, "?provider=google")).map((r) => r.id)).not.toContain(row.id);
      });
    },
  );

  test(
    "an instance connection is visible to every user, but only a superuser may create, change or remove it",
    { tag: ["@stable", "@api", "@auth", "@integrations"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        `POST ${COLLECTION}`,
        `GET ${COLLECTION}`,
        `PATCH ${COLLECTION}/{connection_id}`,
        `POST ${COLLECTION}/{connection_id}/revoke`,
        `DELETE ${COLLECTION}/{connection_id}`,
      ]);
      const instance = await plant(request, superHeaders, "instance", { ownershipMode: "instance" });

      await test.step("B's list carries the instance row", async () => {
        expect((await listOf(request, userB.headers)).map((r) => r.id)).toContain(instance.id);
      });

      await test.step("B may not create one", async () => {
        const name = uniqueConnectionName("connown_b_instance");
        const res = await request.post(COLLECTION, {
          headers: userB.headers,
          data: {
            provider_key: "google",
            name,
            display_name: `E2E ${name}`,
            executing_identity: { identity: "user_delegated" },
            ownership_mode: "instance",
            credentials: { access_token: `E2E-PLANTED-${randomUUID()}` },
          },
        });
        expect(res.status()).toBe(403);
        expect(await res.json()).toEqual(INSTANCE_CREATE_REFUSED);
      });

      await test.step("B may not change, revoke or delete one", async () => {
        const item = `${COLLECTION}/${instance.id}`;
        const sends: Array<[string, () => Promise<APIResponse>]> = [
          ["PATCH", () => request.patch(item, { headers: userB.headers, data: { display_name: "E2E not yours" } })],
          ["revoke", () => request.post(`${item}/revoke`, { headers: userB.headers })],
          ["DELETE", () => request.delete(item, { headers: userB.headers })],
        ];
        for (const [name, send] of sends) {
          const res = await send();
          expect(res.status(), name).toBe(403);
          expect(await res.json(), name).toEqual(INSTANCE_CHANGE_REFUSED);
        }
      });

      await test.step("the instance row is unchanged", async () => {
        expect(await rowIn(request, superHeaders, instance.id)).toMatchObject({
          display_name: instance.displayName,
          status: "ready",
          ownership_mode: "instance",
        });
      });
    },
  );

  test(
    "only the owner may allow non-interactive use, and anyone with write access may clear it",
    { tag: ["@stable", "@api", "@auth", "@integrations"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([`POST ${COLLECTION}`, `GET ${COLLECTION}`, `PATCH ${COLLECTION}/{connection_id}`]);
      const row = await plant(request, ownerA.headers, "optin");
      const setOptIn = (headers: Record<string, string>, value: boolean) =>
        request.patch(`${COLLECTION}/${row.id}`, { headers, data: { allow_non_interactive: value } });

      await test.step("the superuser may not widen it", async () => {
        const res = await setOptIn(superHeaders, true);
        expect(res.status()).toBe(403);
        expect(await res.json()).toEqual(OPT_IN_OWNER_ONLY);
        expect((await rowIn(request, ownerA.headers, row.id))?.allow_non_interactive).toBe(false);
      });

      await test.step("the owner may", async () => {
        const res = await setOptIn(ownerA.headers, true);
        expect(res.status(), await res.text()).toBe(200);
        expect(((await res.json()) as ConnectionRead).allow_non_interactive).toBe(true);
      });

      await test.step("the superuser may narrow it again", async () => {
        const res = await setOptIn(superHeaders, false);
        expect(res.status(), await res.text()).toBe(200);
        expect(((await res.json()) as ConnectionRead).allow_non_interactive).toBe(false);
        expect((await rowIn(request, ownerA.headers, row.id))?.allow_non_interactive).toBe(false);
      });
    },
  );

  test(
    "a superuser can check, rename, revoke and delete another user's connection",
    { tag: ["@stable", "@api", "@auth", "@integrations"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        `POST ${COLLECTION}`,
        `GET ${COLLECTION}`,
        `POST ${COLLECTION}/{connection_id}/test`,
        `PATCH ${COLLECTION}/{connection_id}`,
        `POST ${COLLECTION}/{connection_id}/revoke`,
        `DELETE ${COLLECTION}/{connection_id}`,
      ]);
      const row = await plant(request, ownerA.headers, "superuser");
      const item = `${COLLECTION}/${row.id}`;
      const renamed = `E2E renamed by the superuser ${row.name}`;

      await test.step("the superuser lists and checks it", async () => {
        expect((await listOf(request, superHeaders)).map((r) => r.id)).toContain(row.id);
        const res = await request.post(`${item}/test`, { headers: superHeaders, data: {} });
        expect(res.status(), await res.text()).toBe(200);
      });

      await test.step("a rename by the superuser is what A sees", async () => {
        const res = await request.patch(item, { headers: superHeaders, data: { display_name: renamed } });
        expect(res.status(), await res.text()).toBe(200);
        expect((await rowIn(request, ownerA.headers, row.id))?.display_name).toBe(renamed);
      });

      await test.step("a revoke by the superuser is what A sees", async () => {
        const res = await request.post(`${item}/revoke`, { headers: superHeaders });
        expect(res.status(), await res.text()).toBe(200);
        expect(((await res.json()) as ConnectionRead).status).toBe("revoked");
        expect((await rowIn(request, ownerA.headers, row.id))?.status).toBe("revoked");
      });

      await test.step("a delete by the superuser removes it from A's list", async () => {
        const res = await request.delete(item, { headers: superHeaders });
        expect(res.status(), await res.text()).toBe(204);
        expect(await rowIn(request, ownerA.headers, row.id)).toBeUndefined();
      });
    },
  );

  test(
    "the write limit is per user, and deleting a user removes its connections",
    { tag: ["@stable", "@api", "@auth", "@integrations"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([`POST ${COLLECTION}`, `GET ${COLLECTION}`, `PATCH ${COLLECTION}/{connection_id}`]);
      // Not added to `rows`: A is deleted below, and deleting A takes them.
      const first = await createConnectionViaApi(request, ownerA.headers, { label: "connown_cascade_1" });
      const second = await createConnectionViaApi(request, ownerA.headers, { label: "connown_cascade_2" });

      await test.step("A spends its write bucket", async () => {
        // Renames until one is refused, never more than one past the bucket.
        const statuses: number[] = [];
        let last: APIResponse | undefined;
        while (statuses.length <= WRITE_BUCKET && statuses.at(-1) !== 429) {
          last = await request.patch(`${COLLECTION}/${first.id}`, {
            headers: ownerA.headers,
            data: { display_name: `E2E spend ${statuses.length}` },
          });
          statuses.push(last.status());
        }
        expect(statuses.at(-1), `a write past the bucket is refused (statuses: ${statuses.join(",")})`).toBe(429);
        const accepted = statuses.slice(0, -1);
        expect(accepted.every((status) => status === 200), `every write before it was accepted: ${accepted}`).toBe(true);
        expect(accepted.length).toBeLessThanOrEqual(WRITE_BUCKET);
        expect(last?.headers()["retry-after"]).toBe("60");
        expect(await last?.json()).toEqual(TOO_MANY);
      });

      await test.step("B's write from the same client is accepted", async () => {
        const name = uniqueConnectionName("connown_b_after");
        const res = await request.post(COLLECTION, {
          headers: userB.headers,
          data: {
            provider_key: "google",
            name,
            display_name: `E2E ${name}`,
            executing_identity: { identity: "user_delegated" },
            credentials: { access_token: `E2E-PLANTED-${randomUUID()}` },
          },
        });
        expect(res.status(), await res.text()).toBe(201);
        const created = (await res.json()) as ConnectionRead;
        rows.push({
          id: created.id,
          name,
          displayName: created.display_name,
          connection: created,
          deleteConnection: (req?: APIRequestContext) =>
            deleteConnection(req ?? request, created.id, { headers: userB.headers }),
        });
      });

      await test.step("deleting A removes both of its connections", async () => {
        expect((await listOf(request, superHeaders)).map((r) => r.id)).toEqual(
          expect.arrayContaining([first.id, second.id]),
        );
        // 202, then waits until the user is erased; the rows go before the user.
        await ownerA.dispose();
        const ids = (await listOf(request, superHeaders)).map((r) => r.id);
        expect(ids).not.toContain(first.id);
        expect(ids).not.toContain(second.id);
      });
    },
  );
});
