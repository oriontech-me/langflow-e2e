import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";

// The `messages/shared/*` sub-family of the monitor router — five operations over the
// namespace a user's conversations with a PUBLIC flow land in when the flow is run
// through the public path (build_public_tmp). Spec doc:
// docs/api/monitor/api-monitor-shared.md
//
// PREMISE, measured on 1.13.0.dev0: under LANGFLOW_AUTO_LOGIN=true — every OSS lane —
// the public build always uses the client_id-cookie principal
// (`authenticated_user_id = user.id if user and not AUTO_LOGIN else None`), so the
// USER-principal namespace these endpoints read is never written on an OSS instance.
// No test here can observe a shared row. What is assertable, and asserted, is the
// closed contract: the required `source_flow_id`, the empty read, the refusals. The
// positive path is a follow-up that needs an auto-login-off instance.
test.describe("Monitor API — shared messages", () => {
  const UNKNOWN_ID = "00000000-0000-4000-8000-000000000000";
  const createdFlowIds: string[] = [];

  test.afterEach(async ({ request }) => {
    const authToken = await getAuthToken(request);
    for (const id of createdFlowIds) {
      await deleteFlow(request, id, { headers: { Authorization: authToken } }).catch(
        (error) => console.warn(`⚠️ Orphan flow left behind (${id}): ${error}`),
      );
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
        name: `api-monitor-shared ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        description: "shared",
        data: { nodes: [], edges: [] },
      },
    });
    expect(res.status()).toBe(201);
    const id = (await res.json()).id as string;
    createdFlowIds.push(id);
    return id;
  }

  const missingSourceFlow = async (res: { status(): number; json(): Promise<unknown> }) => {
    expect(res.status()).toBe(422);
    const detail = ((await res.json()) as { detail: Array<{ loc: string[]; type: string }> }).detail[0];
    expect(detail.loc).toEqual(["query", "source_flow_id"]);
    expect(detail.type).toBe("missing");
  };

  test(
    "every shared endpoint requires source_flow_id and reads an empty namespace",
    { tag: ["@stable", "@api", "@observability"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        "GET /api/v1/monitor/messages/shared",
        "GET /api/v1/monitor/messages/shared/sessions",
      ]);
      const authToken = await getAuthToken(request);
      const headers = { Authorization: authToken };
      const flowId = await createFlow(request, authToken);

      await test.step("without source_flow_id both reads are refused on the parameter", async () => {
        await missingSourceFlow(
          await request.get("/api/v1/monitor/messages/shared", { headers }),
        );
        await missingSourceFlow(
          await request.get("/api/v1/monitor/messages/shared/sessions", { headers }),
        );
      });

      await test.step("a non-UUID source_flow_id is refused as such", async () => {
        const res = await request.get(
          "/api/v1/monitor/messages/shared?source_flow_id=not-a-uuid",
          { headers },
        );
        expect(res.status()).toBe(422);
        expect((await res.json()).detail[0].type).toBe("uuid_parsing");
      });

      await test.step("the user's namespace for an owned flow, and for an unknown one, is empty", async () => {
        for (const source of [flowId, UNKNOWN_ID]) {
          const rows = await request.get(
            `/api/v1/monitor/messages/shared?source_flow_id=${source}`,
            { headers },
          );
          expect(rows.status()).toBe(200);
          expect(await rows.json()).toEqual([]);
        }
        const sessions = await request.get(
          `/api/v1/monitor/messages/shared/sessions?source_flow_id=${flowId}`,
          { headers },
        );
        expect(sessions.status()).toBe(200);
        expect(await sessions.json()).toEqual([]);
      });
    },
  );

  test(
    "the shared write surface refuses what is not there, and never without the parameter",
    { tag: ["@stable", "@api", "@observability"] },
    async ({ request, apiCoverage }) => {
      apiCoverage.declare([
        "PUT /api/v1/monitor/messages/shared/{message_id}",
        "PATCH /api/v1/monitor/messages/shared/session/{old_session_id}",
        "DELETE /api/v1/monitor/messages/shared/session/{session_id}",
      ]);
      const authToken = await getAuthToken(request);
      const headers = { Authorization: authToken };
      const flowId = await createFlow(request, authToken);
      const session = `shared-nope-${Date.now()}`;

      await test.step("PUT shared/{message_id}", async () => {
        const res = await request.put(
          `/api/v1/monitor/messages/shared/${UNKNOWN_ID}?source_flow_id=${flowId}`,
          { headers, data: { text: "x" } },
        );
        expect(res.status()).toBe(404);
        expect((await res.json()).detail).toBe("Message not found");
        await missingSourceFlow(
          await request.put(`/api/v1/monitor/messages/shared/${UNKNOWN_ID}`, {
            headers,
            data: { text: "x" },
          }),
        );
      });

      await test.step("PATCH shared/session/{old_session_id}", async () => {
        const res = await request.patch(
          `/api/v1/monitor/messages/shared/session/${session}?new_session_id=y&source_flow_id=${flowId}`,
          { headers },
        );
        expect(res.status()).toBe(404);
        expect((await res.json()).detail).toBe("No messages found with the given session ID");
        await missingSourceFlow(
          await request.patch(
            `/api/v1/monitor/messages/shared/session/${session}?new_session_id=y`,
            { headers },
          ),
        );
      });

      await test.step("DELETE shared/session/{session_id}", async () => {
        const res = await request.delete(
          `/api/v1/monitor/messages/shared/session/${session}?source_flow_id=${flowId}`,
          { headers },
        );
        // Idempotent, like its non-shared twin: an absent session is already gone.
        expect(res.status()).toBe(204);
        await missingSourceFlow(
          await request.delete(`/api/v1/monitor/messages/shared/session/${session}`, {
            headers,
          }),
        );
      });
    },
  );
});
