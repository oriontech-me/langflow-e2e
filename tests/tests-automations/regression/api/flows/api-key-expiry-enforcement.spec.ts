import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import {
  SUPERUSER_PASSWORD,
  SUPERUSER_USERNAME,
} from "../../../../helpers/auth/credentials";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";

/**
 * Companion to the PR #13471 timezone-display regression: that fix proved the
 * displayed timestamps were a *rendering* problem. This spec asserts the other
 * half — that API key *expiry enforcement* is correct and is NOT shifted by the
 * same timezone offset the display bug exposed.
 *
 * `/api/v1/run/{id}` authenticates with `x-api-key`. An expired key must be
 * rejected (403) and a valid key accepted (200). The boundary test is the
 * important one: a key expiring 30 min in the future / past (UTC) sits well
 * inside the ±3h America/Sao_Paulo offset window, so if the backend compared a
 * naive-UTC `expires_at` against a local "now" (or vice-versa), one of the two
 * boundary keys would flip its verdict. Both must come out correct.
 */

const MINUTE = 60 * 1000;

async function resolveBearer(request: APIRequestContext): Promise<string> {
  const auto = await request.get("/api/v1/auto_login");
  if (auto.ok()) {
    const body = await auto.json();
    if (body?.access_token) return `Bearer ${body.access_token}`;
  }
  const form = new URLSearchParams();
  form.append("username", SUPERUSER_USERNAME);
  form.append("password", SUPERUSER_PASSWORD);
  const res = await request.post("/api/v1/login", {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    data: form.toString(),
  });
  expect(res.status(), "form login should succeed").toBe(200);
  const data = await res.json();
  expect(data.access_token, "login should return an access token").toBeTruthy();
  return `Bearer ${data.access_token}`;
}

test.describe("API key expiry enforcement (PR #13471 companion)", () => {
  test.describe.configure({ mode: "serial" });

  let bearer: string;
  let flowId: string;
  const createdKeyIds: string[] = [];

  // Mint an API key with the given UTC expiry and return its plaintext + id.
  async function createKey(
    request: APIRequestContext,
    name: string,
    expiresAtUtc: string | null,
  ): Promise<{ key: string; id: string }> {
    const data: Record<string, unknown> = { name };
    if (expiresAtUtc) data.expires_at = expiresAtUtc;
    const res = await request.post("/api/v1/api_key/", {
      headers: { Authorization: bearer },
      data,
    });
    expect(res.status(), "key creation returns 200").toBe(200);
    const body = await res.json();
    expect(body.api_key, "creation returns the plaintext key").toBeTruthy();
    createdKeyIds.push(body.id);
    return { key: body.api_key, id: body.id };
  }

  // Attempt a flow run authenticated with the given x-api-key; return the status.
  async function runWithKey(
    request: APIRequestContext,
    apiKey: string,
  ): Promise<number> {
    const res = await request.post(`/api/v1/run/${flowId}`, {
      headers: { "x-api-key": apiKey },
      data: { input_value: "ping", input_type: "chat", output_type: "chat" },
    });
    return res.status();
  }

  test.beforeAll(async ({ request }) => {
    bearer = await resolveBearer(request);
    const flowRes = await request.post("/api/v1/flows/", {
      headers: { Authorization: bearer },
      data: {
        name: `expiry-enforcement-flow-${Date.now()}`,
        data: { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
        is_component: false,
      },
    });
    expect(flowRes.status()).toBe(201);
    flowId = (await flowRes.json()).id;
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdKeyIds) {
      await request.delete(`/api/v1/api_key/${id}`, {
        headers: { Authorization: bearer },
      });
    }
    if (flowId) {
      await deleteFlow(request, flowId, { headers: { Authorization: bearer } });
    }
  });

  test(
    "rejects an expired API key with 403 and accepts a valid one with 200",
    { tag: ["@regression", "@api", "@settings", "@stable"] },
    async ({ request }) => {
      const expired = await test.step("create an already-expired key", () =>
        createKey(
          request,
          `enf-expired-${Date.now()}`,
          "2020-01-01T00:00:00+00:00",
        ));

      const valid = await test.step("create a long-lived valid key", () =>
        createKey(
          request,
          `enf-valid-${Date.now()}`,
          "2099-12-31T23:59:59+00:00",
        ));

      await test.step("expired key is refused on /run", async () => {
        expect(await runWithKey(request, expired.key)).toBe(403);
      });

      await test.step("valid key is accepted on /run", async () => {
        expect(await runWithKey(request, valid.key)).toBe(200);
      });
    },
  );

  test(
    "evaluates the expiry boundary in UTC, not shifted by the viewer offset",
    { tag: ["@regression", "@api", "@settings", "@stable"] },
    async ({ request }) => {
      // 30 min margins: inside the ±3h offset window, so a timezone-shifted
      // comparison would flip exactly one of these two verdicts.
      const future = await test.step("key expiring in 30 min (UTC)", () =>
        createKey(
          request,
          `enf-future-${Date.now()}`,
          new Date(Date.now() + 30 * MINUTE).toISOString(),
        ));

      const past = await test.step("key expired 30 min ago (UTC)", () =>
        createKey(
          request,
          `enf-past-${Date.now()}`,
          new Date(Date.now() - 30 * MINUTE).toISOString(),
        ));

      await test.step("near-future key is still valid (200)", async () => {
        expect(await runWithKey(request, future.key)).toBe(200);
      });

      await test.step("recently-expired key is refused (403)", async () => {
        expect(await runWithKey(request, past.key)).toBe(403);
      });
    },
  );
});
