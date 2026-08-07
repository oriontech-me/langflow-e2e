import { randomUUID } from "crypto";
import { expect } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";
import { test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { createApiKey, deleteApiKey } from "../../../../helpers/auth/create-api-key";
import { requireA2aEnabled } from "../../../../helpers/a2a/require-a2a-enabled";
import {
  postA2AJsonRpc,
  messageSendEnvelope,
} from "../../../../helpers/a2a/post-a2a-jsonrpc";
import { createRunnableChatFlowViaApi } from "../../../../helpers/flows/create-runnable-chat-flow-via-api";
import { createProjectViaApi } from "../../../../helpers/flows/create-project-via-api";

// Spec doc: docs/core-functionality/a2a/a2a-server-auth-apikey.md
//
// POST /api/v1/a2a/{flow_id}/jsonrpc RUNS A FLOW AS ITS OWNER for a caller that
// carries no session — which is the whole reason a gate exists on it. Authorization
// derives from the flow's PROJECT (`folder_auth_type`), and the same value feeds
// both halves of the contract: what the card advertises (`resolve_card_security`)
// and what the route enforces (`_enforce_a2a_auth`). Both are asserted here, because
// a card advertising a scheme nobody enforces tells a caller it is protected when it
// is not.
//
// The causal control is a MOVE, not a comparison: the same flow — same id, same
// graph, same publication — is asserted before and after it changes project. Two
// separate flows would leave "the gate comes from the project" an assumption; one
// flow crossing the boundary rules out the flow, the graph, the server flag and the
// environment as the cause of the 401.

const CARD_PATH = (flowId: string) =>
  `/api/v1/a2a/${flowId}/.well-known/agent-card.json`;

// Syntactically plausible and certainly unknown. The point is to reach the
// authenticate_api_key lookup and fail there, not to be rejected as malformed.
const UNKNOWN_API_KEY = "sk-e2e-definitely-not-a-real-key-000000000000";

function sentinel(): string {
  return `a2a-authgate-${randomUUID()}`;
}

async function patchFlow(
  request: APIRequestContext,
  headers: Record<string, string>,
  flowId: string,
  data: Record<string, unknown>,
) {
  const res = await request.patch(`/api/v1/flows/${flowId}`, { headers, data });
  expect(res.status(), `PATCH /api/v1/flows/${flowId} — ${await res.text()}`).toBe(200);
  return res.json();
}

async function sendText(
  request: APIRequestContext,
  flowId: string,
  text: string,
  headers: Record<string, string> = {},
) {
  return postA2AJsonRpc(
    request,
    flowId,
    messageSendEnvelope(text, { id: randomUUID(), messageId: randomUUID() }),
    headers,
  );
}

test.describe("A2A Server — API-key gate on the JSON-RPC endpoint", () => {
  test(
    "the api-key gate follows the project the flow lives in",
    { tag: ["@stable", "@api", "@regression", "@a2a"] },
    async ({ request }) => {
      const headers = { Authorization: await getAuthToken(request) };
      await requireA2aEnabled(request, headers);

      const flow = await createRunnableChatFlowViaApi(request, headers);
      let project: Awaited<ReturnType<typeof createProjectViaApi>> | undefined;
      let apiKey: Awaited<ReturnType<typeof createApiKey>> | undefined;

      try {
        await test.step("publish the flow as an agent, still in the default project", async () => {
          const patched = await patchFlow(request, headers, flow.flowId, {
            flow_type: "agent",
            a2a_enabled: true,
          });
          expect(patched.flow_type).toBe("agent");
          expect(patched.a2a_enabled).toBe(true);
        });

        // NEGATIVE CONTROL. Without it, a card that never advertises security and
        // an endpoint that always 401s would be indistinguishable from a gate that
        // works.
        await test.step("unrestricted: the card advertises no security", async () => {
          const res = await request.get(CARD_PATH(flow.flowId), { headers });
          expect(res.status()).toBe(200);
          const card = await res.json();
          expect(card.securitySchemes ?? null).toBeNull();
          expect(card.security ?? null).toBeNull();
        });

        await test.step("unrestricted: an unauthenticated run succeeds and echoes the sentinel", async () => {
          const text = sentinel();
          const { status, body, raw } = await sendText(request, flow.flowId, text);
          expect(status, `unauthenticated run — ${raw}`).toBe(200);
          expect(body?.error, `unexpected JSON-RPC error: ${raw}`).toBeUndefined();
          expect(body?.result?.status?.state).toBe("completed");
          // The passthrough echoes Chat Input verbatim, so the sentinel is causal
          // evidence the graph RAN — not that a task object came back.
          expect(raw).toContain(text);
        });

        await test.step("move the flow into a project whose auth_type is apikey", async () => {
          project = await createProjectViaApi(request, headers, {
            namePrefix: "a2a-authgate",
            description: "Restricted project for the A2A api-key gate spec",
            authSettings: { auth_type: "apikey" },
          });

          // Asserted rather than assumed: every step below is meaningless if the
          // move silently no-ops, and failing here names the real cause instead of
          // surfacing as three unexplained 200s.
          const moved = await patchFlow(request, headers, flow.flowId, {
            folder_id: project.projectId,
          });
          expect(moved.folder_id).toBe(project.projectId);
        });

        await test.step("restricted: the card now advertises the x-api-key scheme", async () => {
          const res = await request.get(CARD_PATH(flow.flowId), { headers });
          expect(res.status()).toBe(200);
          const card = await res.json();

          expect(card.securitySchemes?.apiKey).toMatchObject({
            type: "apiKey",
            in: "header",
            name: "x-api-key",
          });
          // The `security` list is what a spec-compliant client reads to know the
          // scheme is required rather than merely offered.
          expect(card.security).toContainEqual({ apiKey: [] });
        });

        await test.step("restricted: no header is rejected with 401 API key required", async () => {
          const { status, raw } = await sendText(request, flow.flowId, sentinel());
          expect(status, `no-header call — ${raw}`).toBe(401);
          expect(JSON.parse(raw).detail).toBe("API key required");
        });

        await test.step("restricted: an unknown key is rejected with 401 Invalid API key", async () => {
          const { status, raw } = await sendText(request, flow.flowId, sentinel(), {
            "x-api-key": UNKNOWN_API_KEY,
          });
          expect(status, `unknown-key call — ${raw}`).toBe(401);
          // Note: a VALID key belonging to another user returns this same message
          // by design ("don't reveal a key is valid for another user"), so this
          // asserts the unknown-key case only and claims no distinction.
          expect(JSON.parse(raw).detail).toBe("Invalid API key");
        });

        // POSITIVE CONTROL, and not optional: a gate that rejected everything —
        // including the owner — would satisfy both 401 steps above while leaving the
        // feature unusable.
        await test.step("restricted: the owner's key runs the flow and echoes the sentinel", async () => {
          apiKey = await createApiKey(request, headers, { namePrefix: "a2a-authgate" });
          const text = sentinel();

          const { status, body, raw } = await sendText(request, flow.flowId, text, {
            "x-api-key": apiKey.key,
          });
          expect(status, `owner-key call — ${raw}`).toBe(200);
          expect(body?.error, `unexpected JSON-RPC error: ${raw}`).toBeUndefined();
          expect(body?.result?.status?.state).toBe("completed");
          // Asserting the sentinel and not just the state is what proves the
          // authenticated call ran the graph instead of returning an empty task.
          expect(raw).toContain(text);
        });
      } finally {
        // Each guarded so one failure cannot skip the rest — the project and the key
        // outlive the flow and would otherwise accumulate on the shared superuser.
        if (apiKey) {
          await deleteApiKey(request, apiKey.id, headers).catch((e) =>
            console.warn(`⚠️ API key cleanup failed: ${e}`),
          );
        }
        await flow
          .deleteFlow()
          .catch((e) => console.warn(`⚠️ flow cleanup failed: ${e}`));
        if (project) {
          // Must run AFTER the flow is deleted: a project holding flows is a
          // different delete path, and deleteProject already retries the #965 500.
          await project
            .deleteProject()
            .catch((e) => console.warn(`⚠️ project cleanup failed: ${e}`));
        }
      }
    },
  );
});
