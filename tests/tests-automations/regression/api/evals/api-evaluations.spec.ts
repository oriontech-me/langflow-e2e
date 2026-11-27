import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import {
  DatasetTracker,
  addItems,
  createDataset,
  readDataset,
  readEvalsSurface,
} from "../../../../helpers/api/evals/datasets";
import {
  ECHO_OUTPUT,
  EVALUATION_RUNS,
  EVALUATIONS,
  EvaluationTracker,
  createEchoFlow,
  createEvaluation,
  isTerminalRunStatus,
  listAllResults,
  pollRun,
  readRun,
  startRun,
  waitForRunEnd,
  type EvaluationRead,
  type EvaluationRunRead,
  type ScorerSpec,
} from "../../../../helpers/api/evals/evaluations";
import { fetchComponentCatalog } from "../../../../helpers/flows/build-catalog-flow";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";

/**
 * Evals evaluations API (#2564) — the 14 operations of `/api/v1/evaluations` and
 * `/api/v1/evaluation-runs` (Langflow 1.14, upstream #15999; on by default since #16591).
 *
 * Keyless by construction: the text scorers call no model, and the flow is an echo
 * (Chat Input → Chat Output) built from the live catalog, so every row's answer is its
 * input and every score is known in advance. Runs execute server-side under a
 * background job, so no run stream reaches a page and the fixture's flow-error gate has
 * nothing to judge: the row `error` and the run's `failed_items` are the verdict here.
 *
 * Datasets come from #2563's helper; the UI is #2565 and deleting the retained version
 * is #2566. Contract and measurements: docs/api/evals/api-evaluations.md.
 */

const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const BOM = "﻿";

const TEXT_SCORERS: ScorerSpec[] = [
  { type: "exact_match", name: "exact" },
  { type: "contains", name: "contains" },
];

/**
 * Six rows, each decided by a different rule (docs/api/evals/api-evaluations.md):
 * exact, exact, contains-only at the 0.5 threshold, case-insensitive exact, a miss,
 * and a row with no expected output (undecided).
 */
const ROWS = [
  { input: "alpha", expected_output: "alpha" },
  { input: "beta", expected_output: "beta" },
  { input: "the quick brown fox", expected_output: "quick" },
  { input: "gamma", expected_output: "GAMMA" },
  { input: "delta", expected_output: "nope" },
  { input: "epsilon" },
];
const EXPECTED_SCORES = [
  { exact: 1, contains: 1, passed: true },
  { exact: 1, contains: 1, passed: true },
  { exact: 0, contains: 1, passed: true },
  { exact: 1, contains: 1, passed: true },
  { exact: 0, contains: 0, passed: false },
  { exact: null, contains: null, passed: null },
];
const NO_EXPECTED = "No expected output for this row";

test.describe("Evals API — evaluations and runs", () => {
  let headers: Record<string, string>;
  let skipReason: string | null = null;
  let datasets: DatasetTracker;
  let evaluations: EvaluationTracker;
  let flows: string[];
  // Read once per file: GET /api/v1/all is ~700 KB and ~9 s cold, and one read per
  // test was enough load to stall a contended local backend during a burst.
  let catalog: Record<string, unknown>;

  test.beforeAll(async ({ request }) => {
    headers = { Authorization: await getAuthToken(request) };
    const verdict = await readEvalsSurface(request, headers);
    if (verdict.state === "absent") skipReason = verdict.reason;
    else if (verdict.state !== "enabled") throw new Error(`evals premise: ${verdict.reason}`);
    else catalog = await fetchComponentCatalog(request, headers);
  });

  test.beforeEach(() => {
    datasets = new DatasetTracker();
    evaluations = new EvaluationTracker();
    flows = [];
    test.skip(skipReason !== null, skipReason ?? "");
  });

  // Evaluations first: deleting a flow does not delete them (they survive with
  // flow_id: null), and their retained versions are released by their own delete.
  test.afterEach(async ({ request }) => {
    await evaluations.cleanup(request, headers);
    for (const id of flows.splice(0)) await deleteFlow(request, id, { headers });
    await datasets.cleanup(request, headers);
  });

  /** An echo flow and the six-row dataset, both tracked. */
  async function seed(request: Parameters<typeof createEchoFlow>[0], label: string) {
    const flowId = await createEchoFlow(request, headers, `ev-${label}-${uid()}`, { catalog });
    flows.push(flowId);
    const dataset = await createDataset(request, headers, { name: `ev-${label}-${uid()}` }, datasets);
    await addItems(request, headers, dataset.id, ROWS);
    return { flowId, dataset: await readDataset(request, headers, dataset.id) };
  }

  test("check reports an evaluable flow and blocks a flow with no output", {
    tag: ["@stable", "@api", "@database", "@evals"],
  }, async ({ request, apiCoverage }) => {
    apiCoverage.declare([
      "GET /api/v1/evaluations/check",
      "POST /api/v1/evaluations",
      "POST /api/v1/evaluations/{evaluation_id}/runs",
    ]);
    const { flowId, dataset } = await seed(request, "check");
    const lonely = await createEchoFlow(request, headers, `ev-noout-${uid()}`, { withOutput: false, catalog });
    flows.push(lonely);

    await test.step("the echo flow has nothing blocking and one Chat Output to score", async () => {
      const res = await request.get(`${EVALUATIONS}/check`, { headers, params: { flow_id: flowId } });
      expect(res.status()).toBe(200);
      expect(await res.json()).toEqual({
        blocking: [],
        warnings: [],
        output_vertices: [{ id: ECHO_OUTPUT, name: "Chat Output" }],
        model_pickers: [],
      });
    });

    await test.step("a flow with no output is blocked with no_output", async () => {
      const res = await request.get(`${EVALUATIONS}/check`, { headers, params: { flow_id: lonely } });
      expect(res.status()).toBe(200);
      const report = await res.json();
      expect(report.blocking).toEqual([
        { code: "no_output", message: "Add a Chat Output or Text Output so there is an answer to score.", components: [] },
      ]);
      expect(report.output_vertices).toEqual([]);
    });

    await test.step("its evaluation is created, but starting a run on it is refused 422 no_output", async () => {
      const evaluation = await createEvaluation(
        request,
        headers,
        { flow_id: lonely, dataset_id: dataset.id, scorers: TEXT_SCORERS },
        evaluations,
      );
      const res = await request.post(`${EVALUATIONS}/${evaluation.id}/runs`, { headers, data: {} });
      expect(res.status()).toBe(422);
      expect((await res.json()).detail.issues.map((issue: { code: string }) => issue.code)).toEqual(["no_output"]);
    });

    await test.step("an unknown flow is 404", async () => {
      const res = await request.get(`${EVALUATIONS}/check`, {
        headers,
        params: { flow_id: "00000000-0000-4000-8000-000000000000" },
      });
      expect(res.status()).toBe(404);
      expect((await res.json()).detail).toBe("Flow not found");
    });
  });

  test("estimate counts the rows and no model calls for text scorers", {
    tag: ["@stable", "@api", "@database", "@evals"],
  }, async ({ request, apiCoverage }) => {
    apiCoverage.declare(["POST /api/v1/evaluations/estimate"]);
    const { flowId, dataset } = await seed(request, "estimate");

    const res = await request.post(`${EVALUATIONS}/estimate`, {
      headers,
      data: { flow_id: flowId, dataset_id: dataset.id, scorers: TEXT_SCORERS },
    });
    expect(res.status()).toBe(200);
    expect(await res.json()).toMatchObject({
      items: ROWS.length,
      variants: 1,
      has_agent: false,
      llm_calls: 0,
      judge_calls: 0,
      tokens_low: 0,
      tokens_high: 0,
      cost_low: 0,
      cost_high: 0,
    });
  });

  test("refuses invalid scorers and unknown ids", {
    tag: ["@stable", "@api", "@database", "@evals"],
  }, async ({ request, apiCoverage }) => {
    apiCoverage.declare([
      "POST /api/v1/evaluations",
      "GET /api/v1/evaluations/{evaluation_id}",
      "GET /api/v1/evaluation-runs/{run_id}",
    ]);
    const { flowId, dataset } = await seed(request, "invalid");
    // Asserted on loc and the stable part of msg: since LE-2462 a 422 redacts submitted
    // values inside msg, which turns the scorer type into "[redacted]".
    const refuse = async (scorers: unknown[], loc: Array<string | number>, msgPart: string) => {
      const res = await request.post(EVALUATIONS, { headers, data: { flow_id: flowId, dataset_id: dataset.id, scorers } });
      expect(res.status(), JSON.stringify(scorers)).toBe(422);
      const [entry] = (await res.json()).detail;
      expect(entry.loc).toEqual(loc);
      expect(entry.msg).toContain(msgPart);
    };

    await test.step("an llm_judge with no model", async () => {
      await refuse([{ type: "llm_judge", name: "judge" }], ["body", "scorers", 0], "requires config.model");
    });

    await test.step("two scorers with one name", async () => {
      await refuse([TEXT_SCORERS[0], { type: "contains", name: "exact" }], ["body", "scorers"], "Scorer names must be unique");
    });

    await test.step("an unknown key in a text scorer's config", async () => {
      await refuse([{ type: "exact_match", name: "e", config: { foo: 1 } }], ["body", "scorers", 0], "Unknown config");
    });

    await test.step("no scorer at all", async () => {
      await refuse([], ["body", "scorers"], "at least 1 item");
    });

    await test.step("an unknown evaluation and an unknown run are 404", async () => {
      const unknown = "00000000-0000-4000-8000-000000000000";
      const evaluation = await request.get(`${EVALUATIONS}/${unknown}`, { headers });
      expect(evaluation.status()).toBe(404);
      expect((await evaluation.json()).detail).toBe("Evaluation not found");
      const run = await request.get(`${EVALUATION_RUNS}/${unknown}`, { headers });
      expect(run.status()).toBe(404);
      expect((await run.json()).detail).toBe("Evaluation run not found");
    });
  });

  test("a keyless run scores every row by exact_match, contains and the threshold", {
    tag: ["@stable", "@api", "@database", "@evals"],
  }, async ({ request, apiCoverage }) => {
    apiCoverage.declare([
      "POST /api/v1/evaluations",
      "POST /api/v1/evaluations/{evaluation_id}/runs",
      "GET /api/v1/evaluation-runs/{run_id}",
      "GET /api/v1/evaluation-runs/{run_id}/results",
      "GET /api/v1/evaluation-runs/{run_id}/results/{result_id}",
      "GET /api/v1/evaluation-runs/{run_id}/export",
      "GET /api/v1/evaluations/{evaluation_id}",
      "GET /api/v1/evaluations",
      "GET /api/v1/evaluations/{evaluation_id}/runs",
    ]);
    const { flowId, dataset } = await seed(request, "run");
    let evaluation: EvaluationRead;
    let run: EvaluationRunRead;

    await test.step("the evaluation echoes its scorers with default weight and threshold", async () => {
      evaluation = await createEvaluation(
        request,
        headers,
        { flow_id: flowId, dataset_id: dataset.id, scorers: TEXT_SCORERS },
        evaluations,
      );
      expect(evaluation).toMatchObject({ flow_id: flowId, dataset_id: dataset.id, pass_threshold: 0.5, last_run: null });
      expect(evaluation.scorers).toEqual(TEXT_SCORERS.map((s) => ({ ...s, weight: 1, config: {} })));
    });

    await test.step("a run starts queued on the pinned draft and the dataset's revision; a second start is 409", async () => {
      run = await startRun(request, headers, evaluation.id);
      expect(run).toMatchObject({
        evaluation_id: evaluation.id,
        status: "queued",
        total_items: ROWS.length,
        flow_version_source: "latest",
        dataset_revision: dataset.revision,
      });
      const second = await request.post(`${EVALUATIONS}/${evaluation.id}/runs`, { headers, data: {} });
      expect(second.status()).toBe(409);
      expect((await second.json()).detail).toBe("This evaluation is already running.");
    });

    await test.step("the run completes with the exact counts and summary", async () => {
      run = await waitForRunEnd(request, headers, run.id);
      expect(run).toMatchObject({
        status: "completed",
        completed_items: 6,
        failed_items: 0,
        passed_items: 4,
        error: null,
      });
      expect(run.summary?.rows).toEqual({ total: 6, errored: 0, decided: 5 });
      expect(run.summary?.pass_rate).toBeCloseTo(0.8, 10);
      expect(run.summary?.scores.exact.mean).toBeCloseTo(0.6, 10);
      expect(run.summary?.scores.contains.mean).toBeCloseTo(0.8, 10);
    });

    await test.step("every row echoes its input and carries the scores the rules predict", async () => {
      const { total, items } = await listAllResults(request, headers, run.id);
      expect(total).toBe(ROWS.length);
      expect(items.map((r) => r.input)).toEqual(ROWS.map((r) => r.input));
      for (const [i, result] of items.entries()) {
        const want = EXPECTED_SCORES[i];
        expect(result.actual_output, `row ${i} echoes its input`).toBe(ROWS[i].input);
        expect(result.error, `row ${i}`).toBeNull();
        expect(result.scores.exact.value, `row ${i} exact`).toBe(want.exact);
        expect(result.scores.contains.value, `row ${i} contains`).toBe(want.contains);
        expect(result.passed, `row ${i} passed`).toBe(want.passed);
      }
      expect(items[5].scores.exact.comment).toBe(NO_EXPECTED);
      expect(items[5].scores.contains.comment).toBe(NO_EXPECTED);

      const detail = await request.get(`${EVALUATION_RUNS}/${run.id}/results/${items[2].id}`, { headers });
      expect(detail.status()).toBe(200);
      expect(await detail.json()).toMatchObject({
        id: items[2].id,
        input: "the quick brown fox",
        expected_output: "quick",
        actual_output: "the quick brown fox",
        passed: true,
      });
    });

    await test.step("the export is one CSV line per result under the scorer columns", async () => {
      const res = await request.get(`${EVALUATION_RUNS}/${run.id}/export`, { headers });
      expect(res.status()).toBe(200);
      expect(res.headers()["content-type"]).toBe("text/csv; charset=utf-8");
      expect(res.headers()["content-disposition"]).toContain(`attachment; filename="evaluation-run-${run.id}.csv"`);
      const body = (await res.body()).toString("utf8");
      expect(body.startsWith(BOM)).toBe(true);
      const lines = body.slice(1).trimEnd().split("\r\n");
      expect(lines[0].startsWith("position,input,expected_output,actual_output,passed,error,exact,exact comment,contains,contains comment,")).toBe(true);
      expect(lines).toHaveLength(ROWS.length + 1);
      const passedColumn = lines.slice(1).map((line) => line.split(",")[4]);
      expect(passedColumn).toEqual(["True", "True", "True", "True", "False", ""]);
    });

    await test.step("the evaluation, the list and the run history name this run as completed", async () => {
      const read = await request.get(`${EVALUATIONS}/${evaluation.id}`, { headers });
      expect(read.status()).toBe(200);
      expect((await read.json()).last_run).toMatchObject({ id: run.id, status: "completed", passed_items: 4 });

      const list = await request.get(EVALUATIONS, { headers, params: { size: 200 } });
      expect(list.status()).toBe(200);
      const listed = (await list.json()).items.find((e: EvaluationRead) => e.id === evaluation.id);
      expect(listed?.last_run?.id).toBe(run.id);

      const runs = await request.get(`${EVALUATIONS}/${evaluation.id}/runs`, { headers });
      expect(runs.status()).toBe(200);
      expect((await runs.json()).items.map((r: EvaluationRunRead) => [r.id, r.status])).toEqual([[run.id, "completed"]]);
    });

    await test.step("the rows left no message in the flow's Playground history", async () => {
      const res = await request.get("/api/v1/monitor/messages", { headers, params: { flow_id: flowId } });
      expect(res.status()).toBe(200);
      expect(await res.json()).toEqual([]);
    });
  });

  test("case_sensitive exact_match fails a case-only mismatch", {
    tag: ["@stable", "@api", "@database", "@evals"],
  }, async ({ request, apiCoverage }) => {
    apiCoverage.declare(["POST /api/v1/evaluations", "GET /api/v1/evaluation-runs/{run_id}/results"]);
    const flowId = await createEchoFlow(request, headers, `ev-case-${uid()}`, { catalog });
    flows.push(flowId);
    const dataset = await createDataset(request, headers, { name: `ev-case-${uid()}` }, datasets);
    await addItems(request, headers, dataset.id, [{ input: "gamma", expected_output: "GAMMA" }, { input: "epsilon" }]);
    let run: EvaluationRunRead;

    await test.step("?run=true creates the evaluation and answers with its queued run", async () => {
      const res = await request.post(EVALUATIONS, {
        headers,
        params: { run: "true" },
        data: {
          flow_id: flowId,
          dataset_id: dataset.id,
          scorers: [{ type: "exact_match", name: "strict", config: { case_sensitive: true } }],
        },
      });
      expect(res.status()).toBe(201);
      run = (await res.json()) as EvaluationRunRead;
      evaluations.track(run.evaluation_id);
      expect(run).toMatchObject({ status: "queued", total_items: 2 });
      expect(run.config.scorers).toEqual([
        { type: "exact_match", name: "strict", weight: 1, config: { case_sensitive: true } },
      ]);
    });

    await test.step("gamma against GAMMA scores 0 and fails; the row with no expected stays undecided", async () => {
      run = await waitForRunEnd(request, headers, run.id);
      expect(run).toMatchObject({ status: "completed", completed_items: 2, passed_items: 0, failed_items: 0 });
      expect(run.summary?.rows).toEqual({ total: 2, errored: 0, decided: 1 });
      expect(run.summary?.pass_rate).toBe(0);
      const { items } = await listAllResults(request, headers, run.id);
      expect(items.map((r) => [r.input, r.scores.strict.value, r.passed])).toEqual([
        ["gamma", 0, false],
        ["epsilon", null, null],
      ]);
    });
  });

  test("cancel stops a run, and a finished run cannot be cancelled again", {
    tag: ["@stable", "@api", "@database", "@evals"],
  }, async ({ request, apiCoverage }) => {
    apiCoverage.declare([
      "POST /api/v1/evaluation-runs/{run_id}/cancel",
      "GET /api/v1/evaluation-runs/{run_id}",
      "GET /api/v1/evaluation-runs/{run_id}/results",
      "GET /api/v1/evaluation-runs/{run_id}/export",
    ]);
    const flowId = await createEchoFlow(request, headers, `ev-cancel-${uid()}`, { catalog });
    flows.push(flowId);
    const dataset = await createDataset(request, headers, { name: `ev-cancel-${uid()}` }, datasets);
    // 500 rows (the per-request maximum) at ~20 ms each: far longer than the time to
    // see three results and cancel, so the cancel always lands mid-run.
    await addItems(
      request,
      headers,
      dataset.id,
      Array.from({ length: 500 }, (_, i) => ({ input: `row-${i}`, expected_output: `row-${i}` })),
    );
    const evaluation = await createEvaluation(
      request,
      headers,
      { flow_id: flowId, dataset_id: dataset.id, scorers: [TEXT_SCORERS[0]] },
      evaluations,
    );
    let run = await startRun(request, headers, evaluation.id);

    await test.step("cancelling mid-run answers cancelled with a finish time", async () => {
      await pollRun(
        () => readRun(request, headers, run.id),
        (r) => r.completed_items >= 3 || isTerminalRunStatus(r.status),
        { describe: "3 scored rows", timeoutMs: 30_000, intervalMs: 250 },
      );
      const res = await request.post(`${EVALUATION_RUNS}/${run.id}/cancel`, { headers });
      expect(res.status()).toBe(200);
      run = (await res.json()) as EvaluationRunRead;
      expect(run.status).toBe("cancelled");
      expect(run.finished_at).not.toBeNull();
      expect(run.completed_items).toBeLessThan(500);
    });

    await test.step("the results stop growing, and the list and the export hold exactly those rows", async () => {
      const first = await readRun(request, headers, run.id);
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const later = await readRun(request, headers, run.id);
      expect(later.status).toBe("cancelled");
      expect(later.completed_items, "no row is scored after the cancel").toBe(first.completed_items);
      expect((await listAllResults(request, headers, run.id)).total).toBe(later.completed_items);
      const exported = await request.get(`${EVALUATION_RUNS}/${run.id}/export`, { headers });
      expect(exported.status()).toBe(200);
      const lines = (await exported.body()).toString("utf8").trimEnd().split("\r\n");
      expect(lines).toHaveLength(later.completed_items + 1);
    });

    await test.step("cancelling it again is 409", async () => {
      const res = await request.post(`${EVALUATION_RUNS}/${run.id}/cancel`, { headers });
      expect(res.status()).toBe(409);
      expect((await res.json()).detail).toBe("The run already finished (cancelled).");
    });
  });

  test("a run pins a retained flow version, and deleting the evaluation releases it", {
    tag: ["@stable", "@api", "@database", "@evals"],
  }, async ({ request, apiCoverage }) => {
    apiCoverage.declare([
      "POST /api/v1/evaluations/{evaluation_id}/runs",
      "PATCH /api/v1/evaluations/{evaluation_id}",
      "DELETE /api/v1/evaluations/{evaluation_id}",
      "GET /api/v1/evaluations/{evaluation_id}",
    ]);
    const { flowId, dataset } = await seed(request, "version");
    const versions = async () => {
      const res = await request.get(`/api/v1/flows/${flowId}/versions/`, { headers });
      expect(res.status()).toBe(200);
      return (await res.json()).entries as Array<{
        id: string;
        version_number: number;
        description: string;
        retained: boolean;
        retained_reason: string | null;
      }>;
    };
    const evaluation = await createEvaluation(
      request,
      headers,
      { flow_id: flowId, dataset_id: dataset.id, scorers: TEXT_SCORERS },
      evaluations,
    );
    let first: EvaluationRunRead;

    await test.step("the flow starts with no versions", async () => {
      expect(await versions()).toEqual([]);
    });

    await test.step("the run snapshots the draft as a version retained for the evaluation", async () => {
      first = await waitForRunEnd(request, headers, (await startRun(request, headers, evaluation.id)).id);
      expect(first.status).toBe("completed");
      const list = await versions();
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({
        id: first.flow_version_id,
        version_number: first.flow_version_number,
        description: "Evaluation run",
        retained: true,
        retained_reason: "evaluation",
      });
    });

    await test.step("a second run of the unchanged flow reuses that version", async () => {
      const second = await waitForRunEnd(request, headers, (await startRun(request, headers, evaluation.id)).id);
      expect(second.status).toBe("completed");
      expect(second.flow_version_id).toBe(first.flow_version_id);
      expect(await versions()).toHaveLength(1);
    });

    await test.step("an edit applies, and the finished run keeps the threshold it ran with", async () => {
      const name = `ev-version-renamed-${uid()}`;
      const res = await request.patch(`${EVALUATIONS}/${evaluation.id}`, { headers, data: { name, pass_threshold: 1 } });
      expect(res.status()).toBe(200);
      const patched = (await res.json()) as EvaluationRead;
      expect(patched).toMatchObject({ name, pass_threshold: 1 });
      expect(patched.last_run?.config.pass_threshold).toBe(0.5);
    });

    await test.step("deleting the evaluation keeps the version but releases it", async () => {
      const del = await request.delete(`${EVALUATIONS}/${evaluation.id}`, { headers });
      expect(del.status()).toBe(204);
      const gone = await request.get(`${EVALUATIONS}/${evaluation.id}`, { headers });
      expect(gone.status()).toBe(404);
      expect((await gone.json()).detail).toBe("Evaluation not found");
      expect(await versions()).toEqual([
        expect.objectContaining({ id: first.flow_version_id, retained: false }),
      ]);
    });
  });
});
