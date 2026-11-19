import { randomUUID } from "node:crypto";
import type { APIRequestContext, APIResponse } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { type ConnectionsOwner, createConnectionsOwner } from "../../../../helpers/integrations/connections-owner";
import { type ConnectionRead, uniqueConnectionName } from "../../../../helpers/integrations/create-connection";

// The connection rate limits, asserted rather than avoided (#2302).
// Spec doc: docs/api/connections/api-connections-rate-limits.md
//
// Every test spends whole buckets, so each one runs under a throwaway user of its
// own: a fresh user starts with every bucket empty, which is what makes the counts
// exact. Serial, so no two tests can share a minute under one user.
//
// No allowHttpErrors() for the deliberate 429s: the fixture's HTTP monitor is
// installed on `page`, and this spec has none.
test.describe.configure({ mode: "serial" });

const COLLECTION = "/api/v1/connections";
const REGISTRATIONS = `${COLLECTION}/oauth/registrations`;
const INTEGRATIONS = "/api/v1/integrations";

/** `connection_metadata_rate_limit_per_minute`'s default: sized for the 2 s consent poll. */
const READ_BUCKET = 60;
/** `connection_write_rate_limit_per_minute`'s default: creates, updates, revokes and deletes. */
const WRITE_BUCKET = 30;
/** `rate_limit_per_minute`'s default (the login budget), which `/test` and `/health` fall back to. */
const PROBE_BUCKET = 5;

// Exact copy, measured on 1.14.0.dev32.
const TOO_MANY = { detail: "Too many requests. Please try again later.", retry_after: "60" };

/** The one shape every refusal on these routes has. */
async function expectTooMany(res: APIResponse, what: string): Promise<void> {
  const text = await res.text();
  expect(res.status(), `${what}: ${text}`).toBe(429);
  expect(res.headers()["content-type"], what).toContain("application/json");
  expect(res.headers()["retry-after"], what).toBe("60");
  expect(JSON.parse(text), what).toEqual(TOO_MANY);
}

/**
 * Sends `count` calls and returns their statuses, never retrying one. Sequential on
 * purpose: the bucket is a count, and concurrent calls would race the limiter.
 */
async function spend(count: number, call: (index: number) => Promise<APIResponse>): Promise<number[]> {
  const statuses: number[] = [];
  for (let index = 0; index < count; index++) statuses.push((await call(index)).status());
  return statuses;
}

/** A raw create, so the caller decides what its status means. */
async function createRaw(request: APIRequestContext, headers: Record<string, string>, label: string) {
  const name = uniqueConnectionName(label);
  return request.post(COLLECTION, {
    headers,
    data: {
      provider_key: "google",
      name,
      display_name: `E2E ${name}`,
      executing_identity: { identity: "user_delegated" },
      credentials: { access_token: `E2E-PLANTED-${randomUUID()}` },
    },
  });
}

test.describe("Connections — the rate limits, asserted rather than avoided", () => {
  let owner: ConnectionsOwner | undefined;

  test.beforeEach(async ({ playwright }, testInfo) => {
    owner = await createConnectionsOwner(
      () => playwright.request.newContext({ baseURL: testInfo.project.use.baseURL }),
      "connrl",
    );
  });

  test.afterEach(async () => {
    // Deleting the user removes every row it owns.
    await owner?.dispose();
    owner = undefined;
  });

  test(
    "the read bucket holds 60, is shared with the OAuth registrations read, and spares the manifest and writes",
    { tag: ["@stable", "@api", "@integrations"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([`GET ${COLLECTION}`, `GET ${REGISTRATIONS}`, `GET ${INTEGRATIONS}`, `POST ${COLLECTION}`]);
      const headers = owner!.headers;

      await test.step(`${READ_BUCKET} list reads are accepted`, async () => {
        const statuses = await spend(READ_BUCKET, () => request.get(COLLECTION, { headers }));
        expect(statuses, "a login-sized bucket would refuse the 6th poll, ~10 s into a consent").toEqual(
          Array(READ_BUCKET).fill(200),
        );
      });

      await test.step(`read ${READ_BUCKET + 1} is refused`, async () => {
        await expectTooMany(await request.get(COLLECTION, { headers }), `list read ${READ_BUCKET + 1}`);
      });

      await test.step("the OAuth registrations read is refused too: one bucket", async () => {
        await expectTooMany(await request.get(REGISTRATIONS, { headers }), "registrations read after the list's bucket");
      });

      await test.step("the manifest has a bucket of its own", async () => {
        const res = await request.get(INTEGRATIONS, { headers });
        expect(res.status(), await res.text()).toBe(200);
      });

      await test.step("a write is not refused by a spent read bucket", async () => {
        const res = await createRaw(request, headers, "connrl_after_reads");
        expect(res.status(), await res.text()).toBe(201);
      });
    },
  );

  test(
    "the write bucket holds 30, and spending it refuses neither a read nor a test",
    { tag: ["@stable", "@api", "@integrations"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        `POST ${COLLECTION}`,
        `PATCH ${COLLECTION}/{connection_id}`,
        `GET ${COLLECTION}`,
        `POST ${COLLECTION}/{connection_id}/test`,
      ]);
      const headers = owner!.headers;
      let row: ConnectionRead;

      await test.step("write 1: the create", async () => {
        // Raw, never the seeding helper: that one waits out a 429, and this create is
        // the first write the bucket counts.
        const res = await createRaw(request, headers, "connrl_writes");
        expect(res.status(), await res.text()).toBe(201);
        row = (await res.json()) as ConnectionRead;
      });

      await test.step(`writes 2..${WRITE_BUCKET}: renames are accepted`, async () => {
        const statuses = await spend(WRITE_BUCKET - 1, (index) =>
          request.patch(`${COLLECTION}/${row.id}`, { headers, data: { display_name: `E2E rename ${index}` } }),
        );
        expect(statuses).toEqual(Array(WRITE_BUCKET - 1).fill(200));
      });

      await test.step(`write ${WRITE_BUCKET + 1} is refused`, async () => {
        await expectTooMany(
          await request.patch(`${COLLECTION}/${row.id}`, { headers, data: { display_name: "E2E one too many" } }),
          `write ${WRITE_BUCKET + 1}`,
        );
      });

      await test.step("a list read and a test are still accepted", async () => {
        const read = await request.get(COLLECTION, { headers });
        expect(read.status(), await read.text()).toBe(200);
        const probe = await request.post(`${COLLECTION}/${row.id}/test`, { headers, data: {} });
        expect(probe.status(), await probe.text()).toBe(200);
      });
    },
  );

  test(
    "/test and /health hold 5 each, independently, and spending them refuses neither a write nor a read",
    { tag: ["@stable", "@api", "@integrations"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        `POST ${COLLECTION}`,
        `POST ${COLLECTION}/{connection_id}/test`,
        `POST ${COLLECTION}/{connection_id}/health`,
        `PATCH ${COLLECTION}/{connection_id}`,
        `GET ${COLLECTION}`,
      ]);
      const headers = owner!.headers;
      const created = await createRaw(request, headers, "connrl_probes");
      expect(created.status(), await created.text()).toBe(201);
      const row = (await created.json()) as ConnectionRead;
      const item = `${COLLECTION}/${row.id}`;

      await test.step(`${PROBE_BUCKET} tests are accepted, and the next is refused`, async () => {
        const statuses = await spend(PROBE_BUCKET, () => request.post(`${item}/test`, { headers, data: {} }));
        expect(statuses).toEqual(Array(PROBE_BUCKET).fill(200));
        await expectTooMany(await request.post(`${item}/test`, { headers, data: {} }), `test ${PROBE_BUCKET + 1}`);
      });

      await test.step(`with /test spent, ${PROBE_BUCKET} health checks are accepted, and the next is refused`, async () => {
        const statuses = await spend(PROBE_BUCKET, () => request.post(`${item}/health`, { headers }));
        expect(statuses, "spending /test spent /health").toEqual(Array(PROBE_BUCKET).fill(200));
        await expectTooMany(await request.post(`${item}/health`, { headers }), `health ${PROBE_BUCKET + 1}`);
      });

      await test.step("a rename and a list read are still accepted", async () => {
        const write = await request.patch(item, { headers, data: { display_name: "E2E after probes" } });
        expect(write.status(), await write.text()).toBe(200);
        const read = await request.get(COLLECTION, { headers });
        expect(read.status(), await read.text()).toBe(200);
      });
    },
  );
});
