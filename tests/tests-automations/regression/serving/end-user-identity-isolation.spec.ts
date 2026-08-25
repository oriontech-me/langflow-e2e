import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { createRunnableChatFlowViaApi } from "../../../helpers/flows/create-runnable-chat-flow-via-api";
import { deleteFlow } from "../../../helpers/flows/delete-flow";
import {
  ANONYMOUS_SCOPE_PREFIX,
  countMessages,
  requireServingConfiguration,
  runFlowV1,
  runWorkflowV2,
} from "../../../helpers/serving/serving-identity";

// Spec doc: docs/serving/end-user-identity-isolation.md
// Lane: PW_SERVING_IDENTITY=1, against ./scripts/start-langflow-serving-identity.sh
//
// The trusted row of the serving-identity contract: with the header configured
// AND trusted, two end users sharing one `session_id` get separate chat memory,
// on every serving surface, and nothing leaks into the shared session they
// nominally sent.
//
// The four-configuration contract, the container script and the lane selector
// are specified in docs/serving/end-user-identity-lane.md (#1582). The inert
// half — the same header doing nothing on a default instance — is
// `api/flows/serving-end-user-identity-default.spec.ts`, on the stock lane.
//
// No @stable, and it cannot have one: nothing runs @serving on a cron, so the
// tag would mark a test that never runs (#1010).

const ALICE = "alice";
const BOB = "bob";

/** Chat Input -> Chat Output writes one user row and one machine row per run. */
const ROWS_PER_RUN = 2;

function uniqueSession(label: string): string {
  return `serving-iso-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

test.describe("Serving end-user identity isolates users on a trusted instance", () => {
  let bearer: Record<string, string>;
  let apiKey: string;
  let apiKeyId: string;
  let flowId: string;
  let deleteWorkFlow: (reqOverride?: APIRequestContext) => Promise<void>;

  // Flows created inside a test, deleted id-scoped in afterAll. Ids are pushed
  // BEFORE the assertions that can throw, so a red test cannot leak a flow —
  // the ordering bug #1575's force-fail caught.
  const createdFlowIds: string[] = [];

  test.beforeAll(async ({ request }) => {
    const token = await getAuthToken(request);
    bearer = { Authorization: token };

    const keyRes = await request.post("/api/v1/api_key/", {
      headers: bearer,
      data: { name: `serving-isolation-${Date.now()}` },
    });
    expect(keyRes.status()).toBe(200);
    const key = await keyRes.json();
    apiKey = key.api_key;
    apiKeyId = key.id;

    const flow = await createRunnableChatFlowViaApi(request, { "x-api-key": apiKey });
    flowId = flow.flowId;
    deleteWorkFlow = flow.deleteFlow;
  });

  test.afterAll(async ({ request }) => {
    try {
      for (const id of createdFlowIds) {
        await deleteFlow(request, id, { headers: bearer }).catch(() => {});
      }
    } finally {
      try {
        if (deleteWorkFlow) await deleteWorkFlow(request);
      } finally {
        if (apiKeyId) {
          await request.delete(`/api/v1/api_key/${apiKeyId}`, { headers: bearer });
        }
      }
    }
  });

  test(
    "the instance under test has the identity header configured and trusted",
    { tag: ["@api", "@regression", "@serving"] },
    async ({ request }) => {
      // Fail-closed, and it has to probe rather than read: the configuration is
      // exposed by no API at all — GET /api/v1/config returns 35 keys and none of
      // them mentions serving, end_user or trust (measured on 1.12.0.dev38). The
      // guard names the state it found and the invocation that produces this one,
      // because the four configurations are four different mistakes with one
      // symptom: a spec asserting the wrong row.
      await requireServingConfiguration(request, bearer, flowId, "trusted");
    },
  );

  test(
    "two identities on one session are isolated on POST /api/v2/workflows",
    { tag: ["@api", "@regression", "@serving"] },
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

      await test.step("each run reports its own scoped session", async () => {
        expect(asAlice.status).toBe(200);
        expect(asBob.status).toBe(200);
        expect(asAlice.sessionId).toBe(`${ALICE}::${session}`);
        expect(asBob.sessionId).toBe(`${BOB}::${session}`);
      });

      await test.step("each scope holds only its own messages", async () => {
        expect(await countMessages(request, bearer, `session_id=${ALICE}::${session}`)).toBe(
          ROWS_PER_RUN,
        );
        expect(await countMessages(request, bearer, `session_id=${BOB}::${session}`)).toBe(
          ROWS_PER_RUN,
        );
      });

      await test.step("the bare session both clients sent stays empty", async () => {
        // THE boundary. A merge that scoped the read but also wrote to the
        // unscoped session would leave both per-user counts above perfectly
        // correct, while a third client running on plain `session` reads
        // everybody's history. This is the only reading that catches it.
        expect(
          await countMessages(request, bearer, `session_id=${session}`),
          "a row in the unscoped session is readable by every other end user",
        ).toBe(0);
      });
    },
  );

  test(
    "two identities on one session are isolated on POST /api/v1/run/{id}",
    { tag: ["@api", "@regression", "@serving"] },
    async ({ request }) => {
      // #14550's phase 1 extends the v2-only scoping to all serving APIs, so v1
      // is where that extension would come undone first — and it is the surface
      // deployed integrations call, with a minted x-api-key.
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

      await test.step("each run reports its own scoped session", async () => {
        expect(asAlice.status).toBe(200);
        expect(asBob.status).toBe(200);
        expect(asAlice.sessionId).toBe(`${ALICE}::${session}`);
        expect(asBob.sessionId).toBe(`${BOB}::${session}`);
      });

      await test.step("each scope holds only its own messages, and the bare session none", async () => {
        expect(await countMessages(request, bearer, `session_id=${ALICE}::${session}`)).toBe(
          ROWS_PER_RUN,
        );
        expect(await countMessages(request, bearer, `session_id=${BOB}::${session}`)).toBe(
          ROWS_PER_RUN,
        );
        expect(await countMessages(request, bearer, `session_id=${session}`)).toBe(0);
      });
    },
  );

  test(
    "an identity-less run is anonymised and persists nothing anywhere in the flow",
    { tag: ["@api", "@regression", "@serving"] },
    async ({ request }) => {
      // On a FRESH flow, so "nothing" is unambiguous: the shared work flow above
      // already carries the guard's and the isolation tests' rows.
      const flow = await createRunnableChatFlowViaApi(request, { Authorization: bearer.Authorization });
      createdFlowIds.push(flow.flowId);

      const session = uniqueSession("anon");
      const run = await runWorkflowV2(request, bearer, { flowId: flow.flowId, sessionId: session });

      expect(run.status, "an unattributed run still succeeds — it just does not persist").toBe(200);
      expect(run.sessionId ?? "").toContain(ANONYMOUS_SCOPE_PREFIX);

      // Asserted over the WHOLE flow, not over the anon session the run reported:
      // checking the reported session confirms it did not write THERE while
      // saying nothing about whether it wrote somewhere else — and "somewhere
      // else" is exactly what a scoping bug does. `flow_id=` means nowhere.
      expect(
        await countMessages(request, bearer, `flow_id=${flow.flowId}`),
        "an anonymous run must leave no row anywhere in the flow",
      ).toBe(0);
    },
  );
});
