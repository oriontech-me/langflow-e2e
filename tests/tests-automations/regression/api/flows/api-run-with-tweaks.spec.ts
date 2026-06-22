import { readFileSync } from "fs";
import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";

// Tests the POST /api/v1/run/{flow_id} endpoint with the `tweaks` parameter,
// which lets callers override flow component configuration at runtime.
//
// Unlike a structural smoke test, this spec runs against a real
// Chat Input -> Chat Output passthrough flow so the override is observable:
// Chat Output echoes whatever value Chat Input emits, so a tweak on
// Chat Input.input_value changes the response text in a deterministic way —
// no LLM or external provider key required.
//
// Backend reference (Langflow): tweaks reference a component by node id OR by
// display name, and tweaks targeting a non-existent component/field are
// silently ignored (returns 200). Passing a top-level `input_value` together
// with a Chat Input tweak on the same `input_value` field is rejected with 400
// ("you cannot pass a tweak with the same name"), so the tests below omit the
// top-level input and drive the value purely through the tweak.

// The imported fixture is a Chat Input -> Chat Output flow whose Chat Input has
// a stored `input_value` default of "Hello".
const FIXTURE_PATH = "tests/assets/flows/chat-io-ok-trace-fixture.json";
const CHAT_INPUT_DISPLAY_NAME = "Chat Input";
const FIXTURE_DEFAULT_INPUT = "Hello";

// Minimal shape of the run endpoint response needed to read the output text.
interface RunResponseBody {
  outputs?: Array<{
    outputs?: Array<{
      results?: { message?: { text?: string } };
    }>;
  }>;
}

// Extracts the Chat Output text from the run endpoint response.
function getOutputText(body: RunResponseBody): string | undefined {
  return body?.outputs?.[0]?.outputs?.[0]?.results?.message?.text;
}

test.describe("POST /api/v1/run with tweaks", () => {
  let bearerToken: string;
  let apiKey: string;
  let apiKeyId: string;
  let flowId: string;

  test.beforeAll(async ({ request }) => {
    bearerToken = await getAuthToken(request);

    // Create an API key for the run endpoint (requires x-api-key, not Bearer)
    const keyRes = await request.post("/api/v1/api_key/", {
      headers: { Authorization: bearerToken },
      data: { name: `tweaks-test-key-${Date.now()}` },
    });
    expect(keyRes.status()).toBe(200);
    const keyBody = await keyRes.json();
    apiKey = keyBody.api_key;
    apiKeyId = keyBody.id;

    // Import the Chat Input -> Chat Output fixture as a runnable flow
    const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf-8"));
    const flowRes = await request.post("/api/v1/flows/", {
      headers: { Authorization: bearerToken },
      data: {
        name: `Tweaks Test Flow ${Date.now()}`,
        description: "Chat Input -> Chat Output passthrough for tweaks override tests",
        data: fixture.data,
        is_component: false,
      },
    });
    expect(flowRes.status()).toBe(201);
    flowId = (await flowRes.json()).id;
  });

  test.afterAll(async ({ request }) => {
    if (flowId) {
      await request
        .delete(`/api/v1/flows/${flowId}`, {
          headers: { Authorization: bearerToken },
        })
        .catch(() => {});
    }
    if (apiKeyId) {
      await request
        .delete(`/api/v1/api_key/${apiKeyId}`, {
          headers: { Authorization: bearerToken },
        })
        .catch(() => {});
    }
  });

  test(
    "tweaks override a component field at runtime",
    { tag: ["@stable", "@release", "@api", "@regression"] },
    async ({ request }) => {
      // A unique value so the assertion cannot accidentally match the default.
      const tweakedValue = `TWEAKED-${Date.now()}`;

      // No top-level input_value: passing both a top-level input_value and a
      // tweak on Chat Input.input_value is rejected with 400, so we omit the
      // top-level input and drive the value purely through the tweak.
      const res = await request.post(`/api/v1/run/${flowId}`, {
        headers: { "x-api-key": apiKey },
        data: {
          input_type: "chat",
          output_type: "chat",
          tweaks: {
            [CHAT_INPUT_DISPLAY_NAME]: { input_value: tweakedValue },
          },
        },
      });

      expect(res.status()).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty("outputs");
      // The override is proven: the echoed output is the tweaked value,
      // not the fixture default ("Hello").
      expect(getOutputText(body)).toBe(tweakedValue);
    },
  );

  test(
    "empty tweaks object is a no-op and leaves the flow default in effect",
    { tag: ["@stable", "@api", "@regression"] },
    async ({ request }) => {
      // Same request as the override test minus the tweak: the response must
      // fall back to the flow's stored default, establishing the baseline that
      // makes the override test meaningful.
      const res = await request.post(`/api/v1/run/${flowId}`, {
        headers: { "x-api-key": apiKey },
        data: {
          input_type: "chat",
          output_type: "chat",
          tweaks: {},
        },
      });

      expect(res.status()).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty("outputs");
      expect(getOutputText(body)).toBe(FIXTURE_DEFAULT_INPUT);
    },
  );

  test(
    "tweaks referencing a non-existent component are silently ignored",
    { tag: ["@stable", "@api", "@regression"] },
    async ({ request }) => {
      // A tweak that targets a component not present in the flow must not error
      // and must not change the output — it is silently ignored (200).
      const res = await request.post(`/api/v1/run/${flowId}`, {
        headers: { "x-api-key": apiKey },
        data: {
          input_type: "chat",
          output_type: "chat",
          tweaks: {
            "NonExistentComponent-999": { input_value: "should be ignored" },
          },
        },
      });

      expect(res.status()).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty("outputs");
      // Output is unchanged from the flow default — the bogus tweak had no effect.
      expect(getOutputText(body)).toBe(FIXTURE_DEFAULT_INPUT);
    },
  );
});
