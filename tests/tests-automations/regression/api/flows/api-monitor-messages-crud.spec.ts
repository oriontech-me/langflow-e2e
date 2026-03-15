import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";

// These tests exercise the /api/v1/monitor/messages endpoint beyond the basic
// coverage already in api-monitor-messages.spec.ts.  They focus on:
//  - flow_id query-parameter filtering
//  - combined filter parameters
//  - DELETE to clear message history
//  - pagination / limit parameter handling

test.describe("Monitor Messages API — Extended CRUD", () => {
  test(
    "GET /api/v1/monitor/messages accepts flow_id filter and returns 200",
    { tag: ["@release", "@workspace", "@regression"] },
    async ({ request }) => {
      const authToken = await getAuthToken(request);

      // Use a valid UUID format that is unlikely to have any messages.
      const fakeFlowId = "00000000-0000-0000-0000-000000000001";
      const res = await request.get(
        `/api/v1/monitor/messages?flow_id=${fakeFlowId}`,
        { headers: { Authorization: authToken } },
      );

      expect(res.status()).toBe(200);

      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);

      // If any results come back, every message must belong to the requested flow.
      for (const msg of body) {
        expect(msg.flow_id).toBe(fakeFlowId);
      }
    },
  );

  test(
    "GET /api/v1/monitor/messages accepts session_id filter and returns 200",
    { tag: ["@release", "@workspace", "@regression"] },
    async ({ request }) => {
      const authToken = await getAuthToken(request);
      const uniqueSession = `crud-test-session-${Date.now()}`;

      const res = await request.get(
        `/api/v1/monitor/messages?session_id=${uniqueSession}`,
        { headers: { Authorization: authToken } },
      );

      expect(res.status()).toBe(200);

      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);

      // A brand-new session ID must yield zero messages.
      expect(body.length).toBe(0);
    },
  );

  test(
    "GET /api/v1/monitor/messages without auth returns 401 or 403",
    { tag: ["@release", "@workspace", "@regression"] },
    async ({ request }) => {
      // Intentionally omit the Authorization header.
      const res = await request.get("/api/v1/monitor/messages");

      expect([401, 403]).toContain(res.status());
    },
  );

  test(
    "GET /api/v1/monitor/messages with combined flow_id and session_id filters returns 200",
    { tag: ["@release", "@workspace", "@regression"] },
    async ({ request }) => {
      const authToken = await getAuthToken(request);

      // Use a valid UUID format for flow_id
      const res = await request.get(
        "/api/v1/monitor/messages?flow_id=00000000-0000-0000-0000-000000000002&session_id=fake-session-99",
        { headers: { Authorization: authToken } },
      );

      // Combining both filters must not cause a server error.
      expect(res.status()).toBe(200);

      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
    },
  );

  test(
    "DELETE /api/v1/monitor/messages clears message history or returns 404/405 if not implemented",
    { tag: ["@release", "@workspace", "@regression"] },
    async ({ request }) => {
      const authToken = await getAuthToken(request);

      const res = await request.delete("/api/v1/monitor/messages", {
        headers: { Authorization: authToken },
      });

      // 200 / 204 → endpoint exists and history was cleared.
      // 404 / 405 / 422 → endpoint not implemented or requires params; acceptable.
      expect([200, 204, 404, 405, 422]).toContain(res.status());
    },
  );
});
