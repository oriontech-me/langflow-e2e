import { expect } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";
import { test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { requireA2aEnabled } from "../../../../helpers/a2a/require-a2a-enabled";
import { createRunnableChatFlowViaApi } from "../../../../helpers/flows/create-runnable-chat-flow-via-api";

// Spec doc: docs/core-functionality/a2a/a2a-server-discovery.md
//
// GET /api/v1/a2a/agents is the catalog an orchestrator (or the A2AAgent component
// in Internal mode) reads to find reachable local agents. Its contract is a FILTER:
// agent-typed AND a2a_enabled, ANDed. A missing row makes a published agent
// invisible; an extra row points a caller at a card that 404s.

const AGENTS_PATH = "/api/v1/a2a/agents";

async function patchFlow(
  request: APIRequestContext,
  headers: Record<string, string>,
  flowId: string,
  data: Record<string, unknown>,
) {
  const res = await request.patch(`/api/v1/flows/${flowId}`, { headers, data });
  expect(res.status(), `PATCH /api/v1/flows/${flowId} — ${await res.text()}`).toBe(200);
}

async function listedIds(request: APIRequestContext, headers: Record<string, string>) {
  const res = await request.get(AGENTS_PATH, { headers });
  expect(res.status()).toBe(200);
  const rows = await res.json();
  expect(Array.isArray(rows)).toBe(true);
  return { rows: rows as Array<Record<string, string>>, ids: new Set(rows.map((r: any) => r.id)) };
}

test.describe("A2A Server — agent discovery @api @a2a", () => {
  test("discovery lists only agent-typed, A2A-enabled flows @api @a2a", async ({ request }) => {
    const headers = { Authorization: await getAuthToken(request) };
    await requireA2aEnabled(request, headers);

    // The three flows coexist deliberately: asserting only "A is present" would pass
    // against an endpoint that lists everything, and only "B is absent" would pass
    // against one that lists nothing.
    const published = await createRunnableChatFlowViaApi(request, headers);
    const workflowTyped = await createRunnableChatFlowViaApi(request, headers);
    const disabled = await createRunnableChatFlowViaApi(request, headers);

    try {
      await test.step("set up the three publication states", async () => {
        await patchFlow(request, headers, published.flowId, {
          flow_type: "agent",
          a2a_enabled: true,
        });
        await patchFlow(request, headers, workflowTyped.flowId, {
          flow_type: "workflow",
          a2a_enabled: true,
        });
        await patchFlow(request, headers, disabled.flowId, {
          flow_type: "agent",
          a2a_enabled: false,
        });
      });

      const { rows, ids } = await listedIds(request, headers);

      await test.step("only the published agent is enumerated", async () => {
        // Set membership, never list length: the superuser is shared and a parallel
        // spec may hold its own published agent.
        expect(ids.has(published.flowId)).toBe(true);
        expect(ids.has(workflowTyped.flowId)).toBe(false);
        expect(ids.has(disabled.flowId)).toBe(false);
      });

      await test.step("the row carries a cardUrl that actually resolves", async () => {
        const row = rows.find((r) => r.id === published.flowId)!;
        expect(Object.keys(row).sort()).toEqual(["cardUrl", "description", "id", "name"]);
        expect(new URL(row.cardUrl).pathname).toBe(
          `/api/v1/a2a/${published.flowId}/.well-known/agent-card.json`,
        );
        // Fetched VERBATIM from the response — this is what proves the catalog hands
        // out a working address rather than a plausible string.
        const card = await request.get(row.cardUrl, { headers });
        expect(card.status()).toBe(200);
        expect((await card.json()).skills[0].id).toBe(published.flowId);
      });
    } finally {
      await published.deleteFlow();
      await workflowTyped.deleteFlow();
      await disabled.deleteFlow();
    }
  });

  test("unpublishing removes the flow from discovery @api @a2a", async ({ request }) => {
    const headers = { Authorization: await getAuthToken(request) };
    await requireA2aEnabled(request, headers);

    const flow = await createRunnableChatFlowViaApi(request, headers);
    const cardPath = `/api/v1/a2a/${flow.flowId}/.well-known/agent-card.json`;

    try {
      await patchFlow(request, headers, flow.flowId, { flow_type: "agent", a2a_enabled: true });
      const before = await listedIds(request, headers);
      expect(before.ids.has(flow.flowId)).toBe(true);

      await patchFlow(request, headers, flow.flowId, { a2a_enabled: false });

      await test.step("the catalog and the card agree on the new state", async () => {
        const after = await listedIds(request, headers);
        expect(after.ids.has(flow.flowId)).toBe(false);
        // Tying both to the same state matters: a catalog that dropped the row while
        // the card kept serving is the worse half-failure of the two.
        expect((await request.get(cardPath, { headers })).status()).toBe(404);
      });
    } finally {
      await flow.deleteFlow();
    }
  });
});
