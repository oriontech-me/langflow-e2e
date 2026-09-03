import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";

// The flow events log (`{flow_id}/events`), hidden from /openapi.json. Spec doc:
// docs/api/flows/api-flows-events.md
//
// Flagged in #1699 as a possible stream surface; measured on 1.13.0.dev0 it is plain
// JSON with a closed contract: a `settled` flag that flips once events are recorded,
// and a `type` restricted to seven literals the 422 enumerates.
test.describe("Flows API — events log", () => {
  const EVENT_TYPES = [
    "component_added",
    "component_removed",
    "component_configured",
    "connection_added",
    "connection_removed",
    "flow_updated",
    "flow_settled",
  ];

  const createdFlowIds: string[] = [];

  test.afterEach(async ({ request }) => {
    const authToken = await getAuthToken(request);
    for (const id of createdFlowIds) {
      await deleteFlow(request, id, {
        headers: { Authorization: authToken },
      }).catch((error) => {
        console.warn(`⚠️ Orphan flow left behind (${id}): ${error}`);
      });
    }
    createdFlowIds.length = 0;
  });

  async function createFlow(
    request: Parameters<typeof getAuthToken>[0],
    authToken: string,
  ): Promise<string> {
    const res = await request.post("/api/v1/flows/", {
      headers: { Authorization: authToken },
      data: {
        name: `api-flows-events ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        description: "events",
        data: { nodes: [], edges: [] },
      },
    });
    expect(res.status()).toBe(201);
    const id = (await res.json()).id as string;
    createdFlowIds.push(id);
    return id;
  }

  test(
    "a fresh flow has an empty, settled event log",
    { tag: ["@stable", "@api", "@workspace"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare(["POST /api/v1/flows/", "GET /api/v1/flows/{flow_id}/events"]);
      const authToken = await getAuthToken(request);
      const flowId = await createFlow(request, authToken);
      const res = await request.get(`/api/v1/flows/${flowId}/events`, {
        headers: { Authorization: authToken },
      });
      expect(res.status()).toBe(200);
      expect(await res.json()).toEqual({ events: [], settled: true });
    },
  );

  test(
    "posting events validates the type and un-settles the log",
    { tag: ["@stable", "@api", "@workspace"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        "POST /api/v1/flows/",
        "POST /api/v1/flows/{flow_id}/events",
        "GET /api/v1/flows/{flow_id}/events",
      ]);
      const authToken = await getAuthToken(request);
      const flowId = await createFlow(request, authToken);
      const url = `/api/v1/flows/${flowId}/events`;

      await test.step("a body without type is refused", async () => {
        const res = await request.post(url, {
          headers: { Authorization: authToken },
          data: {},
        });
        expect(res.status()).toBe(422);
        expect((await res.json()).detail[0].loc).toEqual(["body", "type"]);
      });

      await test.step("an unknown type is refused and the message enumerates the seven accepted ones", async () => {
        const res = await request.post(url, {
          headers: { Authorization: authToken },
          data: { type: "bogus" },
        });
        expect(res.status()).toBe(422);
        const detail = (await res.json()).detail[0];
        expect(detail.type).toBe("literal_error");
        // Asserted by name, so a renamed or dropped event type shows up as itself.
        for (const type of EVENT_TYPES) expect(detail.msg).toContain(`'${type}'`);
      });

      await test.step("a valid event is recorded with exactly type, timestamp and summary", async () => {
        const res = await request.post(url, {
          headers: { Authorization: authToken },
          data: { type: "flow_updated" },
        });
        expect(res.status()).toBe(201);
        const body = await res.json();
        expect(Object.keys(body).sort()).toEqual(["summary", "timestamp", "type"]);
        expect(body.type).toBe("flow_updated");
        expect(Number.isFinite(body.timestamp)).toBe(true);
        expect(body.summary).toBe("");
      });

      await test.step("extra fields are accepted and not echoed", async () => {
        const res = await request.post(url, {
          headers: { Authorization: authToken },
          data: { type: "component_added", component_id: "ChatInput-x", payload: { k: 1 } },
        });
        expect(res.status()).toBe(201);
        const body = await res.json();
        expect(Object.keys(body).sort()).toEqual(["summary", "timestamp", "type"]);
        expect(body.type).toBe("component_added");
      });

      await test.step("the log lists both events in order and is no longer settled", async () => {
        const res = await request.get(url, { headers: { Authorization: authToken } });
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(body.events).toHaveLength(2);
        expect(body.events[0].type).toBe("flow_updated");
        expect(body.events[1].type).toBe("component_added");
        expect(body.events[1].timestamp).toBeGreaterThanOrEqual(body.events[0].timestamp);
        // The flip is the contract: `true` on an empty log, `false` once activity is
        // recorded — what the editor reads as "unsaved activity".
        expect(body.settled).toBe(false);
      });
    },
  );
});
