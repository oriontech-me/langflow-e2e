import { readFileSync } from "fs";
import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { createFlow } from "../../../helpers/flows/create-flow";
import { createRunnableChatFlowViaApi } from "../../../helpers/flows/create-runnable-chat-flow-via-api";
import { deleteFlow } from "../../../helpers/flows/delete-flow";
import { requireServingConfiguration } from "../../../helpers/serving/serving-identity";
import {
  NEVER_EXISTED_JOB_ID,
  expectedRefusalBody,
  listPendingRequests,
  parseSseEvents,
  readJobEvents,
  readJobStatus,
  resumeJob,
  stopJob,
  submitBackgroundRun,
  type JobCallReading,
  type PendingRequestRow,
} from "../../../helpers/serving/serving-jobs";

// Spec doc: docs/serving/end-user-job-lifecycle-gating.md
// Lane: PW_SERVING_IDENTITY=1, against ./scripts/start-langflow-serving-identity.sh
//
// The job half of the trusted serving-identity row: a background job started
// by end user A cannot be read, enumerated, stopped, resumed or re-attached to
// by end user B — or by an anonymous caller — and their refused attempts leave
// A's job exactly as it was. `langflow-ai/langflow` #14550's phase 3: the end
// user lives in `job_metadata['end_user_id']`, because `job.user_id` is the
// shared service account for every end user.
//
// Every call carries the auto-login SUPERUSER's bearer on purpose. The jobs
// endpoints have a superuser bypass, the serving plane's service account IS a
// superuser, and upstream suppresses the bypass whenever the feature is on — a
// non-superuser caller would pass on an instance where that suppression is gone.
//
// No @stable, and it cannot have one: nothing runs @serving on a cron, so the
// tag would mark a test that never runs (#1010).

const HITL_FIXTURE = "tests/assets/flows/human-input-branching-fixture.json";

const ALICE = "alice";
const BOB = "bob";

/** The decision both alice and the refused callers send; the fixture offers approve/reject. */
const APPROVE = "approve";

/**
 * The two callers that must be refused. `identity: undefined` sends NO identity
 * header: upstream decided an anonymous request must not reach an identified run,
 * and the rule that enforces it is subtle — no end user matches only a job that
 * also has none — so a regression treating "no identity" as a wildcard would let
 * every header-less client act on every identified user's job.
 */
const REFUSED_CALLERS: ReadonlyArray<{ label: string; identity: string | undefined }> = [
  { label: "another end user", identity: BOB },
  { label: "an anonymous caller", identity: undefined },
];

const TAGS = { tag: ["@api", "@regression", "@serving"] };

function unique(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function jobStatusOf(reading: JobCallReading): unknown {
  return (reading.body as { status?: unknown } | null)?.status;
}

/**
 * B's refusal must be the response a job that never existed gets: same status,
 * same body, apart from the echoed job id. That is the property upstream's
 * "404, not 403" decision buys — a 403, a different `error` string or a message
 * naming the owner would each tell B the job exists, and all three pass a
 * status-only check.
 */
function expectRefusedLikeNeverExisted(
  refusal: JobCallReading,
  neverExisted: JobCallReading,
  jobId: string,
  context: string,
): void {
  // The reference reading must itself be a not-found, or two equal 500s would
  // satisfy the comparison below.
  expect(neverExisted.status, `${context}: a never-existed job id must answer 404`).toBe(404);
  expect((neverExisted.body as { code?: unknown } | null)?.code).toBe("JOB_NOT_FOUND");
  expect(refusal.status, `${context}: another end user's job must answer 404`).toBe(404);
  expect(
    refusal.body,
    `${context}: the refusal must be indistinguishable from a job that never existed`,
  ).toEqual(expectedRefusalBody(neverExisted.body, jobId));
}

test.describe("Serving end-user identity gates another end user's job on a trusted instance", () => {
  let bearer: Record<string, string>;
  let deleteProbeFlow: (reqOverride?: APIRequestContext) => Promise<void>;

  // Per test, cleared in afterEach. Ids are pushed BEFORE the assertions that
  // can throw, so a red test cannot leak a flow or leave a job suspended.
  let createdFlowIds: string[] = [];
  let aliceJobIds: string[] = [];

  test.beforeAll(async ({ request }) => {
    bearer = { Authorization: await getAuthToken(request) };

    // The guard gates EVERY test, and that is why it lives here rather than in
    // a test of its own. On a default instance no end user is stamped and the
    // superuser bypass applies; on an untrusted one alice is anonymised and an
    // anonymous bob matches her job. Either way bob READS alice's job, and every
    // refusal below would go red as a leak — a security finding against a
    // product behaving correctly. The guard names the configuration instead.
    const probe = await createRunnableChatFlowViaApi(request, bearer);
    deleteProbeFlow = probe.deleteFlow;
    await requireServingConfiguration(request, bearer, probe.flowId, "trusted");
  });

  test.afterEach(async ({ request }) => {
    try {
      // Alice is the only identity that can stop her job. On a job already
      // terminal this answers 200 "already finished" and changes nothing.
      for (const jobId of aliceJobIds) {
        await stopJob(request, bearer, jobId, ALICE).catch(() => {});
      }
    } finally {
      for (const id of createdFlowIds) {
        await deleteFlow(request, id, { headers: bearer }).catch(() => {});
      }
      createdFlowIds = [];
      aliceJobIds = [];
    }
  });

  test.afterAll(async ({ request }) => {
    if (deleteProbeFlow) await deleteProbeFlow(request);
  });

  /**
   * A Human Input run, submitted by alice in background mode and parked at
   * `suspended`: a live job that stays put until someone answers it, so a
   * refused stop or resume can be checked for side effects without racing the
   * run to completion. Each test gets its own flow, so the pending list for it
   * holds alice's job and nothing else.
   */
  async function parkAliceJob(request: APIRequestContext, label: string) {
    const fixture = JSON.parse(readFileSync(HITL_FIXTURE, "utf-8"));
    const flowId = await createFlow(
      request,
      { name: `Serving job gating ${unique(label)}`, data: fixture.data, is_component: false },
      { headers: bearer },
    );
    createdFlowIds.push(flowId);

    const sessionId = `serving-jobs-${unique(label)}`;
    const inputValue = `job gating ${unique(label)}`;
    const jobId = await submitBackgroundRun(request, bearer, {
      flowId,
      sessionId,
      identity: ALICE,
      inputValue,
    });
    aliceJobIds.push(jobId);

    // Measured ~0.5 s on 1.13.0.dev30; the cap only bounds a run that never parks.
    await expect
      .poll(async () => jobStatusOf(await readJobStatus(request, bearer, jobId, ALICE)), {
        timeout: 30_000,
        message: "alice's Human Input run never reached `suspended`",
      })
      .toBe("suspended");

    return { flowId, jobId, sessionId, inputValue };
  }

  async function alicePendingRows(request: APIRequestContext, flowId: string) {
    const pending = await listPendingRequests(request, bearer, flowId, ALICE);
    expect(pending.status).toBe(200);
    return pending.body as PendingRequestRow[];
  }

  /** The job is exactly as it was: still parked, and still offered to its owner. */
  async function expectStillSuspendedForAlice(
    request: APIRequestContext,
    job: { flowId: string; jobId: string },
  ) {
    expect(jobStatusOf(await readJobStatus(request, bearer, job.jobId, ALICE))).toBe("suspended");
    expect((await alicePendingRows(request, job.flowId)).map((r) => r.job_id)).toEqual([job.jobId]);
  }

  test("another end user can neither read nor enumerate a suspended job", TAGS, async ({
    request,
    apiCoverage,
  }) => {
    apiCoverage.declare([
      "POST /api/v2/workflows",
      "GET /api/v2/workflows",
      "GET /api/v2/workflows/pending",
    ]);
    const job = await parkAliceJob(request, "read");

    await test.step("the owner reads her job and finds it in her pending list", async () => {
      const status = await readJobStatus(request, bearer, job.jobId, ALICE);
      expect(status.status).toBe(200);
      expect(jobStatusOf(status)).toBe("suspended");

      const rows = await alicePendingRows(request, job.flowId);
      expect(rows.map((r) => [r.job_id, r.session_id])).toEqual([
        [job.jobId, `${ALICE}::${job.sessionId}`],
      ]);
    });

    for (const caller of REFUSED_CALLERS) {
      await test.step(`${caller.label} gets a never-existed job's 404 on the status read`, async () => {
        const neverExisted = await readJobStatus(request, bearer, NEVER_EXISTED_JOB_ID, caller.identity);
        const refusal = await readJobStatus(request, bearer, job.jobId, caller.identity);
        expectRefusedLikeNeverExisted(refusal, neverExisted, job.jobId, `status read as ${caller.label}`);
      });

      await test.step(`${caller.label} finds nothing in the flow's pending list`, async () => {
        // The enumerating door needs no job id at all, and each row carries the
        // scoped session and the HITL prompt — so an empty list here is the
        // check that matters most, not the 404 above.
        const pending = await listPendingRequests(request, bearer, job.flowId, caller.identity);
        expect(pending.status).toBe(200);
        expect(pending.body, `pending list as ${caller.label}`).toEqual([]);
      });
    }
  });

  test("another end user cannot stop a job, and the refused stop leaves it running", TAGS, async ({
    request,
    apiCoverage,
  }) => {
    apiCoverage.declare([
      "POST /api/v2/workflows",
      "GET /api/v2/workflows",
      "GET /api/v2/workflows/pending",
      "POST /api/v2/workflows/stop",
    ]);
    const job = await parkAliceJob(request, "stop");

    for (const caller of REFUSED_CALLERS) {
      await test.step(`${caller.label} gets a never-existed job's 404 on stop`, async () => {
        const neverExisted = await stopJob(request, bearer, NEVER_EXISTED_JOB_ID, caller.identity);
        const refusal = await stopJob(request, bearer, job.jobId, caller.identity);
        expectRefusedLikeNeverExisted(refusal, neverExisted, job.jobId, `stop as ${caller.label}`);
      });
    }

    await test.step("the refused stops changed nothing: the job is still suspended", async () => {
      // A guard that refused the RESPONSE after acting on the job would pass
      // every 404 above while cancelling alice's run.
      await expectStillSuspendedForAlice(request, job);
    });

    await test.step("the owner's identical stop cancels it", async () => {
      // The positive control: without it, a stop endpoint that 404s everyone
      // satisfies every refusal above.
      const own = await stopJob(request, bearer, job.jobId, ALICE);
      expect(own.status).toBe(200);
      await expect
        .poll(async () => jobStatusOf(await readJobStatus(request, bearer, job.jobId, ALICE)), {
          timeout: 15_000,
        })
        .toBe("cancelled");
    });
  });

  test("another end user cannot resume a job, and the refused resume consumes nothing", TAGS, async ({
    request,
    apiCoverage,
  }) => {
    apiCoverage.declare([
      "POST /api/v2/workflows",
      "GET /api/v2/workflows",
      "GET /api/v2/workflows/pending",
      "POST /api/v2/workflows/{job_id}/resume",
    ]);
    const job = await parkAliceJob(request, "resume");

    const [row] = await alicePendingRows(request, job.flowId);
    expect(row.allowed_decisions).toContain(APPROVE);
    // The REAL request id and an allowed decision: bob's body is one that would
    // be accepted from alice, so nothing but the identity can refuse it.
    const decision = { request_id: row.request_id, decision: { action_id: APPROVE } };

    for (const caller of REFUSED_CALLERS) {
      await test.step(`${caller.label} gets a never-existed job's 404 on resume`, async () => {
        const neverExisted = await resumeJob(request, bearer, NEVER_EXISTED_JOB_ID, decision, caller.identity);
        const refusal = await resumeJob(request, bearer, job.jobId, decision, caller.identity);
        expectRefusedLikeNeverExisted(refusal, neverExisted, job.jobId, `resume as ${caller.label}`);
      });
    }

    await test.step("the refused resumes changed nothing: the job is still suspended", async () => {
      await expectStillSuspendedForAlice(request, job);
    });

    await test.step("the owner's identical resume is accepted and completes the run", async () => {
      // The pending request is single-use: had bob's resume been ACCEPTED behind
      // its 404, this identical one would answer 409 NOT_RESUMABLE. So this 200
      // proves both that bob's request was well-formed and that it consumed
      // nothing.
      const own = await resumeJob(request, bearer, job.jobId, decision, ALICE);
      expect(own.status, own.text).toBe(200);
      expect((own.body as { status?: unknown }).status).toBe("resuming");
      await expect
        .poll(async () => jobStatusOf(await readJobStatus(request, bearer, job.jobId, ALICE)), {
          timeout: 30_000,
        })
        .toBe("completed");
    });
  });

  test("another end user cannot re-attach to a job's event stream", TAGS, async ({
    request,
    apiCoverage,
  }) => {
    apiCoverage.declare([
      "POST /api/v2/workflows",
      "GET /api/v2/workflows",
      "GET /api/v2/workflows/pending",
      "POST /api/v2/workflows/{job_id}/resume",
      "GET /api/v2/workflows/{job_id}/events",
    ]);
    const job = await parkAliceJob(request, "events");

    await test.step("the owner answers the run, so its stream replays and closes", async () => {
      // A suspended job's stream tails until the run ends; a finished one
      // replays and closes (measured at 17 ms), which is what lets the owner's
      // positive control below read a whole body.
      const [row] = await alicePendingRows(request, job.flowId);
      const own = await resumeJob(
        request,
        bearer,
        job.jobId,
        { request_id: row.request_id, decision: { action_id: APPROVE } },
        ALICE,
      );
      expect(own.status, own.text).toBe(200);
      await expect
        .poll(async () => jobStatusOf(await readJobStatus(request, bearer, job.jobId, ALICE)), {
          timeout: 30_000,
        })
        .toBe("completed");
    });

    for (const caller of REFUSED_CALLERS) {
      await test.step(`${caller.label} gets a never-existed job's 404 on re-attach`, async () => {
        const neverExisted = await readJobEvents(request, bearer, NEVER_EXISTED_JOB_ID, caller.identity);
        const refusal = await readJobEvents(request, bearer, job.jobId, caller.identity);
        expectRefusedLikeNeverExisted(refusal, neverExisted, job.jobId, `re-attach as ${caller.label}`);
      });
    }

    await test.step("the owner's identical re-attach replays her message", async () => {
      // The content the 404s above withhold: the replay carries alice's own
      // chat message, in her scoped session.
      const own = await readJobEvents(request, bearer, job.jobId, ALICE);
      expect(own.status).toBe(200);
      expect(own.contentType).toContain("text/event-stream");
      const userMessages = parseSseEvents(own.text)
        .filter((e) => e.event === "add_message")
        .map((e) => e.data as { sender?: unknown; session_id?: unknown; text?: unknown })
        .filter((m) => m.sender === "User");
      expect(userMessages.map((m) => [m.session_id, m.text])).toEqual([
        [`${ALICE}::${job.sessionId}`, job.inputValue],
      ]);
    });
  });
});
