import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { createThrowawayUser, deleteThrowawayUser } from "../../../../helpers/auth/throwaway-user";
import type { ThrowawayUser } from "../../../../helpers/auth/throwaway-user";
import { requireA2aEnabled } from "../../../../helpers/a2a/require-a2a-enabled";
import { createRunnableChatFlowInPublicProject } from "../../../../helpers/a2a/create-public-runnable-flow";
import type { PublicRunnableChatFlow } from "../../../../helpers/a2a/create-public-runnable-flow";

// Spec doc: docs/core-functionality/a2a/a2a-server-non-owner-publish.md
//
// Publishing a flow as an A2A agent is a PATCH of flow_type + a2a_enabled, and only
// the owner may make it. The checklist assumed the refusal was the 403 "Cannot change
// a2a_enabled of a flow you do not own." in flows_helpers.py. On OSS that branch is
// unreachable: it guards a SHARED edit, and on OSS nobody but the owner can load the
// flow at all, so every other actor gets 404 "Flow not found". The superuser gets it
// too, which is why both directions are here. The 403 is Enterprise + RBAC only.
//
// What the spec guards is the effect on the agent: after a non-owner's attempt the
// flow is still unpublished. Each test ends with the owner's IDENTICAL PATCH
// succeeding, so the 404s cannot come from a malformed body.

const NOT_FOUND = { detail: "Flow not found" };
const PUBLISH = { flow_type: "agent", a2a_enabled: true };

interface PublicationFields {
  flow_type: unknown;
  a2a_enabled: unknown;
  a2a_card_overrides: unknown;
}

async function publicationFields(
  request: APIRequestContext,
  headers: Record<string, string>,
  flowId: string,
): Promise<PublicationFields> {
  const res = await request.get(`/api/v1/flows/${flowId}`, { headers });
  expect(res.status(), await res.text()).toBe(200);
  const flow = await res.json();
  return { flow_type: flow.flow_type, a2a_enabled: flow.a2a_enabled, a2a_card_overrides: flow.a2a_card_overrides };
}

async function expectFlowNotFound(res: Awaited<ReturnType<APIRequestContext["get"]>>, what: string) {
  const body = await res.text();
  expect(res.status(), `${what}: ${body}`).toBe(404);
  expect(JSON.parse(body), what).toEqual(NOT_FOUND);
}

/** The card's HTTP status, asked with no credentials, as an A2A client would. */
async function cardStatus(request: APIRequestContext, flowId: string): Promise<number> {
  return (await request.get(`/api/v1/a2a/${flowId}/.well-known/agent-card.json`)).status();
}

async function discoveredIds(request: APIRequestContext, headers: Record<string, string>): Promise<string[]> {
  const res = await request.get("/api/v1/a2a/agents", { headers });
  expect(res.status(), await res.text()).toBe(200);
  return ((await res.json()) as Array<{ id: string }>).map((agent) => agent.id);
}

/** Runs every step; the first failure is rethrown, so a leak is reported. */
async function runCleanups(cleanups: Array<() => Promise<void>>) {
  let firstError: unknown;
  for (const cleanup of [...cleanups].reverse()) {
    try {
      await cleanup();
    } catch (e) {
      firstError ??= e;
    }
  }
  if (firstError !== undefined) throw firstError;
}

test.describe("A2A Server — only the owner can publish a flow", () => {
  test("a regular user cannot read or publish the superuser's flow", { tag: ["@stable", "@api", "@a2a", "@auth"] }, async ({
    request,
    playwright,
  }) => {
    const superHeaders = { Authorization: await getAuthToken(request) };
    await requireA2aEnabled(request, superHeaders);
    const cleanups: Array<() => Promise<void>> = [];
    const sentinel = `a2a-non-owner-${Date.now()}`;

    try {
      const flow: PublicRunnableChatFlow = await createRunnableChatFlowInPublicProject(request, superHeaders, {
        namePrefix: "a2a-owner-su",
      });
      cleanups.push(() => flow.cleanup());
      const before = await publicationFields(request, superHeaders, flow.flowId);
      expect(before.a2a_enabled).toBe(false);

      const other: ThrowawayUser = await createThrowawayUser(request, {
        superHeaders,
        newContext: () => playwright.request.newContext({ baseURL: test.info().project.use.baseURL }),
        prefix: "a2aowner",
        // Registered as soon as the user exists, so a later failure still deletes it.
        track: (created) => cleanups.push(() => deleteThrowawayUser(request, superHeaders, created)),
      });

      await test.step("the regular user gets 404 on read, publish and card overrides", async () => {
        await expectFlowNotFound(await other.request.get(`/api/v1/flows/${flow.flowId}`, { headers: other.headers }), "GET");
        await expectFlowNotFound(
          await other.request.patch(`/api/v1/flows/${flow.flowId}`, { headers: other.headers, data: PUBLISH }),
          "PATCH publish",
        );
        await expectFlowNotFound(
          await other.request.patch(`/api/v1/flows/${flow.flowId}`, {
            headers: other.headers,
            data: { a2a_card_overrides: { name: sentinel } },
          }),
          "PATCH a2a_card_overrides",
        );
      });

      await test.step("the flow is unchanged and still unpublished", async () => {
        expect(await publicationFields(request, superHeaders, flow.flowId)).toEqual(before);
        expect(await cardStatus(request, flow.flowId)).toBe(404);
        expect(await discoveredIds(request, superHeaders)).not.toContain(flow.flowId);
      });

      await test.step("the owner's identical PATCH publishes it", async () => {
        const res = await request.patch(`/api/v1/flows/${flow.flowId}`, { headers: superHeaders, data: PUBLISH });
        expect(res.status(), await res.text()).toBe(200);
        expect(await cardStatus(request, flow.flowId)).toBe(200);
      });

      await test.step("the regular user's discovery does not list it", async () => {
        expect(await discoveredIds(other.request, other.headers)).not.toContain(flow.flowId);
      });
    } finally {
      await runCleanups(cleanups);
    }
  });

  test("the superuser cannot publish a regular user's flow", { tag: ["@stable", "@api", "@a2a", "@auth"] }, async ({
    request,
    playwright,
  }) => {
    const superHeaders = { Authorization: await getAuthToken(request) };
    await requireA2aEnabled(request, superHeaders);
    const cleanups: Array<() => Promise<void>> = [];

    try {
      const owner: ThrowawayUser = await createThrowawayUser(request, {
        superHeaders,
        newContext: () => playwright.request.newContext({ baseURL: test.info().project.use.baseURL }),
        prefix: "a2aowner",
        // Registered as soon as the user exists, so a later failure still deletes it.
        track: (created) => cleanups.push(() => deleteThrowawayUser(request, superHeaders, created)),
      });
      // Created and deleted through the user's own context: the superuser cannot reach it.
      const flow = await createRunnableChatFlowInPublicProject(owner.request, owner.headers, {
        namePrefix: "a2a-owner-user",
      });
      cleanups.push(() => flow.cleanup(owner.request));
      const before = await publicationFields(owner.request, owner.headers, flow.flowId);
      expect(before.a2a_enabled).toBe(false);

      await test.step("the superuser gets 404 on read and on publish", async () => {
        await expectFlowNotFound(await request.get(`/api/v1/flows/${flow.flowId}`, { headers: superHeaders }), "GET");
        await expectFlowNotFound(
          await request.patch(`/api/v1/flows/${flow.flowId}`, { headers: superHeaders, data: PUBLISH }),
          "PATCH publish",
        );
      });

      await test.step("the flow is unchanged and still unpublished", async () => {
        expect(await publicationFields(owner.request, owner.headers, flow.flowId)).toEqual(before);
        expect(await cardStatus(request, flow.flowId)).toBe(404);
      });

      await test.step("the owner's identical PATCH publishes it", async () => {
        const res = await owner.request.patch(`/api/v1/flows/${flow.flowId}`, { headers: owner.headers, data: PUBLISH });
        expect(res.status(), await res.text()).toBe(200);
        expect(await cardStatus(request, flow.flowId)).toBe(200);
      });
    } finally {
      await runCleanups(cleanups);
    }
  });
});
