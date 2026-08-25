import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { createRunnableChatFlowViaApi } from "../../../helpers/flows/create-runnable-chat-flow-via-api";
import { deleteFlow } from "../../../helpers/flows/delete-flow";
import {
  ANONYMOUS_SCOPE_PREFIX,
  countMessages,
  requireServingConfiguration,
  runWorkflowV2,
} from "../../../helpers/serving/serving-identity";

// Spec doc: docs/serving/end-user-identity-untrusted.md
// Lane: PW_SERVING_IDENTITY=1, against
//   LANGFLOW_SERVING_TRUST=0 ./scripts/start-langflow-serving-identity.sh
//
// Header NAMED but not TRUSTED. The header is not honoured — and the request does
// not fall back to the plain session either: every request becomes its own
// `anon::<uuid>` and persists nothing, while still answering 200 completed.
//
// That second half is why this is its own file rather than a footnote. The
// configuration is fail-closed for SECURITY — no client can pick a victim's
// scope by setting a header — and fail-SILENT for operations: an operator who
// sets the header name and forgets the trust flag has an instance that runs
// every flow successfully and remembers nothing, instance-wide, with no error,
// no warning, and no observable difference in any response status.
//
// The four-configuration contract is in docs/serving/end-user-identity-lane.md.
// No @stable — no scheduled @serving lane exists (#1010).

const ALICE = "alice";

/** A header present but empty of content. Blank is not an identity. */
const BLANK_IDENTITY = "   ";

function uniqueSession(label: string): string {
  return `serving-untrusted-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

test.describe("Serving end-user identity is inert and silent when untrusted", () => {
  let bearer: Record<string, string>;
  let probeFlowId: string;
  let deleteProbeFlow: (reqOverride?: APIRequestContext) => Promise<void>;

  // Ids pushed BEFORE the assertions that can throw, so a red test cannot leak.
  const createdFlowIds: string[] = [];

  test.beforeAll(async ({ request }) => {
    const token = await getAuthToken(request);
    bearer = { Authorization: token };
    const flow = await createRunnableChatFlowViaApi(request, { Authorization: token });
    probeFlowId = flow.flowId;
    deleteProbeFlow = flow.deleteFlow;
  });

  test.afterAll(async ({ request }) => {
    try {
      for (const id of createdFlowIds) {
        await deleteFlow(request, id, { headers: bearer }).catch(() => {});
      }
    } finally {
      if (deleteProbeFlow) await deleteProbeFlow(request);
    }
  });

  test(
    "the instance under test names the identity header but does not trust it",
    { tag: ["@api", "@regression", "@serving"] },
    async ({ request }) => {
      // Fail-closed. The probe runs on its OWN flow so the flow-wide counts below
      // start from a flow nothing else has touched — which is what makes "zero
      // rows anywhere" a statement about the run rather than about bookkeeping.
      await requireServingConfiguration(request, bearer, probeFlowId, "untrusted");
    },
  );

  test(
    "an identified run succeeds, is anonymised, and persists nothing anywhere",
    { tag: ["@api", "@regression", "@serving"] },
    async ({ request }) => {
      const flow = await createRunnableChatFlowViaApi(request, {
        Authorization: bearer.Authorization,
      });
      createdFlowIds.push(flow.flowId);

      const session = uniqueSession("identified");
      const run = await runWorkflowV2(request, bearer, {
        flowId: flow.flowId,
        sessionId: session,
        identity: ALICE,
      });

      await test.step("the run reports success — this is the fail-SILENT half", async () => {
        // Asserted, not assumed: the whole hazard of this configuration is that
        // nothing in the response tells an operator memory is off.
        expect(run.status).toBe(200);
        expect(run.body.status).toBe("completed");
      });

      await test.step("the identity is discarded for an anonymous scope", async () => {
        expect(run.sessionId ?? "").toContain(ANONYMOUS_SCOPE_PREFIX);
      });

      await test.step("nothing is persisted — not the scope, not the session, not the flow", async () => {
        // Three readings because two of them can pass on a leak. Only the
        // flow-wide count means NOWHERE; the other two mean "not there".
        expect(await countMessages(request, bearer, `session_id=${ALICE}::${session}`)).toBe(0);
        expect(await countMessages(request, bearer, `session_id=${session}`)).toBe(0);
        expect(
          await countMessages(request, bearer, `flow_id=${flow.flowId}`),
          "an untrusted instance must leave no row anywhere in the flow",
        ).toBe(0);
      });
    },
  );

  test(
    "a whitespace-only identity is treated as absent, not as a scope of its own",
    { tag: ["@api", "@regression", "@serving"] },
    async ({ request }) => {
      // The interesting failure here is not a refusal — it is a scope literally
      // named "   ::<session>", which every client would trivially collide on.
      const flow = await createRunnableChatFlowViaApi(request, {
        Authorization: bearer.Authorization,
      });
      createdFlowIds.push(flow.flowId);

      const session = uniqueSession("blank");
      const first = await runWorkflowV2(request, bearer, {
        flowId: flow.flowId,
        sessionId: session,
        identity: BLANK_IDENTITY,
      });
      const second = await runWorkflowV2(request, bearer, {
        flowId: flow.flowId,
        sessionId: session,
        identity: BLANK_IDENTITY,
      });

      await test.step("both runs are anonymised, and never scoped by the blank value", async () => {
        expect(first.status).toBe(200);
        expect(second.status).toBe(200);
        expect(first.sessionId ?? "").toContain(ANONYMOUS_SCOPE_PREFIX);
        expect(second.sessionId ?? "").toContain(ANONYMOUS_SCOPE_PREFIX);
        expect(
          await countMessages(request, bearer, `session_id=${BLANK_IDENTITY}::${session}`),
          "a blank identity must not mint a scope",
        ).toBe(0);
      });

      await test.step("the anonymous scope is minted per REQUEST, not per session", async () => {
        // Two consecutive requests from the same client on the same session share
        // no scope — which is what makes "remembers nothing" exact rather than
        // approximate.
        expect(first.sessionId).not.toBe(second.sessionId);
      });

      await test.step("neither run persisted anywhere in the flow", async () => {
        expect(await countMessages(request, bearer, `flow_id=${flow.flowId}`)).toBe(0);
      });
    },
  );
});
