import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { createRunnableChatFlowViaApi } from "../../../../helpers/flows/create-runnable-chat-flow-via-api";
import {
  countMessages,
  requireServingConfiguration,
  runFlowV1,
  runWorkflowV2,
} from "../../../../helpers/serving/serving-identity";

// Spec doc: docs/api/flows/serving-end-user-identity-default.md
//
// On a DEFAULT instance, a client-supplied `X-End-User-Id` must do nothing.
//
// Langflow 1.12's serving-plane end-user identity (langflow-ai/langflow #14443,
// #14550) scopes per-user chat memory behind a TRUSTED gateway header. It is off
// by default, and this file asserts the off half — the configuration every
// deployment is in today. If a future change ever honours the header without the
// trust flag, whoever can set a request header picks which user's memory a run
// reads and writes, and nothing else in the suite would notice: the run answers
// 200, the output is correct, and the only difference is WHICH session row the
// message landed in.
//
// The trusted half is `serving/end-user-identity-isolation.spec.ts`, on its own
// lane and its own container. The pair is the point — the same header proven
// inert here and decisive there. Either alone is weak: this file passes on an
// instance where the feature is broken outright, and that one says nothing about
// the deployments that never turn it on.
//
// Deliberately NOT tagged `@serving`: that tag is a lane selector, and
// `tests/fixtures/lane.ts` grepInverts it out of every normal run — carrying it
// would move this spec to the opt-in lane and it would then never run on the one
// instance it has anything to say about.

/** Two identities that must both be ignored, and must not scope anything. */
const ALICE = "alice";
const BOB = "bob";

/** Chat Input -> Chat Output writes one user row and one machine row per run. */
const ROWS_PER_RUN = 2;

function uniqueSession(label: string): string {
  return `default-identity-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

test.describe("Serving end-user identity is inert on a default instance", () => {
  let bearer: Record<string, string>;
  let apiKey: string;
  let apiKeyId: string;
  let flowId: string;
  let deleteFlow: (reqOverride?: APIRequestContext) => Promise<void>;

  test.beforeAll(async ({ request }) => {
    const token = await getAuthToken(request);
    bearer = { Authorization: token };

    // `POST /api/v1/run/{id}` authenticates with x-api-key, not a bearer token,
    // so one is minted here and revoked in afterAll. The flow is created through
    // the key so its owner matches on both surfaces.
    const keyRes = await request.post("/api/v1/api_key/", {
      headers: bearer,
      data: { name: `serving-default-identity-${Date.now()}` },
    });
    expect(keyRes.status()).toBe(200);
    const key = await keyRes.json();
    apiKey = key.api_key;
    apiKeyId = key.id;

    const flow = await createRunnableChatFlowViaApi(request, { "x-api-key": apiKey });
    flowId = flow.flowId;
    deleteFlow = flow.deleteFlow;
  });

  test.afterAll(async ({ request }) => {
    try {
      // afterAll needs its OWN request fixture — the beforeAll one is out of
      // scope here (Playwright fixture-scope rule).
      if (deleteFlow) await deleteFlow(request);
    } finally {
      if (apiKeyId) {
        await request.delete(`/api/v1/api_key/${apiKeyId}`, { headers: bearer });
      }
    }
  });

  test(
    "the instance under test has no serving identity header configured",
    { tag: ["@stable", "@api", "@regression"] },
    async ({ request }) => {
      // The premise, asserted rather than assumed. A serving-configured instance
      // must not pass this file silently: every assertion below would then be
      // measuring the wrong row of the contract. The guard FAILS rather than
      // skipping, because a skip here would be green on all four configurations
      // (#1010's green all-skip), and it has to probe rather than read a flag —
      // GET /api/v1/config exposes no serving setting at all.
      await requireServingConfiguration(request, bearer, flowId, "default");
    },
  );

  test(
    "two identities on one session share it on POST /api/v2/workflows",
    { tag: ["@stable", "@api", "@regression"] },
    async ({ request }) => {
      const session = uniqueSession("v2");

      const asAlice = await runWorkflowV2(request, bearer, {
        flowId,
        sessionId: session,
        identity: ALICE,
      });
      const asBob = await runWorkflowV2(request, bearer, {
        flowId,
        sessionId: session,
        identity: BOB,
      });

      await test.step("both runs report the session verbatim", async () => {
        expect(asAlice.status, "an ignored header must not change the run's outcome").toBe(200);
        expect(asBob.status).toBe(200);
        expect(
          asAlice.sessionId,
          "a default instance must echo the session sent, not a scoped derivative",
        ).toBe(session);
        expect(asBob.sessionId).toBe(session);
      });

      await test.step("all four messages land in that one session", async () => {
        // The reported session is not enough on its own: an instance could report
        // the plain session while persisting to the scoped one, which is the
        // silent half of the vector. So the scoped keys are counted too.
        expect(await countMessages(request, bearer, `session_id=${session}`)).toBe(
          2 * ROWS_PER_RUN,
        );
        expect(
          await countMessages(request, bearer, `session_id=${ALICE}::${session}`),
          "a scoped session must not exist on an instance that never scopes",
        ).toBe(0);
        expect(await countMessages(request, bearer, `session_id=${BOB}::${session}`)).toBe(0);
      });
    },
  );

  test(
    "two identities on one session share it on POST /api/v1/run/{id}",
    { tag: ["@stable", "@api", "@regression"] },
    async ({ request }) => {
      // Both surfaces, because #14550's phase 1 extends the v2-only scoping to
      // all serving APIs — v1 is where a partial rollout would first honour the
      // header, and it is the surface a deployed integration actually calls.
      const session = uniqueSession("v1");

      const asAlice = await runFlowV1(request, apiKey, {
        flowId,
        sessionId: session,
        identity: ALICE,
      });
      const asBob = await runFlowV1(request, apiKey, {
        flowId,
        sessionId: session,
        identity: BOB,
      });

      await test.step("both runs report the session verbatim", async () => {
        expect(asAlice.status).toBe(200);
        expect(asBob.status).toBe(200);
        expect(asAlice.sessionId).toBe(session);
        expect(asBob.sessionId).toBe(session);
      });

      await test.step("all four messages land in that one session", async () => {
        expect(await countMessages(request, bearer, `session_id=${session}`)).toBe(
          2 * ROWS_PER_RUN,
        );
        expect(await countMessages(request, bearer, `session_id=${ALICE}::${session}`)).toBe(0);
        expect(await countMessages(request, bearer, `session_id=${BOB}::${session}`)).toBe(0);
      });
    },
  );

  test(
    "a different session persists separately, so the counts above are not vacuous",
    { tag: ["@stable", "@api", "@regression"] },
    async ({ request }) => {
      // Without this, "the header did nothing" and "chat memory does not work at
      // all" produce identical readings — both leave the scoped sessions empty.
      // This is the assertion that makes the two tests above mean something.
      const session = uniqueSession("control");

      const run = await runWorkflowV2(request, bearer, { flowId, sessionId: session });

      expect(run.status).toBe(200);
      expect(
        run.sessionId,
        "an identity-less run on a default instance keeps its own session",
      ).toBe(session);
      expect(
        await countMessages(request, bearer, `session_id=${session}`),
        "persistence must be working, otherwise the empty scoped sessions above prove nothing",
      ).toBe(ROWS_PER_RUN);
    },
  );
});
