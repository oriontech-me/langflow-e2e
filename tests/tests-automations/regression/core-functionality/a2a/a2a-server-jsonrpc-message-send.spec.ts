import { randomUUID } from "crypto";
import { expect } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";
import { test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { requireA2aEnabled } from "../../../../helpers/a2a/require-a2a-enabled";
import {
  postA2AJsonRpc,
  messageSendEnvelope,
} from "../../../../helpers/a2a/post-a2a-jsonrpc";
import { createRunnableChatFlowViaApi } from "../../../../helpers/flows/create-runnable-chat-flow-via-api";

// Spec doc: docs/core-functionality/a2a/a2a-server-jsonrpc-message-send.md
//
// POST /api/v1/a2a/{flow_id}/jsonrpc is the only way a remote agent actually RUNS a
// published flow. Two halves are asserted: the round-trip really executes the graph
// (a per-run sentinel comes back through a Chat Input -> Chat Output passthrough, so
// the assertion is causal and needs no LLM), and protocol errors arrive as JSON-RPC
// errors over HTTP 200 — the half a client that trusts HTTP status silently
// mis-handles.

async function publishAgent(
  request: APIRequestContext,
  headers: Record<string, string>,
  flowId: string,
) {
  const res = await request.patch(`/api/v1/flows/${flowId}`, {
    headers,
    data: { flow_type: "agent", a2a_enabled: true },
  });
  expect(res.status(), `PATCH /api/v1/flows/${flowId} — ${await res.text()}`).toBe(200);
}

function sentinel(): string {
  return `a2a-e2e-${randomUUID()}`;
}

async function sendText(
  request: APIRequestContext,
  headers: Record<string, string>,
  flowId: string,
  text: string,
) {
  return postA2AJsonRpc(
    request,
    flowId,
    messageSendEnvelope(text, { id: randomUUID(), messageId: randomUUID() }),
    headers,
  );
}

test.describe("A2A Server — JSON-RPC message/send", () => {
  test("message/send runs the flow and echoes the sentinel back", { tag: ["@stable", "@release", "@api", "@a2a"] }, async ({
    request,
  }) => {
    const headers = { Authorization: await getAuthToken(request) };
    await requireA2aEnabled(request, headers);

    const flow = await createRunnableChatFlowViaApi(request, headers);
    try {
      await publishAgent(request, headers, flow.flowId);
      const text = sentinel();

      const { status, body, raw } = await sendText(request, headers, flow.flowId, text);

      await test.step("the task completes and carries the sentinel back", async () => {
        expect(status).toBe(200);
        expect(body?.error, `unexpected JSON-RPC error: ${raw}`).toBeUndefined();
        expect(body?.result?.status?.state).toBe("completed");
        expect(typeof body?.result?.id).toBe("string");
        expect(body?.result?.id?.length).toBeGreaterThan(0);
        // The passthrough echoes Chat Input verbatim, so the sentinel's presence is
        // causal evidence the graph ran — not a "something came back" smoke check.
        expect(raw).toContain(text);
      });
    } finally {
      await flow.deleteFlow();
    }
  });

  test("each call produces its own task", { tag: ["@stable", "@api", "@a2a"] }, async ({ request }) => {
    const headers = { Authorization: await getAuthToken(request) };
    await requireA2aEnabled(request, headers);

    const flow = await createRunnableChatFlowViaApi(request, headers);
    try {
      await publishAgent(request, headers, flow.flowId);
      const first = sentinel();
      const second = sentinel();

      const one = await sendText(request, headers, flow.flowId, first);
      const two = await sendText(request, headers, flow.flowId, second);

      expect(one.status).toBe(200);
      expect(two.status).toBe(200);
      expect(one.body?.result?.status?.state).toBe("completed");
      expect(two.body?.result?.status?.state).toBe("completed");

      await test.step("each result carries only its own sentinel", async () => {
        expect(one.raw).toContain(first);
        expect(one.raw).not.toContain(second);
        expect(two.raw).toContain(second);
        expect(two.raw).not.toContain(first);
      });

      await test.step("the two tasks are distinct", async () => {
        expect(one.body?.result?.id).not.toBe(two.body?.result?.id);
      });
    } finally {
      await flow.deleteFlow();
    }
  });

  test("protocol errors come back as JSON-RPC errors over HTTP 200", { tag: ["@stable", "@api", "@a2a"] }, async ({
    request,
  }) => {
    const headers = { Authorization: await getAuthToken(request) };
    await requireA2aEnabled(request, headers);

    const flow = await createRunnableChatFlowViaApi(request, headers);
    try {
      await publishAgent(request, headers, flow.flowId);

      // Assertions are on error.code ONLY. The message/data strings are
      // implementation text: -32700 returns the raw Python parser message and -32600
      // sometimes embeds a full Pydantic validation dump, so matching them would
      // break on any upstream dependency bump while the contract held.
      const cases: Array<{ label: string; body: Record<string, unknown> | string; code: number }> = [
        {
          label: "unknown method",
          body: { jsonrpc: "2.0", id: randomUUID(), method: "does/notExist", params: {} },
          code: -32601,
        },
        {
          label: "envelope missing method",
          body: { jsonrpc: "2.0", id: randomUUID(), params: {} },
          code: -32600,
        },
        {
          label: "envelope missing jsonrpc",
          body: { id: randomUUID(), method: "message/send", params: {} },
          code: -32600,
        },
        {
          label: "wrong jsonrpc version",
          body: { jsonrpc: "1.0", id: randomUUID(), method: "message/send", params: {} },
          code: -32600,
        },
        {
          label: "message/send with no params",
          body: { jsonrpc: "2.0", id: randomUUID(), method: "message/send" },
          code: -32600,
        },
        // Raw string body: the serializer must not get a chance to fix it, or the
        // parse error never happens.
        { label: "body that is not valid JSON", body: "{not json at all", code: -32700 },
      ];

      for (const { label, body, code } of cases) {
        await test.step(`${label} → ${code} over HTTP 200`, async () => {
          const res = await postA2AJsonRpc(request, flow.flowId, body, headers);
          expect(res.status, `${label}: expected HTTP 200, got ${res.status} — ${res.raw}`).toBe(200);
          expect(res.body?.error?.code, `${label}: ${res.raw}`).toBe(code);
        });
      }

      // Positive control in the SAME test: an endpoint that answered -32600 to
      // everything would otherwise satisfy all six rows above.
      await test.step("a valid request still returns a result", async () => {
        const ok = await sendText(request, headers, flow.flowId, sentinel());
        expect(ok.status).toBe(200);
        expect(ok.body?.error).toBeUndefined();
        expect(ok.body?.result?.status?.state).toBe("completed");
      });
    } finally {
      await flow.deleteFlow();
    }
  });
});
