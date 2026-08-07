import { expect } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";
import { test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { requireA2aEnabled } from "../../../../helpers/a2a/require-a2a-enabled";
import { createRunnableChatFlowViaApi } from "../../../../helpers/flows/create-runnable-chat-flow-via-api";

// Spec doc: docs/core-functionality/a2a/a2a-server-agent-card.md
//
// The agent card is A2A's whole discovery contract: the one document a remote
// orchestrator fetches to decide whether it can talk to a Langflow flow, and how.
// It is served unauthenticated by spec, and its 404 is deliberately
// indistinguishable from an unmounted route — which is exactly why publication
// gating has to be asserted rather than assumed.

const A2A_PROTOCOL_VERSION = "0.3.0";
const APPLICATION_JSON = ["application/json"];

function cardPath(flowId: string): string {
  return `/api/v1/a2a/${flowId}/.well-known/agent-card.json`;
}

async function publish(
  request: APIRequestContext,
  headers: Record<string, string>,
  flowId: string,
  patch: Record<string, unknown>,
) {
  const res = await request.patch(`/api/v1/flows/${flowId}`, { headers, data: patch });
  expect(res.status(), `PATCH /api/v1/flows/${flowId} — ${await res.text()}`).toBe(200);
  return res.json();
}

test.describe("A2A Server — agent card", () => {
  test("published agent flow serves a spec-valid card", { tag: ["@stable", "@release", "@api", "@a2a"] }, async ({ request }) => {
    const headers = { Authorization: await getAuthToken(request) };
    await requireA2aEnabled(request, headers);

    const flow = await createRunnableChatFlowViaApi(request, headers);
    try {
      await test.step("publish the flow as an A2A agent", async () => {
        const patched = await publish(request, headers, flow.flowId, {
          flow_type: "agent",
          a2a_enabled: true,
        });
        expect(patched.flow_type).toBe("agent");
        expect(patched.a2a_enabled).toBe(true);
      });

      await test.step("the card is served with every field a caller depends on", async () => {
        const res = await request.get(cardPath(flow.flowId), { headers });
        expect(res.status()).toBe(200);
        const card = await res.json();

        expect(card.protocolVersion).toBe(A2A_PROTOCOL_VERSION);
        expect(card.capabilities).toMatchObject({ streaming: true, pushNotifications: true });
        expect(card.defaultInputModes).toEqual(APPLICATION_JSON);
        expect(card.defaultOutputModes).toEqual(APPLICATION_JSON);

        // The advertised endpoint is compared as a PATH: the base URL differs
        // between a local run and CI (container hostname), so a string match on the
        // whole URL would be environment-dependent rather than contractual.
        expect(new URL(card.url).pathname).toBe(`/api/v1/a2a/${flow.flowId}/jsonrpc`);

        expect(card.skills).toHaveLength(1);
        expect(card.skills[0].id).toBe(flow.flowId);
        expect(card.skills[0].tags).toEqual(["langflow"]);
        // The input contract is asserted as a SHAPE, not as an exact schema: a flow
        // whose graph cannot be built degrades to an empty contract instead of
        // 500ing, so the keys are the stable part.
        expect(card.skills[0].inputSchema).toEqual(
          expect.objectContaining({ type: expect.anything(), properties: expect.anything() }),
        );
      });
    } finally {
      await flow.deleteFlow();
    }
  });

  test("card overrides change exactly what the card advertises", { tag: ["@stable", "@api", "@a2a"] }, async ({ request }) => {
    const headers = { Authorization: await getAuthToken(request) };
    await requireA2aEnabled(request, headers);

    const overrides = {
      name: `Overridden Agent ${Date.now()}`,
      version: "9.9.9-e2e",
      description: "Overridden description for the A2A card",
      tags: ["alpha", "beta"],
      examples: ["How do I get a refund?", "Where is my order?"],
    };

    const flow = await createRunnableChatFlowViaApi(request, headers);
    try {
      await publish(request, headers, flow.flowId, {
        flow_type: "agent",
        a2a_enabled: true,
        a2a_card_overrides: overrides,
      });

      const res = await request.get(cardPath(flow.flowId), { headers });
      expect(res.status()).toBe(200);
      const card = await res.json();

      await test.step("every overridable field is advertised as sent", async () => {
        expect(card.name).toBe(overrides.name);
        expect(card.version).toBe(overrides.version);
        expect(card.description).toBe(overrides.description);
        expect(card.skills[0].tags).toEqual(overrides.tags);
        expect(card.skills[0].examples).toEqual(overrides.examples);
        // The name override lands in TWO places; asserting only card.name would
        // miss half the change.
        expect(card.skills[0].name).toBe(overrides.name);
      });

      await test.step("the override edits the advertisement, not the endpoint", async () => {
        expect(card.protocolVersion).toBe(A2A_PROTOCOL_VERSION);
        expect(new URL(card.url).pathname).toBe(`/api/v1/a2a/${flow.flowId}/jsonrpc`);
        expect(card.skills[0].id).toBe(flow.flowId);
      });
    } finally {
      await flow.deleteFlow();
    }
  });

  test("card is 404 while the flow is not published", { tag: ["@stable", "@api", "@a2a"] }, async ({ request }) => {
    const headers = { Authorization: await getAuthToken(request) };
    await requireA2aEnabled(request, headers);

    const flow = await createRunnableChatFlowViaApi(request, headers);
    const status = async () => (await request.get(cardPath(flow.flowId), { headers })).status();

    try {
      // All four states in ONE test, so a blanket-404 bug cannot pass by asserting
      // only the negatives, and a card-leaks-everything bug cannot pass the positive.
      await test.step("a freshly created flow has no card", async () => {
        expect(await status()).toBe(404);
      });
      await test.step("publishing serves it (positive control)", async () => {
        await publish(request, headers, flow.flowId, { flow_type: "agent", a2a_enabled: true });
        expect(await status()).toBe(200);
      });
      await test.step("clearing a2a_enabled takes it away again", async () => {
        await publish(request, headers, flow.flowId, { a2a_enabled: false });
        expect(await status()).toBe(404);
      });
      await test.step("an agent-enabled flow typed as workflow is still not served", async () => {
        await publish(request, headers, flow.flowId, { flow_type: "workflow", a2a_enabled: true });
        expect(await status()).toBe(404);
      });
    } finally {
      await flow.deleteFlow();
    }
  });

  test("card is 404 for an unknown flow id", { tag: ["@stable", "@api", "@a2a"] }, async ({ request }) => {
    const headers = { Authorization: await getAuthToken(request) };
    await requireA2aEnabled(request, headers);

    // A syntactically valid UUID that owns no flow. The response must be the generic
    // Not Found: distinguishing "no such flow" from "not published" would turn this
    // public endpoint into a flow-existence oracle.
    const unknownId = "00000000-0000-4000-8000-000000000000";
    const res = await request.get(cardPath(unknownId), { headers });
    expect(res.status()).toBe(404);
    expect(await res.json()).toEqual({ detail: "Not Found" });
  });
});
