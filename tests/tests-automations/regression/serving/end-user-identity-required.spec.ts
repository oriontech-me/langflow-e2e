import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { createRunnableChatFlowViaApi } from "../../../helpers/flows/create-runnable-chat-flow-via-api";
import {
  IDENTITY_REQUIRED_CODE,
  SERVING_IDENTITY_HEADER,
  countMessages,
  requireServingConfiguration,
  runFlowV1,
  runWorkflowV2,
  type WorkflowRunReading,
} from "../../../helpers/serving/serving-identity";

// Spec doc: docs/serving/end-user-identity-required.md
// Lane: PW_SERVING_IDENTITY=1, against
//   LANGFLOW_SERVING_REQUIRED=1 ./scripts/start-langflow-serving-identity.sh
//
// With the identity REQUIRED, an identity-less request is refused rather than
// anonymised — 401, with a machine-readable code and a message naming the
// configured header — while an identified request still runs.
//
// This is the row an operator relies on to guarantee that no traffic reaches a
// flow unattributed. A regression here does not corrupt data; it silently
// re-opens the instance to anonymous traffic. So the refusal is asserted as a
// status AND a code AND on both serving surfaces — and the accepted request is
// asserted too, because a guard that refuses everything is as broken as one that
// refuses nothing and would pass a spec that only checked the 401s.
//
// This spec provokes 401s on purpose and needs no page.allowHttpErrors(): the
// fixture's HTTP monitor is a page.on("response") listener and every call here
// goes through the `request` fixture, which never reaches it. The honest
// consequence is that checklist step 4 ("no 🚨 Backend Error: logged") carries no
// information for this file — the refusals are evidence only because they are
// asserted directly.
//
// No @stable — no scheduled @serving lane exists (#1010).

const ALICE = "alice";

/** A header present but empty of content. Blank is not an identity. */
const BLANK_IDENTITY = "   ";

/** Chat Input -> Chat Output writes one user row and one machine row per run. */
const ROWS_PER_RUN = 2;

function uniqueSession(label: string): string {
  return `serving-required-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * The refusal contract, asserted the same way wherever it is reached.
 *
 * `code` is what a gateway branches on, so it is the assertion; the sentence is
 * copy and may be retuned. The message is still checked for ONE property — that
 * it names the CONFIGURED header — because an operator running a non-default
 * header name needs the error to say which one is missing, and a hardcoded name
 * there would be a real defect only this assertion would catch.
 */
function expectIdentityRefusal(reading: WorkflowRunReading, surface: string): void {
  expect(reading.status, `${surface} must refuse an unattributed request`).toBe(401);
  expect(reading.detailCode, `${surface} must refuse with the contracted code`).toBe(
    IDENTITY_REQUIRED_CODE,
  );
  const detail = reading.body.detail as { message?: unknown } | undefined;
  expect(
    typeof detail?.message === "string" ? detail.message : "",
    `${surface}'s refusal must name the configured header`,
  ).toContain(SERVING_IDENTITY_HEADER);
}

test.describe("Serving end-user identity, when required, refuses unattributed runs", () => {
  let bearer: Record<string, string>;
  let apiKey: string;
  let apiKeyId: string;
  let flowId: string;
  let deleteWorkFlow: (reqOverride?: APIRequestContext) => Promise<void>;

  test.beforeAll(async ({ request }) => {
    const token = await getAuthToken(request);
    bearer = { Authorization: token };

    const keyRes = await request.post("/api/v1/api_key/", {
      headers: bearer,
      data: { name: `serving-required-${Date.now()}` },
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
      if (deleteWorkFlow) await deleteWorkFlow(request);
    } finally {
      if (apiKeyId) {
        await request.delete(`/api/v1/api_key/${apiKeyId}`, { headers: bearer });
      }
    }
  });

  test(
    "the instance under test requires an end-user identity",
    { tag: ["@api", "@regression", "@serving"] },
    async ({ request }) => {
      // Fail-closed, probed rather than read — no API exposes the setting. The
      // guard's message separates this container from its three siblings, which
      // is the diagnosis a reader needs: all four produce the same symptom, a
      // spec asserting the wrong row of the contract.
      await requireServingConfiguration(request, bearer, flowId, "required");
    },
  );

  test(
    "POST /api/v2/workflows accepts an identity and refuses its absence",
    { tag: ["@api", "@regression", "@serving"] },
    async ({ request }) => {
      const session = uniqueSession("v2");

      await test.step("an identified run is accepted, scoped and persisted", async () => {
        const accepted = await runWorkflowV2(request, bearer, {
          flowId,
          sessionId: session,
          identity: ALICE,
        });
        expect(accepted.status, "a guard that refuses everything is also broken").toBe(200);
        expect(accepted.sessionId).toBe(`${ALICE}::${session}`);
        expect(await countMessages(request, bearer, `session_id=${ALICE}::${session}`)).toBe(
          ROWS_PER_RUN,
        );
      });

      await test.step("an identity-less run is refused", async () => {
        const refused = await runWorkflowV2(request, bearer, { flowId, sessionId: session });
        expectIdentityRefusal(refused, "POST /api/v2/workflows");
      });

      await test.step("a whitespace-only identity is refused the same way", async () => {
        // Blank is not an identity. The product answers with the identical body,
        // including the word "missing", even though the header was present —
        // recorded here rather than paraphrased, because a spec that demanded a
        // DIFFERENT message for the blank case would fail correct behaviour.
        const blank = await runWorkflowV2(request, bearer, {
          flowId,
          sessionId: session,
          identity: BLANK_IDENTITY,
        });
        expectIdentityRefusal(blank, "POST /api/v2/workflows with a blank identity");
      });
    },
  );

  test(
    "POST /api/v1/run/{id} accepts an identity and refuses its absence",
    { tag: ["@api", "@regression", "@serving"] },
    async ({ request }) => {
      // Both surfaces: the guard is only worth its configuration if no serving
      // API can be reached around it.
      const session = uniqueSession("v1");

      await test.step("an identified run is accepted and scoped", async () => {
        const accepted = await runFlowV1(request, apiKey, {
          flowId,
          sessionId: session,
          identity: ALICE,
        });
        expect(accepted.status).toBe(200);
        expect(accepted.sessionId).toBe(`${ALICE}::${session}`);
      });

      await test.step("an identity-less run is refused with the same code", async () => {
        const refused = await runFlowV1(request, apiKey, { flowId, sessionId: session });
        expectIdentityRefusal(refused, "POST /api/v1/run/{id}");
      });
    },
  );
});
