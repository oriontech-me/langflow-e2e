import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { createRunnableChatFlowViaApi } from "../../../../helpers/flows/create-runnable-chat-flow-via-api";

// The /api/v1/run endpoint requires x-api-key authentication (not Bearer).
// This test creates a temporary API key in beforeAll and deletes it in afterAll.
// The flow is a runnable Chat Input -> Chat Output passthrough (no LLM required)
// so the tests can assert both the structural contract (status codes, response
// shape) AND semantic output: non-empty `outputs` and message persistence under
// the custom `session_id`.

test.describe("POST /api/v1/run", () => {
  let flowId: string;
  let apiKey: string;
  let apiKeyId: string;
  let bearerToken: string;
  let deleteFlow: () => Promise<void>;

  test.beforeAll(async ({ request }) => {
    bearerToken = await getAuthToken(request);

    // Create a temporary API key for run tests
    const keyRes = await request.post("/api/v1/api_key/", {
      headers: { Authorization: bearerToken },
      data: { name: `playwright-run-test-${Date.now()}` },
    });
    expect(keyRes.status()).toBe(200);
    const keyBody = await keyRes.json();
    expect(keyBody).toHaveProperty("api_key");
    expect(keyBody).toHaveProperty("id");
    apiKey = keyBody.api_key;
    apiKeyId = keyBody.id;

    // Create a runnable flow using the API key (owner must match the API key)
    const flow = await createRunnableChatFlowViaApi(request, {
      "x-api-key": apiKey,
    });
    flowId = flow.flowId;
    deleteFlow = flow.deleteFlow;
  });

  test.afterAll(async ({ request }) => {
    // Delete flow
    if (deleteFlow) {
      await deleteFlow();
    }
    // Delete temporary API key
    if (apiKeyId) {
      await request.delete(`/api/v1/api_key/${apiKeyId}`, {
        headers: { Authorization: bearerToken },
      });
    }
  });

  test(
    "executes flow with input_value and returns outputs",
    { tag: ["@stable", "@release", "@api", "@regression"] },
    async ({ request }) => {
      const response = await request.post(`/api/v1/run/${flowId}`, {
        headers: { "x-api-key": apiKey },
        data: {
          input_value: "Hello, Langflow!",
          input_type: "chat",
          output_type: "chat",
        },
      });

      expect(response.status()).toBe(200);
      const body = await response.json();
      expect(body).toHaveProperty("outputs");
      expect(Array.isArray(body.outputs)).toBeTruthy();
      // The flow is runnable (Chat Input -> Chat Output), so execution must
      // produce at least one output group. An empty array would mean the
      // backend accepted the request but did not actually run the flow.
      expect(body.outputs.length).toBeGreaterThan(0);
    },
  );

  test(
    "executes flow with custom session_id and persists messages under it",
    { tag: ["@stable", "@release", "@api", "@regression"] },
    async ({ request }) => {
      const customSessionId = `test-session-${Date.now()}`;
      // A unique value so the persistence assertion cannot accidentally match
      // a message from another session or the flow's stored default.
      const inputValue = `Test with session ${Date.now()}`;

      const response = await request.post(`/api/v1/run/${flowId}`, {
        headers: { "x-api-key": apiKey },
        data: {
          input_value: inputValue,
          input_type: "chat",
          output_type: "chat",
          session_id: customSessionId,
        },
      });

      expect(response.status()).toBe(200);
      const body = await response.json();
      expect(body).toHaveProperty("session_id");
      expect(body.session_id).toBe(customSessionId);

      // The run must persist its chat messages under the custom session_id, so
      // GET /api/v1/monitor/messages?session_id=<id> returns them. Persistence
      // can lag the run response slightly, so poll briefly. (The monitor
      // endpoint authenticates with Bearer, not x-api-key.)
      let messages: Array<{ session_id: string; text?: string }> = [];
      let lastStatus = 0;
      await expect
        .poll(
          async () => {
            const res = await request.get(
              `/api/v1/monitor/messages?session_id=${customSessionId}`,
              { headers: { Authorization: bearerToken } },
            );
            lastStatus = res.status();
            // Tolerate a transient non-200 by retrying (return 0) rather than
            // throwing inside the poll, which would fail the test immediately.
            if (lastStatus !== 200) return 0;
            messages = await res.json();
            return messages.length;
          },
          { timeout: 10_000 },
        )
        .toBeGreaterThan(0);
      expect(lastStatus).toBe(200);

      // Every persisted message belongs to the requested session, and the user
      // input we sent was recorded — proving the run actually executed and wrote
      // through this session_id rather than returning a structurally valid shell.
      for (const msg of messages) {
        expect(msg.session_id).toBe(customSessionId);
      }
      expect(messages.some((msg) => msg.text === inputValue)).toBe(true);
    },
  );

  test(
    "returns 404 for non-existent flow ID",
    { tag: ["@stable", "@release", "@api", "@regression"] },
    async ({ request }) => {
      const fakeFlowId = "00000000-0000-0000-0000-000000000000";

      const response = await request.post(`/api/v1/run/${fakeFlowId}`, {
        headers: { "x-api-key": apiKey },
        data: {
          input_value: "Hello",
          input_type: "chat",
          output_type: "chat",
        },
      });

      expect(response.status()).toBe(404);
    },
  );
});
