import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";

// Endpoint: GET /api/v1/monitor/messages
// Returns paginated list of chat messages from all sessions
test.describe("GET /api/v1/monitor/messages", () => {
  test(
    "returns 200 with valid structure",
    { tag: ["@release", "@api", "@regression"] },
    async ({ request }) => {
      const authToken = await getAuthToken(request);

      const res = await request.get("/api/v1/monitor/messages", {
        headers: { Authorization: authToken },
      });

      expect(res.status()).toBe(200);

      const body = await res.json();
      // Response must be an array (may be empty if no messages exist)
      expect(Array.isArray(body)).toBe(true);
    },
  );

  test(
    "requires authentication — unauthenticated request returns 401 or 403",
    { tag: ["@release", "@api", "@regression"] },
    async ({ request }) => {
      const res = await request.get("/api/v1/monitor/messages");

      expect([401, 403]).toContain(res.status());
    },
  );

  test(
    "filter by session_id returns only matching messages",
    { tag: ["@release", "@api", "@regression"] },
    async ({ request }) => {
      const authToken = await getAuthToken(request);
      const uniqueSession = `test-session-${Date.now()}`;

      // Fetch messages filtered by a unique session_id that likely has no messages
      const res = await request.get(
        `/api/v1/monitor/messages?session_id=${uniqueSession}`,
        { headers: { Authorization: authToken } },
      );

      expect(res.status()).toBe(200);

      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);

      // All returned messages must belong to the requested session
      for (const msg of body) {
        expect(msg.session_id).toBe(uniqueSession);
      }
    },
  );

  test(
    "messages contain required fields when not empty",
    { tag: ["@release", "@api", "@regression"] },
    async ({ request }) => {
      const authToken = await getAuthToken(request);

      const res = await request.get("/api/v1/monitor/messages", {
        headers: { Authorization: authToken },
      });

      expect(res.status()).toBe(200);

      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);

      // Validate structure only if there are existing messages
      if (body.length > 0) {
        const msg = body[0];
        // Each message must have these required fields
        expect(msg).toHaveProperty("id");
        expect(msg).toHaveProperty("session_id");
        expect(msg).toHaveProperty("timestamp");
        expect(msg).toHaveProperty("sender");
        expect(msg).toHaveProperty("text");
      }
    },
  );
});
