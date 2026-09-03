import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { createApiKey, deleteApiKey } from "../../../../helpers/auth/create-api-key";
import { createRunnableChatFlowViaApi } from "../../../../helpers/flows/create-runnable-chat-flow-via-api";

// The monitor router's messages lifecycle, sessions, builds, transactions and the
// job queue — eleven operations asserted over rows this file produces itself. Spec
// doc: docs/api/monitor/api-monitor-messages-lifecycle.md
//
// Rows come from an LLM-free run (Chat Input -> Chat Output fixture) through
// POST /api/v1/run/{flow_id} with an API KEY: under auto-login the bearer alone
// answers 403 for /run, while the monitor reads take the bearer. Each test runs on
// its own session_id so no test reads another's rows.
//
// Issue #1700 called four of these operations instance-wide wipes. Measured, none
// is: DELETE messages takes a body of message ids, DELETE messages/sessions a body
// of session ids, DELETE builds (and DELETE traces) require ?flow_id. The scoping is
// asserted here as part of the contract — every delete is checked on what SURVIVED.
test.describe("Monitor API — messages lifecycle, builds, transactions, job queue", () => {
  const RUN_HEADERS: Record<string, string> = {};
  let authHeaders: Record<string, string> = {};
  let flowId = "";
  let apiKeyId = "";
  let teardownFlow: (req?: APIRequestContext) => Promise<void> = async () => {};

  const uniqueSession = (label: string) =>
    `monitor-lifecycle-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  type MessageRow = {
    id: string;
    flow_id: string;
    session_id: string;
    sender: string;
    sender_name: string;
    text: string;
    edit: boolean;
    timestamp: string;
  };

  async function run(
    request: APIRequestContext,
    sessionId: string,
    input: string,
  ): Promise<void> {
    const res = await request.post(`/api/v1/run/${flowId}`, {
      headers: RUN_HEADERS,
      data: {
        input_value: input,
        input_type: "chat",
        output_type: "chat",
        session_id: sessionId,
      },
    });
    expect(res.status(), await res.text()).toBe(200);
  }

  async function messages(
    request: APIRequestContext,
    query: string,
  ): Promise<MessageRow[]> {
    const res = await request.get(`/api/v1/monitor/messages?${query}`, {
      headers: authHeaders,
    });
    expect(res.status()).toBe(200);
    return (await res.json()) as MessageRow[];
  }

  /** Persistence is not synchronous with the run's 200: poll to the expected count. */
  async function waitForMessages(
    request: APIRequestContext,
    query: string,
    atLeast: number,
  ): Promise<MessageRow[]> {
    await expect
      .poll(async () => (await messages(request, query)).length, { timeout: 20_000 })
      .toBeGreaterThanOrEqual(atLeast);
    return messages(request, query);
  }

  test.beforeAll(async ({ request }) => {
    const authToken = await getAuthToken(request);
    authHeaders = { Authorization: authToken };
    const key = await createApiKey(request, authHeaders, {
      namePrefix: "api-monitor-lifecycle",
    });
    apiKeyId = key.id;
    RUN_HEADERS["x-api-key"] = key.key;
    const flow = await createRunnableChatFlowViaApi(request, authHeaders);
    flowId = flow.flowId;
    teardownFlow = flow.deleteFlow;
  });

  test.afterAll(async ({ request }) => {
    // Deleting the flow cascades its messages, builds and transactions; the key
    // goes with it. Both are id-scoped — nothing another worker owns is touched.
    await teardownFlow(request).catch((error) => {
      console.warn(`⚠️ Orphan flow left behind (${flowId}): ${error}`);
    });
    if (apiKeyId) {
      await deleteApiKey(request, apiKeyId, authHeaders).catch((error) => {
        console.warn(`⚠️ Orphan API key left behind (${apiKeyId}): ${error}`);
      });
    }
  });

  test(
    "a run persists messages readable by flow, session and sender",
    { tag: ["@stable", "@api", "@observability"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        "GET /api/v1/monitor/messages",
        "GET /api/v1/monitor/messages/sessions",
      ]);
      const session = uniqueSession("read");
      await run(request, session, "hello-one");
      await run(request, session, "hello-two");

      await test.step("every row of the flow carries the flow id", async () => {
        const rows = await waitForMessages(request, `flow_id=${flowId}`, 4);
        for (const row of rows) expect(row.flow_id).toBe(flowId);
      });

      await test.step("session + sender filters narrow to exactly the two user turns", async () => {
        const rows = await waitForMessages(
          request,
          `session_id=${session}&sender=User`,
          2,
        );
        expect(rows).toHaveLength(2);
        expect(rows.map((r) => r.text).sort()).toEqual(["hello-one", "hello-two"]);
        for (const row of rows) {
          expect(row.sender).toBe("User");
          expect(row.sender_name).toBe("User");
          expect(row.session_id).toBe(session);
        }
      });

      await test.step("order=DESC&limit=1 returns exactly the newest row", async () => {
        const all = await messages(request, `session_id=${session}`);
        const newest = await messages(request, `session_id=${session}&order=DESC&limit=1`);
        expect(newest).toHaveLength(1);
        const maxTs = all.map((r) => r.timestamp).sort().at(-1);
        expect(newest[0].timestamp).toBe(maxTs);
      });

      await test.step("the sessions listing names the session", async () => {
        const res = await request.get(
          `/api/v1/monitor/messages/sessions?flow_id=${flowId}`,
          { headers: authHeaders },
        );
        expect(res.status()).toBe(200);
        const sessions = (await res.json()) as string[];
        expect(Array.isArray(sessions)).toBe(true);
        expect(sessions).toContain(session);
      });
    },
  );

  test(
    "a message can be edited in place, and the edit is flagged",
    { tag: ["@stable", "@api", "@observability"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        "GET /api/v1/monitor/messages",
        "PUT /api/v1/monitor/messages/{message_id}",
      ]);
      const session = uniqueSession("edit");
      await run(request, session, "before-edit");
      const [userRow] = await waitForMessages(request, `session_id=${session}&sender=User`, 1);
      expect(userRow.edit).toBe(false);

      await test.step("PUT changes the text and sets edit: true", async () => {
        const res = await request.put(`/api/v1/monitor/messages/${userRow.id}`, {
          headers: authHeaders,
          data: { text: "edited" },
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(body.id).toBe(userRow.id);
        expect(body.text).toBe("edited");
        expect(body.edit).toBe(true);
      });

      await test.step("GET agrees", async () => {
        const rows = await messages(request, `session_id=${session}&sender=User`);
        expect(rows).toHaveLength(1);
        expect(rows[0].text).toBe("edited");
        expect(rows[0].edit).toBe(true);
      });

      await test.step("an unknown id is refused", async () => {
        const res = await request.put(
          "/api/v1/monitor/messages/00000000-0000-4000-8000-000000000000",
          { headers: authHeaders, data: { text: "x" } },
        );
        expect(res.status()).toBe(404);
        expect((await res.json()).detail).toBe("Message not found");
      });
    },
  );

  test(
    "renaming a session moves every message and empties the old one",
    { tag: ["@stable", "@api", "@observability"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        "GET /api/v1/monitor/messages",
        "PATCH /api/v1/monitor/messages/session/{old_session_id}",
      ]);
      const session = uniqueSession("rename");
      const renamed = `${session}-renamed`;
      await run(request, session, "to-be-moved");
      const before = await waitForMessages(request, `session_id=${session}`, 2);

      await test.step("PATCH returns the moved messages under the new session", async () => {
        const res = await request.patch(
          `/api/v1/monitor/messages/session/${session}?new_session_id=${renamed}`,
          { headers: authHeaders },
        );
        expect(res.status()).toBe(200);
        const moved = (await res.json()) as MessageRow[];
        expect(moved).toHaveLength(before.length);
        for (const row of moved) expect(row.session_id).toBe(renamed);
      });

      await test.step("the old session is empty and the new one holds the rows", async () => {
        expect(await messages(request, `session_id=${session}`)).toEqual([]);
        expect(await messages(request, `session_id=${renamed}`)).toHaveLength(before.length);
      });

      await test.step("an unknown session is refused", async () => {
        const res = await request.patch(
          `/api/v1/monitor/messages/session/${uniqueSession("nope")}?new_session_id=x`,
          { headers: authHeaders },
        );
        expect(res.status()).toBe(404);
        expect((await res.json()).detail).toBe("No messages found with the given session ID");
      });
    },
  );

  test(
    "deletes are scoped: by message id, by session, by session list",
    { tag: ["@stable", "@api", "@observability"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        "GET /api/v1/monitor/messages",
        "DELETE /api/v1/monitor/messages",
        "DELETE /api/v1/monitor/messages/session/{session_id}",
        "GET /api/v1/monitor/messages/sessions",
        "DELETE /api/v1/monitor/messages/sessions",
      ]);
      const sessionD = uniqueSession("delete-d");
      const sessionE = uniqueSession("delete-e");
      await run(request, sessionD, "d-one");
      await run(request, sessionE, "e-one");
      const dRows = await waitForMessages(request, `session_id=${sessionD}`, 2);
      await waitForMessages(request, `session_id=${sessionE}`, 2);
      const dUser = dRows.find((r) => r.sender === "User") as MessageRow;

      await test.step("DELETE by id removes that message and nothing else in its session", async () => {
        const res = await request.delete("/api/v1/monitor/messages", {
          headers: authHeaders,
          data: [dUser.id],
        });
        expect(res.status()).toBe(204);
        const remaining = await messages(request, `session_id=${sessionD}`);
        expect(remaining.map((r) => r.id)).not.toContain(dUser.id);
        // Scoped to the id: the Machine row of the same session survives.
        expect(remaining.some((r) => r.sender === "Machine")).toBe(true);
      });

      await test.step("DELETE by id with an unknown id is a no-op 204", async () => {
        const countBefore = (await messages(request, `flow_id=${flowId}`)).length;
        const res = await request.delete("/api/v1/monitor/messages", {
          headers: authHeaders,
          data: ["00000000-0000-4000-8000-000000000000"],
        });
        expect(res.status()).toBe(204);
        expect(await messages(request, `flow_id=${flowId}`)).toHaveLength(countBefore);
      });

      await test.step("DELETE session/{id} removes that session and leaves the other", async () => {
        const res = await request.delete(
          `/api/v1/monitor/messages/session/${sessionD}`,
          { headers: authHeaders },
        );
        expect(res.status()).toBe(204);
        const list = await request.get(
          `/api/v1/monitor/messages/sessions?flow_id=${flowId}`,
          { headers: authHeaders },
        );
        const sessions = (await list.json()) as string[];
        expect(sessions).not.toContain(sessionD);
        expect(sessions).toContain(sessionE);
      });

      await test.step("DELETE sessions with a list reports the count and empties them", async () => {
        const res = await request.delete("/api/v1/monitor/messages/sessions", {
          headers: authHeaders,
          data: [sessionE],
        });
        expect(res.status()).toBe(200);
        expect(await res.json()).toEqual({
          message: "Messages deleted successfully for 1 session",
          deleted_count: 1,
        });
        const list = await request.get(
          `/api/v1/monitor/messages/sessions?flow_id=${flowId}`,
          { headers: authHeaders },
        );
        expect((await list.json()) as string[]).not.toContain(sessionE);
      });

      await test.step("DELETE session/{unknown} is a 204", async () => {
        const res = await request.delete(
          `/api/v1/monitor/messages/session/${uniqueSession("nope")}`,
          { headers: authHeaders },
        );
        expect(res.status()).toBe(204);
      });
    },
  );

  test(
    "builds, transactions and the job queue",
    { tag: ["@stable", "@api", "@observability"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        "GET /api/v1/monitor/transactions",
        "GET /api/v1/monitor/builds",
        "DELETE /api/v1/monitor/builds",
        "GET /api/v1/monitor/job_queue",
      ]);
      const session = uniqueSession("builds");
      await run(request, session, "build-me");

      await test.step("transactions require flow_id and list one item per vertex build", async () => {
        const bare = await request.get("/api/v1/monitor/transactions", { headers: authHeaders });
        expect(bare.status()).toBe(422);
        expect((await bare.json()).detail[0].loc).toEqual(["query", "flow_id"]);

        await expect
          .poll(async () => {
            const res = await request.get(
              `/api/v1/monitor/transactions?flow_id=${flowId}`,
              { headers: authHeaders },
            );
            return res.status() === 200 ? (await res.json()).items.length : -1;
          }, { timeout: 20_000 })
          .toBeGreaterThanOrEqual(2);
        const res = await request.get(`/api/v1/monitor/transactions?flow_id=${flowId}`, {
          headers: authHeaders,
        });
        const body = await res.json();
        for (const key of ["items", "page", "pages", "size", "total"]) {
          expect(body).toHaveProperty(key);
        }
        for (const item of body.items) {
          expect(typeof item.vertex_id).toBe("string");
          expect(item.status).toBe("success");
          expect(item.outputs).toHaveProperty("message");
        }
      });

      await test.step("builds require flow_id and are keyed by vertex", async () => {
        const bare = await request.get("/api/v1/monitor/builds", { headers: authHeaders });
        expect(bare.status()).toBe(422);
        expect((await bare.json()).detail[0].loc).toEqual(["query", "flow_id"]);

        const res = await request.get(`/api/v1/monitor/builds?flow_id=${flowId}`, {
          headers: authHeaders,
        });
        expect(res.status()).toBe(200);
        const vertexIds = Object.keys((await res.json()).vertex_builds);
        expect(vertexIds.some((id) => id.startsWith("ChatInput-"))).toBe(true);
        expect(vertexIds.some((id) => id.startsWith("ChatOutput-"))).toBe(true);
      });

      await test.step("DELETE builds requires flow_id and empties the map for the flow", async () => {
        const bare = await request.delete("/api/v1/monitor/builds", { headers: authHeaders });
        expect(bare.status()).toBe(422);

        const res = await request.delete(`/api/v1/monitor/builds?flow_id=${flowId}`, {
          headers: authHeaders,
        });
        expect(res.status()).toBe(204);
        const after = await request.get(`/api/v1/monitor/builds?flow_id=${flowId}`, {
          headers: authHeaders,
        });
        expect(await after.json()).toEqual({ vertex_builds: {} });
      });

      await test.step("job_queue reports the backend and the active job count", async () => {
        const res = await request.get("/api/v1/monitor/job_queue", { headers: authHeaders });
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(typeof body.backend).toBe("string");
        expect(Number.isInteger(body.active_jobs)).toBe(true);
        expect(body.active_jobs).toBeGreaterThanOrEqual(0);
      });
    },
  );
});
