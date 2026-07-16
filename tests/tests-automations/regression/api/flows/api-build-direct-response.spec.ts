import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { createRunnableChatFlowViaApi } from "../../../../helpers/flows/create-runnable-chat-flow-via-api";
import { parseNdjson } from "../../../../helpers/other/parse-ndjson";

// Validates the `direct` event-delivery path of POST /api/v1/build/{flow_id}/flow —
// the transport the Playground uses to receive a flow run's results
// (QA-CHECKLIST §9.1 → "Direct response").
//
// The endpoint selects the delivery mode via the `event_delivery` query param:
//   - streaming / polling → the POST returns { job_id }, and the client then
//     consumes GET /build/{job_id}/events (two-step).
//   - direct → the POST streams the full build-event body inline (NDJSON) in its
//     own response, with no job_id and no follow-up events request (one-step).
//
// The flow is a deterministic Chat Input -> Chat Output passthrough (no LLM), and
// the echoed value is a per-run sentinel, so "the flow actually ran inside the
// single response" cannot pass on a structurally valid but empty shell.
// The /build endpoint authenticates with Bearer (CurrentActiveUser), so the flow
// is created with the same Bearer identity that builds it.

test.describe("POST /api/v1/build/{flow_id}/flow — direct response delivery", () => {
  let flowId: string;
  let bearerToken: string;
  let deleteFlow: (reqOverride?: APIRequestContext) => Promise<void>;

  test.beforeAll(async ({ request }) => {
    bearerToken = await getAuthToken(request);

    // Create the runnable flow under the same Bearer identity that will build it —
    // /build authenticates with Bearer and the flow owner must match.
    const flow = await createRunnableChatFlowViaApi(request, {
      Authorization: bearerToken,
    });
    flowId = flow.flowId;
    deleteFlow = flow.deleteFlow;
  });

  test.afterAll(async ({ request }) => {
    // Delete flow with afterAll's OWN request — the beforeAll `request` that
    // created it cannot be reused here (Playwright fixture-scope rule).
    if (deleteFlow) {
      await deleteFlow(request);
    }
  });

  test(
    "direct event_delivery streams build events inline (no job_id) and echoes the input",
    { tag: ["@api", "@regression", "@playground", "@stable"] },
    async ({ request }) => {
      // Per-run sentinel: the Chat Output echoes it, so its presence proves the
      // flow executed inside this single response, not a valid-but-empty shell.
      const sentinel = `ECHO-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

      const response = await request.post(
        `/api/v1/build/${flowId}/flow?event_delivery=direct`,
        {
          headers: { Authorization: bearerToken },
          data: { inputs: { input_value: sentinel } },
        },
      );

      expect(response.status()).toBe(200);

      // The direct body is NDJSON (application/x-ndjson), one event per line —
      // NOT a single JSON document, so parse line-by-line.
      const body = await response.text();
      const events = parseNdjson(body);
      const eventNames = events.map((e) => e.event);

      // The entire build streamed inline: the ordered event lifecycle is present.
      expect(eventNames).toContain("vertices_sorted");
      expect(eventNames).toContain("build_start");
      expect(eventNames).toContain("end");

      // This is the direct path, not the two-step job path: every line is an
      // inline build event, and none is a { job_id } shell. Asserting on the
      // parsed shape (not a substring of the raw body) avoids a false positive
      // if a future event payload ever contains the substring "job_id".
      expect(events.every((e) => e.event !== undefined)).toBe(true);
      expect(events.every((e) => e.job_id === undefined)).toBe(true);

      // The Chat Output genuinely executed inside the direct response. The stream
      // carries two add_message events with the same text — the User input echo
      // (sender "User") and the Chat Output response (sender "Machine"). Assert on
      // the OUTPUT message specifically: matching any add_message would also be
      // satisfied by the input echo alone, so a Chat Output that stopped emitting
      // its message would slip through as a false negative.
      const outputMessages = events.filter(
        (e) => e.event === "add_message" && e.data?.sender === "Machine",
      );
      expect(outputMessages.length).toBeGreaterThan(0);
      expect(outputMessages.some((e) => e.data?.text === sentinel)).toBe(true);
    },
  );

  test(
    "direct is distinct from the job_id path: streaming delivery returns a job_id",
    { tag: ["@api", "@regression", "@playground", "@stable"] },
    async ({ request }) => {
      const response = await request.post(
        `/api/v1/build/${flowId}/flow?event_delivery=streaming`,
        {
          headers: { Authorization: bearerToken },
          data: { inputs: { input_value: "streaming-contrast" } },
        },
      );

      expect(response.status()).toBe(200);

      // Contract contrast: the same endpoint + same flow returns a fundamentally
      // different shape purely from the delivery mode. Streaming/polling is the
      // two-step job path — a JSON object carrying a string job_id and NO inline
      // event stream. Consuming the SSE events endpoint is out of scope (#696).
      const body = await response.json();
      expect(typeof body.job_id).toBe("string");
      expect(body.job_id.length).toBeGreaterThan(0);
      expect(body.event).toBeUndefined();

      // Streaming is the two-step path: this POST enqueued a build whose events
      // are never consumed here. Cancel it so the abandoned job does not linger
      // in the queue service across runs (best-effort — a failed cancel must not
      // fail the assertion above).
      await request
        .post(`/api/v1/build/${body.job_id}/cancel`, {
          headers: { Authorization: bearerToken },
        })
        .catch(() => {});
    },
  );
});
