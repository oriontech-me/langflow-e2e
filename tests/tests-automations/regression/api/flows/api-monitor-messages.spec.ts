import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";

// Endpoint: GET /api/v1/monitor/messages
// Backs the Playground chat history and the Logs page. Any regression here
// breaks message visibility in the UI for every flow's chat session.
//
// Every test declares the operation through the `apiCoverage` fixture (#1700): the
// declaration is verified against what the test actually issued, so the read counts
// in `npm run api:coverage` — where six tests driving it as a contract counted for
// nothing before. No assertion changed. The unauthenticated test declares too: it
// issues the call and asserts the refusal, which is a contract of the same operation.
test.describe("GET /api/v1/monitor/messages", () => {
  test(
    "returns 200 with array",
    { tag: ["@stable", "@release", "@api", "@regression"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare(["GET /api/v1/monitor/messages"]);
      const authToken = await getAuthToken(request);

      const res = await request.get("/api/v1/monitor/messages", {
        headers: { Authorization: authToken },
      });

      expect(res.status()).toBe(200);

      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
    },
  );

  test(
    "without auth returns 401 or 403",
    { tag: ["@stable", "@release", "@api", "@regression"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare(["GET /api/v1/monitor/messages"]);
      const res = await request.get("/api/v1/monitor/messages");

      expect([401, 403]).toContain(res.status());
    },
  );

  test(
    "filtered by session_id returns only matching messages",
    { tag: ["@stable", "@release", "@api", "@regression"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare(["GET /api/v1/monitor/messages"]);
      const authToken = await getAuthToken(request);
      const uniqueSession = `monitor-test-session-${Date.now()}`;

      const res = await request.get(
        `/api/v1/monitor/messages?session_id=${uniqueSession}`,
        { headers: { Authorization: authToken } },
      );

      expect(res.status()).toBe(200);

      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);

      for (const msg of body) {
        expect(msg.session_id).toBe(uniqueSession);
      }
    },
  );

  test(
    "filtered by flow_id returns only matching messages",
    { tag: ["@stable", "@release", "@api", "@regression"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare(["GET /api/v1/monitor/messages"]);
      const authToken = await getAuthToken(request);
      const fakeFlowId = "00000000-0000-0000-0000-000000000001";

      const res = await request.get(
        `/api/v1/monitor/messages?flow_id=${fakeFlowId}`,
        { headers: { Authorization: authToken } },
      );

      expect(res.status()).toBe(200);

      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);

      for (const msg of body) {
        expect(msg.flow_id).toBe(fakeFlowId);
      }
    },
  );

  test(
    "combined session_id and flow_id filters return 200",
    { tag: ["@stable", "@release", "@api", "@regression"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare(["GET /api/v1/monitor/messages"]);
      const authToken = await getAuthToken(request);
      const uniqueSession = `monitor-combined-${Date.now()}`;
      const fakeFlowId = "00000000-0000-0000-0000-000000000002";

      const res = await request.get(
        `/api/v1/monitor/messages?flow_id=${fakeFlowId}&session_id=${uniqueSession}`,
        { headers: { Authorization: authToken } },
      );

      expect(res.status()).toBe(200);

      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);

      for (const msg of body) {
        expect(msg.flow_id).toBe(fakeFlowId);
        expect(msg.session_id).toBe(uniqueSession);
      }
    },
  );

  test(
    "messages contain required fields when not empty",
    { tag: ["@stable", "@release", "@api", "@regression"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare(["GET /api/v1/monitor/messages"]);
      const authToken = await getAuthToken(request);

      const res = await request.get("/api/v1/monitor/messages", {
        headers: { Authorization: authToken },
      });

      expect(res.status()).toBe(200);

      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);

      if (body.length > 0) {
        const msg = body[0];
        expect(msg).toHaveProperty("id");
        expect(msg).toHaveProperty("session_id");
        expect(msg).toHaveProperty("timestamp");
        expect(msg).toHaveProperty("sender");
        expect(msg).toHaveProperty("text");
      }
    },
  );
});
