import type { APIRequestContext, APIResponse } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import { createRunnableChatFlowViaApi } from "../../../../helpers/flows/create-runnable-chat-flow-via-api";

// The Chat Output node id inside `tests/assets/flows/chat-io-ok-trace-fixture.json`.
// The fixture echoes its input, so a run's output is deterministic with no
// provider configured, and the outputs map is keyed by this id.
const CHAT_OUTPUT_NODE_ID = "ChatOutput-yK0AU";

// What the flow echoes back, and therefore what a completed run's output must say.
const RUN_INPUT = "ping";

// The two uniqueness guards on `POST /api/v1/flows/batch/`. Asserted as exact
// strings so a regression collapsing both onto one message cannot pass: the
// status is `409` either way, so the message is the only thing that separates them.
const DUPLICATE_NAME_DETAIL = "Name must be unique";
const DUPLICATE_ENDPOINT_DETAIL = "Endpoint name must be unique";

// Fragments an unhandled `IntegrityError` renders into the response: SQLAlchemy
// appends the statement and its bound parameters to the exception message. This
// is the leak upstream #14634 closed, and nothing else in this suite would
// notice it — a leaking `409` still looks like a clean conflict to a status check.
const SQL_LEAK_MARKERS = [
  "INSERT",
  "SELECT",
  "UNIQUE constraint",
  "sqlalchemy",
  "sqlite3",
  "[SQL:",
  "parameters:",
];

/** How long the attribution control waits for the sync read-back to settle. */
const SETTLE_BUDGET_MS = 10_000;
const SETTLE_POLL_MS = 100;

interface JobStatusFacts {
  status: unknown;
  sessionId: unknown;
  outputKeys: string[];
  outputText: unknown;
}

function unique(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

/** Reads the fields of a workflow submit/status body this spec asserts on. */
async function readJobFacts(res: APIResponse): Promise<JobStatusFacts> {
  const body = await res.json();
  const outputs = (body?.outputs ?? {}) as Record<string, { content?: unknown }>;
  return {
    status: body?.status,
    sessionId: body?.session_id,
    outputKeys: Object.keys(outputs),
    outputText: outputs[CHAT_OUTPUT_NODE_ID]?.content,
  };
}

test.describe("Workflows v2 — the job lifecycle", () => {
  let bearerToken: string;

  // The shared Chat Input -> Chat Output flow every run test submits.
  let flowId: string;
  let deleteChatFlow: (reqOverride?: APIRequestContext) => Promise<void>;

  // Ids the batch tests create, deleted id-scoped in `afterAll`. Collected into
  // a local array rather than through `track-created-flows.ts`: that helper is
  // the suite's cleanup standard for 51 specs, but it listens on
  // `page.on("response")` and this file drives no page.
  const createdFlowIds: string[] = [];

  test.beforeAll(async ({ request }) => {
    bearerToken = await getAuthToken(request);
    const chatFlow = await createRunnableChatFlowViaApi(request, {
      Authorization: bearerToken,
    });
    flowId = chatFlow.flowId;
    deleteChatFlow = chatFlow.deleteFlow;
  });

  test.afterAll(async ({ request }) => {
    // A failure deleting one flow must not strand the rest. `afterAll` uses its
    // OWN request — the beforeAll one cannot be reused (Playwright scope rule).
    try {
      for (const id of createdFlowIds) {
        await deleteFlow(request, id, {
          headers: { Authorization: bearerToken },
        }).catch(() => {});
      }
    } finally {
      if (deleteChatFlow) await deleteChatFlow(request);
    }
  });

  /** `POST /api/v1/flows/batch/`. `FlowCreate` requires only `name`. */
  function postBatch(
    request: APIRequestContext,
    flows: Array<{ name: string; endpoint_name?: string }>,
  ): Promise<APIResponse> {
    return request.post("/api/v1/flows/batch/", {
      headers: { Authorization: bearerToken },
      data: { flows },
    });
  }

  /** `POST /api/v2/workflows`. */
  function postWorkflow(
    request: APIRequestContext,
    mode: "sync" | "background",
    sessionId: string,
  ): Promise<APIResponse> {
    return request.post("/api/v2/workflows", {
      headers: { Authorization: bearerToken },
      data: {
        flow_id: flowId,
        input_value: RUN_INPUT,
        session_id: sessionId,
        mode,
      },
    });
  }

  /** `GET /api/v2/workflows?job_id=…` — the read-back half of the lifecycle. */
  function getJob(
    request: APIRequestContext,
    jobId: string,
  ): Promise<APIResponse> {
    return request.get(`/api/v2/workflows?job_id=${jobId}`, {
      headers: { Authorization: bearerToken },
    });
  }

  async function assertNoSqlLeak(res: APIResponse, label: string) {
    const raw = await res.text();
    for (const marker of SQL_LEAK_MARKERS) {
      expect(
        raw.toLowerCase(),
        `${label} must not render the failed statement: an unhandled IntegrityError appends the SQL and its bound parameters, and a leaking 409 is indistinguishable from a clean one to any caller that only reads the status`,
      ).not.toContain(marker.toLowerCase());
    }
  }

  test(
    "batch create refuses a duplicate name with 409, leaks no SQL, and leaves the next write working",
    { tag: ["@api", "@regression"] },
    async ({ request }) => {
      const base = unique("batch-unique");
      let seededName = "";

      await test.step("a batch of unique names is accepted — the control", async () => {
        // First on purpose: without it every 409 below is equally consistent
        // with the batch endpoint being broken outright.
        const res = await postBatch(request, [
          { name: `${base}-a` },
          { name: `${base}-b` },
        ]);

        // Ids are recorded BEFORE anything is asserted. Cleanup must not depend
        // on the assertions passing: a row this call created is on the instance
        // whether or not the status is what we expected, and pushing the id
        // after a failing expect() is how a red test orphans a flow (measured —
        // the force-fail pass on the post-conflict write left exactly one).
        const created = (await res.json().catch(() => [])) as Array<{
          id?: string;
        }>;
        if (Array.isArray(created)) {
          for (const flow of created) {
            if (flow?.id) createdFlowIds.push(String(flow.id));
          }
        }

        expect(res.status()).toBe(201);
        expect(Array.isArray(created)).toBe(true);
        expect(created).toHaveLength(2);
        for (const flow of created) {
          expect(flow?.id, "every accepted row comes back with an id").toBeTruthy();
        }
        seededName = `${base}-a`;
      });

      await test.step("the same name twice in one payload is refused 409", async () => {
        const duplicated = unique("batch-dup-name");
        const res = await postBatch(request, [
          { name: duplicated },
          { name: duplicated },
        ]);
        expect(
          res.status(),
          "a duplicate must be a conflict, not the 30s SQLite lock timeout upstream #14634 replaced",
        ).toBe(409);
        expect((await res.json())?.detail).toBe(DUPLICATE_NAME_DETAIL);
        await assertNoSqlLeak(res, "the duplicate-name 409");
      });

      await test.step("a name that is already committed is refused the same way", async () => {
        // A different code path from two names inside one flush: this row exists
        // and is visible to the transaction rather than colliding within it.
        const res = await postBatch(request, [{ name: seededName }]);
        expect(res.status()).toBe(409);
        expect((await res.json())?.detail).toBe(DUPLICATE_NAME_DETAIL);
        await assertNoSqlLeak(res, "the already-committed-name 409");
      });

      await test.step("the next write succeeds — the rollback released the lock", async () => {
        // The load-bearing assertion. A 409 that left the write lock held
        // satisfies every assertion above and is still the exact defect #14634
        // fixed: the caller sees a clean conflict and the NEXT writer dies with
        // "database is locked". No duration threshold is needed — if the lock
        // were held this request would stall out instead of returning 201.
        const res = await request.post("/api/v1/flows/", {
          headers: { Authorization: bearerToken },
          data: { name: unique("after-conflict") },
        });

        // Recorded before the assert, for the reason given in step 1.
        const createdId = (await res.json().catch(() => ({})))?.id;
        if (createdId) createdFlowIds.push(String(createdId));

        expect(
          res.status(),
          "a write immediately after a refused batch must succeed; a held lock would make this stall rather than answer",
        ).toBe(201);
      });
    },
  );

  test(
    "batch create refuses a duplicate endpoint_name with its own message",
    { tag: ["@api", "@regression"] },
    async ({ request }) => {
      const sharedEndpoint = `ep${Date.now().toString(36)}${Math.random()
        .toString(36)
        .slice(2, 6)}`;

      const res = await postBatch(request, [
        { name: unique("batch-ep-1"), endpoint_name: sharedEndpoint },
        { name: unique("batch-ep-2"), endpoint_name: sharedEndpoint },
      ]);

      expect(res.status()).toBe(409);
      const detail = (await res.json())?.detail;
      expect(detail).toBe(DUPLICATE_ENDPOINT_DETAIL);
      expect(
        detail,
        "two guards, two messages: a regression collapsing them would still answer 409 and would still satisfy the duplicate-name test",
      ).not.toBe(DUPLICATE_NAME_DETAIL);

      await assertNoSqlLeak(res, "the duplicate-endpoint_name 409");
    },
  );

  test(
    "a completed background run reports the session it was given",
    { tag: ["@api", "@regression"] },
    async ({ request }) => {
      const sessionId = unique("bg-session");
      let jobId = "";

      await test.step("the run is queued and answers with a job id", async () => {
        const res = await postWorkflow(request, "background", sessionId);
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(body?.status).toBe("queued");
        expect(body?.job_id).toBeTruthy();
        jobId = String(body.job_id);
      });

      await test.step("the first completed status carries the session and the outputs", async () => {
        // Read the FIRST response that reports completion, not a settled one:
        // this test's whole contrast with the sync test is that background gets
        // it right immediately, so polling past the first `completed` would
        // measure convergence instead of the property.
        let facts: JobStatusFacts | null = null;
        const deadline = Date.now() + SETTLE_BUDGET_MS;
        while (Date.now() < deadline) {
          const res = await getJob(request, jobId);
          expect(res.status()).toBe(200);
          const seen = await readJobFacts(res);
          if (seen.status === "completed") {
            facts = seen;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS));
        }

        expect(
          facts,
          `the background job never reported completed within ${SETTLE_BUDGET_MS}ms`,
        ).not.toBeNull();
        expect(facts!.sessionId).toBe(sessionId);
        expect(
          facts!.sessionId,
          "the flow id is the documented degradation upstream #14512 names, so asserting only equality would pass on a flow whose id happened to match",
        ).not.toBe(flowId);
        expect(facts!.outputKeys).toContain(CHAT_OUTPUT_NODE_ID);
        expect(facts!.outputText).toBe(RUN_INPUT);
      });
    },
  );

  test(
    "a completed sync run answers its own status query with the session and outputs it returned",
    { tag: ["@api", "@regression"] },
    async ({ request }) => {
      // DECLARED FAILING, and the declaration is the alarm in both directions.
      //
      // The assertions below are the intended contract, unweakened: 15/15 they
      // fail on 1.12.0.dev37 because the sync read-back races the vertex_build
      // commit it reconstructs from (spec doc → *The sync defect*). Declaring
      // that keeps a known-broken product path out of a permanent red, and —
      // the half a plain red does not give — makes the FIX detectable: the day
      // upstream lands it this body passes, Playwright reports "expected to
      // fail but passed", and the suite goes red asking for this line back.
      //
      // `test.fail()` is rejected elsewhere in this suite for a real reason —
      // mcp-client-agent-gemini-tool-regression.spec.ts: it "converts ANY
      // failure (a broken bootstrap, a down instance …) into a green expected
      // failure". That objection is answered here by construction rather than
      // by argument: the attribution-control test below runs the SAME submit
      // and read-back, on the same flow, through the same helpers, and is NOT
      // declared failing — so a broken bootstrap or a dead instance reddens it
      // (and the three tests above it) rather than hiding here.
      test.fail();

      const sessionId = unique("sync-session");

      // The two calls are issued back to back with NOTHING between them, and
      // every assertion is deferred until both have answered. This is the
      // sequence a real client runs — submit, then read the job it was given —
      // and the ordering is load-bearing: the degradation below is a race
      // against the vertex_build commit, so parsing bodies or asserting the
      // submit response first spends the very window the test is measuring.
      // With the assertions interleaved the defect went undetected in 1 of 13
      // measured runs; issued back to back it is 10 of 10.
      const submit = await postWorkflow(request, "sync", sessionId);
      const jobId = String((await submit.json())?.job_id ?? "");
      const readBack = await getJob(request, jobId);

      await test.step("the run completed and said so, carrying its session and outputs", async () => {
        // The premise. Everything below contradicts it, rather than asking a
        // timing question — which is why it is asserted rather than assumed.
        expect(submit.status()).toBe(200);
        expect(jobId, "the submit response names the job to read back").toBeTruthy();

        const facts = await readJobFacts(submit);
        expect(facts.status).toBe("completed");
        expect(facts.sessionId).toBe(sessionId);
        expect(facts.outputKeys).toContain(CHAT_OUTPUT_NODE_ID);
        expect(facts.outputText).toBe(RUN_INPUT);
      });

      await test.step("reading that job back reports the same session and outputs", async () => {
        expect(readBack.status()).toBe(200);
        const facts = await readJobFacts(readBack);

        // Asserted first: it is what makes the rest a contradiction. The API
        // says the job is done, so "the outputs are not ready yet" is not an
        // available reading of the two assertions below.
        expect(
          facts.status,
          "the status endpoint agrees the job is complete",
        ).toBe("completed");

        expect(
          facts.sessionId,
          "a completed job must report the session it was submitted with — message memory and chat history scope to this key, so a status read that substitutes the flow id hands the caller a thread that is not the one that ran",
        ).toBe(sessionId);
        expect(facts.sessionId).not.toBe(flowId);
        expect(
          facts.outputKeys,
          "a job the API reports as completed must not report zero outputs: a caller cannot tell this from a run that genuinely produced nothing",
        ).toContain(CHAT_OUTPUT_NODE_ID);
        expect(facts.outputText).toBe(RUN_INPUT);
      });
    },
  );

  test(
    "attribution control: the sync read-back is correct once the job's rows settle",
    { tag: ["@api", "@regression"] },
    async ({ request }) => {
      // This test exists to make the previous one's failure attributable, and
      // the pair is the diagnosis: previous red + this green is a race between
      // the reply and the vertex_build commit. BOTH red is a strictly worse
      // regression — reconstruction dead, the session unrecoverable at any
      // time — and without this test the two would report as one finding.
      const sessionId = unique("settle-session");

      const submit = await postWorkflow(request, "sync", sessionId);
      expect(submit.status()).toBe(200);
      const jobId = String((await submit.json())?.job_id ?? "");
      expect(jobId).toBeTruthy();

      let settled: JobStatusFacts | null = null;
      const deadline = Date.now() + SETTLE_BUDGET_MS;
      while (Date.now() < deadline) {
        const res = await getJob(request, jobId);
        expect(res.status()).toBe(200);
        const facts = await readJobFacts(res);
        if (facts.sessionId === sessionId && facts.outputKeys.length > 0) {
          settled = facts;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS));
      }

      expect(
        settled,
        `the sync read-back never reported the submitted session with outputs within ${SETTLE_BUDGET_MS}ms — reconstruction is not merely late, it is unavailable`,
      ).not.toBeNull();
      expect(settled!.sessionId).toBe(sessionId);
      expect(settled!.outputKeys).toContain(CHAT_OUTPUT_NODE_ID);
    },
  );
});
