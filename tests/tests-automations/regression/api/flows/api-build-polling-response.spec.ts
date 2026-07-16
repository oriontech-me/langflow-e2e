import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { createRunnableChatFlowViaApi } from "../../../../helpers/flows/create-runnable-chat-flow-via-api";
import {
  parseNdjson,
  type BuildEvent,
} from "../../../../helpers/other/parse-ndjson";

// Validates the `polling` event-delivery path of the flow build API — the
// transport the Playground uses to receive a flow run's results when
// event_delivery is `polling` (QA-CHECKLIST §9.1 → "Response polling").
// Sibling of the direct path (api-build-direct-response.spec.ts, #698) and the
// streaming/SSE path (#696).
//
// Polling is the two-step transport: POST /build/{flow_id}/flow?event_delivery=polling
// returns { job_id }, and the client then reads events from
// GET /build/{job_id}/events?event_delivery=polling. Each GET returns a discrete,
// bounded application/x-ndjson batch draining the currently-queued events, then
// closes — so the client POLLS IN A LOOP until a batch carries the terminal `end`
// event (mirrors the frontend's customPollBuildEvents). This differs from
// streaming, which pushes every event over a single long-lived connection.
//
// The flow is a deterministic Chat Input -> Chat Output passthrough (no LLM), and
// the echoed value is a per-run sentinel, so "the flow ran and its output arrived
// through the poll loop" cannot pass on a structurally valid but empty shell.
// The /build endpoint authenticates with Bearer (CurrentActiveUser), so the flow
// is created with the same Bearer identity that builds it.

const POLL_MAX_ITERATIONS = 40;
const POLL_EMPTY_DELAY_MS = 250;

test.describe("POST /api/v1/build/{flow_id}/flow — polling response delivery", () => {
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
    "polling is the two-step path: POST returns a job_id shell (no inline events)",
    { tag: ["@api", "@regression", "@playground", "@stable"] },
    async ({ request }) => {
      const response = await request.post(
        `/api/v1/build/${flowId}/flow?event_delivery=polling`,
        {
          headers: { Authorization: bearerToken },
          data: { inputs: { input_value: "polling-handshake" } },
        },
      );

      expect(response.status()).toBe(200);

      // The run's events are NOT in the POST response — polling is two-step: the
      // POST only hands back a job_id, and events are read from the separate
      // events endpoint. This is the contrast with the direct path (#698), whose
      // POST streams the events inline.
      const body = await response.json();
      expect(typeof body.job_id).toBe("string");
      expect(body.job_id.length).toBeGreaterThan(0);
      expect(body.event).toBeUndefined();

      // This job's events are not drained in this test — cancel it best-effort so
      // it does not linger in the queue service (a failed cancel must not fail the
      // assertions above).
      await request
        .post(`/api/v1/build/${body.job_id}/cancel`, {
          headers: { Authorization: bearerToken },
        })
        .catch(() => {});
    },
  );

  test(
    "the poll loop drains the build to completion across repeated GET /events calls",
    { tag: ["@api", "@regression", "@playground", "@stable"] },
    async ({ request }) => {
      // Per-run sentinel: the Chat Output echoes it, so its presence in the
      // accumulated events proves the flow executed and its output was delivered
      // through the poll loop, not a valid-but-empty shell.
      const sentinel = `POLL-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

      const buildResponse = await request.post(
        `/api/v1/build/${flowId}/flow?event_delivery=polling`,
        {
          headers: { Authorization: bearerToken },
          data: { inputs: { input_value: sentinel } },
        },
      );
      expect(buildResponse.status()).toBe(200);
      const jobId = (await buildResponse.json()).job_id;
      expect(typeof jobId).toBe("string");

      // Poll loop: each GET returns a bounded application/x-ndjson batch of the
      // currently-queued events, then closes. Repeat until a batch carries the
      // terminal `end` event, accumulating everything (mirrors customPollBuildEvents).
      const events: BuildEvent[] = [];
      let reachedEnd = false;
      for (let i = 0; i < POLL_MAX_ITERATIONS && !reachedEnd; i++) {
        const pollResponse = await request.get(
          `/api/v1/build/${jobId}/events?event_delivery=polling`,
          { headers: { Authorization: bearerToken, Accept: "application/x-ndjson" } },
        );
        expect(pollResponse.status()).toBe(200);
        expect(pollResponse.headers()["content-type"]).toContain(
          "application/x-ndjson",
        );

        const batch = parseNdjson(await pollResponse.text());
        events.push(...batch);
        reachedEnd = events.some((e) => e.event === "end");

        // The build is near-instant, but a batch can be empty while the next
        // event is still being produced — back off briefly before polling again.
        if (!reachedEnd && batch.length === 0) {
          await new Promise((resolve) => setTimeout(resolve, POLL_EMPTY_DELAY_MS));
        }
      }

      // The batched, client-driven delivery reassembled the complete run.
      expect(reachedEnd).toBe(true);
      const eventNames = events.map((e) => e.event);
      expect(eventNames).toContain("vertices_sorted");
      expect(eventNames).toContain("build_start");
      expect(eventNames).toContain("end");

      // The Chat Output genuinely executed and its output arrived through the poll
      // loop. The stream carries two add_message events with the same text — the
      // User input echo (sender "User") and the Chat Output response (sender
      // "Machine"). Assert on the OUTPUT message specifically: matching any
      // add_message would also be satisfied by the input echo alone.
      const outputMessages = events.filter(
        (e) => e.event === "add_message" && e.data?.sender === "Machine",
      );
      expect(outputMessages.length).toBeGreaterThan(0);
      expect(outputMessages.some((e) => e.data?.text === sentinel)).toBe(true);
    },
  );
});
