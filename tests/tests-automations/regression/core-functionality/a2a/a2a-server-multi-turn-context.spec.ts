import { expect } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";
import { test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { requireA2aEnabled } from "../../../../helpers/a2a/require-a2a-enabled";
import {
  messageSendEnvelope,
  postA2AJsonRpc,
} from "../../../../helpers/a2a/post-a2a-jsonrpc";
import { createRunnableChatFlowViaApi } from "../../../../helpers/flows/create-runnable-chat-flow-via-api";

// Spec doc: docs/core-functionality/a2a/a2a-server-multi-turn-context.md
//
// A2A is a conversation protocol. #1242 proved a single message/send round-trips;
// the second turn is where the feature either exists or does not. The three turns
// below are asserted as RELATIONS (same context, new task; different context), which
// is why they share one test rather than three.
//
// The stored side is checked in GET /api/v1/monitor/messages, not only in the
// response envelope: an echoed contextId that never reached storage would satisfy a
// response-only check while leaving every turn in its own thread.

interface MonitorMessage {
  session_id: string;
  sender: string;
  text: string;
}

async function sessionsFor(
  request: APIRequestContext,
  headers: Record<string, string>,
  flowId: string,
) {
  const res = await request.get(`/api/v1/monitor/messages?flow_id=${flowId}`, { headers });
  expect(res.status(), await res.text()).toBe(200);
  const rows = (await res.json()) as MonitorMessage[];

  const bySession = new Map<string, MonitorMessage[]>();
  for (const row of rows) {
    bySession.set(row.session_id, [...(bySession.get(row.session_id) ?? []), row]);
  }
  return bySession;
}

const sessionEndingIn = (sessions: Map<string, MonitorMessage[]>, contextId: string) => {
  // session_id is the COMPOSITE `<flow-scoped uuid>:<contextId>` — equality against
  // the bare contextId would fail against a healthy server.
  const hit = [...sessions.entries()].find(([id]) => id.endsWith(`:${contextId}`));
  expect(hit, `no stored session ends with :${contextId} — saw ${[...sessions.keys()].join(", ")}`)
    .toBeDefined();
  return hit![1];
};

test.describe("A2A Server — multi-turn context @api @a2a", () => {
  test("a conversation keeps its thread only while the caller quotes the contextId @api @a2a", async ({
    request,
  }) => {
    const headers = { Authorization: await getAuthToken(request) };
    await requireA2aEnabled(request, headers);

    const flow = await createRunnableChatFlowViaApi(request, headers);
    const run = Date.now();
    const sentinelA = `a2a-ctx-turn1-${run}`;
    const sentinelB = `a2a-ctx-turn2-${run}`;
    const sentinelC = `a2a-ctx-turn3-${run}`;

    try {
      const patch = await request.patch(`/api/v1/flows/${flow.flowId}`, {
        headers,
        data: { flow_type: "agent", a2a_enabled: true },
      });
      expect(patch.status(), await patch.text()).toBe(200);

      const send = async (text: string, contextId?: string) => {
        const res = await postA2AJsonRpc(
          request,
          flow.flowId,
          messageSendEnvelope(text, {
            id: `rpc-${text}`,
            messageId: `msg-${text}`,
            ...(contextId ? { contextId } : {}),
          }),
          headers,
        );
        expect(res.status, res.raw.slice(0, 400)).toBe(200);
        expect(res.body?.error, res.raw.slice(0, 400)).toBeUndefined();
        return res.body!.result as { id: string; contextId: string; status: { state: string } };
      };

      let turn1: Awaited<ReturnType<typeof send>>;
      let turn2: Awaited<ReturnType<typeof send>>;
      let turn3: Awaited<ReturnType<typeof send>>;

      await test.step("turn 1 — the server mints a contextId", async () => {
        turn1 = await send(sentinelA);
        expect(turn1.status.state).toBe("completed");
        // A client cannot invent one: with no contextId in the response there is no
        // way to continue a conversation at all.
        expect(turn1.contextId).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
        );
      });

      await test.step("turn 2 — quoting it stays in the same thread", async () => {
        turn2 = await send(sentinelB, turn1.contextId);
        expect(turn2.contextId).toBe(turn1.contextId);
        // Same thread, NEW task — a server that returned the same task id would be
        // replaying turn 1 rather than continuing the conversation.
        expect(turn2.id).not.toBe(turn1.id);
      });

      await test.step("turn 3 — omitting it starts a new thread", async () => {
        // The negative control. Without it, a server that funnels every call into one
        // global session passes both steps above and silently leaks one caller's turn
        // into another's context.
        turn3 = await send(sentinelC);
        expect(turn3.contextId).not.toBe(turn1.contextId);
      });

      await test.step("the stored conversation matches the ids the server handed out", async () => {
        const sessions = await sessionsFor(request, headers, flow.flowId);
        expect(sessions.size).toBe(2);

        const thread = sessionEndingIn(sessions, turn1.contextId);
        const alone = sessionEndingIn(sessions, turn3.contextId);

        // Each turn stores a User row and a Machine row; the passthrough echoes, so
        // both carry the sentinel verbatim.
        const shape = (rows: MonitorMessage[]) =>
          rows.map((r) => `${r.sender}:${r.text}`).sort();

        expect(shape(thread)).toEqual(
          [
            `Machine:${sentinelA}`,
            `Machine:${sentinelB}`,
            `User:${sentinelA}`,
            `User:${sentinelB}`,
          ].sort(),
        );
        expect(shape(alone)).toEqual([`Machine:${sentinelC}`, `User:${sentinelC}`].sort());
      });
    } finally {
      await flow.deleteFlow();
    }
  });
});
