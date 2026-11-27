# API Evals — evaluations, runs and their results

**File:** `tests/tests-automations/regression/api/evals/api-evaluations.spec.ts`

**Last validated:** Langflow 1.14.x (`1.14.0.dev39`)

Owning issue: #2564 (Wave 12 — 1.14 OSS features). Second spec of the evals family, on
top of the datasets helper from #2563 (`docs/api/evals/api-datasets.md`). The UI is
#2565; the version the run retains is deleted from the UI in #2566.

---

## What this test validates *(required)*

An **evaluation** (upstream langflow-ai/langflow#15999, on by default since #16591) runs
a flow over a dataset and scores each row. This spec drives the **14 operations** of the
`evaluations` and `evaluation-runs` families and pins the one property that makes the
feature testable without a model: the text scorers (`exact_match`, `contains`,
`similarity`) call no model, so a deterministic flow evaluated over a dataset whose
expected outputs match on a **known** subset of rows gives an exact oracle.

The flow is an **echo**, built from the live catalog: Chat Input → Chat Output, so the
answer to every row is its input. The dataset is six rows, chosen so each scoring rule
decides at least one row:

| Row | input | expected | exact_match | contains | passed |
|---|---|---|---|---|---|
| 0 | `alpha` | `alpha` | 1 | 1 | `true` |
| 1 | `beta` | `beta` | 1 | 1 | `true` |
| 2 | `the quick brown fox` | `quick` | 0 | 1 | `true` (0.5 ≥ threshold 0.5) |
| 3 | `gamma` | `GAMMA` | **1** (case-insensitive by default) | 1 | `true` |
| 4 | `delta` | `nope` | 0 | 0 | `false` |
| 5 | `epsilon` | *(none)* | `null` | `null` | `null` (undecided) |

Measured contracts (`1.14.0.dev39`, auto-login bearer):

| Operation | Answer |
|---|---|
| `GET /evaluations/check?flow_id=` | `200 {blocking, warnings, output_vertices, model_pickers}`. The echo: nothing blocking, `output_vertices: [{id: "ChatOutput-out", name: "Chat Output"}]`, no model picker. A flow with no output: `blocking: [{code: "no_output", message: "Add a Chat Output or Text Output so there is an answer to score.", components: []}]`. Unknown flow: `404 "Flow not found"`; no `flow_id`: `422` |
| `POST /evaluations/estimate` | `200`, `items` = the dataset's row count; with text scorers only, `llm_calls`, `judge_calls`, every token figure and both costs are `0`, `has_agent: false`, `variants: 1` |
| `POST /evaluations` | `201` `EvaluationRead`, default name `"Evaluation of <flow name>"`, `pass_threshold: 0.5`, every scorer echoed with `weight: 1` and `config: {}`, `last_run: null`. **Creating does not check the flow**: an evaluation of a flow with no output is created. With **`?run=true`** the answer is the **run** (`EvaluationRunRead`, carrying `evaluation_id`), not the evaluation |
| validation | `422`: an `llm_judge` with no `config.model`, two scorers with one name, an unknown key in a text scorer's `config`, an empty `scorers` |
| `POST /evaluations/{id}/runs` | `202`, `status: "queued"`, `total_items` = the row count, the flow version pinned (`flow_version_source: "latest"`), the dataset's current `revision`. A second start while one is active: `409 "This evaluation is already running."`. A flow with no output: `422`, `detail.issues[0].code: "no_output"` |
| `GET /evaluation-runs/{id}` | the run moving `queued` → `running` → `completed` (about 2.5 s for six rows locally); unknown: `404 "Evaluation run not found"` |
| `GET .../results`, `.../results/{result_id}` | one result per row, in position order, with `actual_output`, `scores: {<scorer name>: {value}}`, `passed`, `trace_id`; an undecided row reads `value: null` plus `comment: "No expected output for this row"` |
| `POST /evaluation-runs/{id}/cancel` | `200`, `status: "cancelled"`, `finished_at` set, results frozen at the rows already scored; cancelling a finished run: `409 "The run already finished (cancelled)."` |
| `GET /evaluation-runs/{id}/export` | `200 text/csv; charset=utf-8`, attachment `evaluation-run-<run id>.csv`, a BOM, one line per result |
| `GET /evaluations`, `GET`/`PATCH`/`DELETE /evaluations/{id}`, `GET /evaluations/{id}/runs` | the list and the record carry `last_run`; `PATCH` answers `200`; `DELETE` answers `204`, then `404 "Evaluation not found"` |

Four contract details worth their own asserts, each measured rather than assumed:

**The pass rule is a weighted mean against the threshold, over decided rows only.** Row 2
scores 0 on `exact_match` and 1 on `contains`; with equal weights its mean is 0.5, which
meets the default threshold of 0.5, so it passes. Row 5 has no expected output, so both
scorers answer `null` and the row is **undecided**: `passed: null`, and the run summary
counts it in `rows.total` (6) but not in `rows.decided` (5). So `passed_items` is 4,
`pass_rate` is 4/5 = 0.8, and the per-scorer means are 3/5 = 0.6 (`exact_match`) and
4/5 = 0.8 (`contains`). Each of those numbers is a different rule; the spec asserts them
all, because a regression in any one of them moves only its own number.

**`exact_match` ignores case unless told otherwise.** Row 3 (`gamma` against `GAMMA`)
passes with the default config. With `config: {case_sensitive: true}` the same row scores
0 and fails. The spec asserts both, so a changed default shows up as a red test rather
than as evaluations that silently pass fewer rows.

**A run pins a flow version, retains it, and deleting the evaluation releases it.** The
flow starts with no versions. The first run snapshots the draft as version 1 —
`description: "Evaluation run"`, `retained: true`, `retained_reason: "evaluation"` — and
records its id on the run. A later run of the unchanged draft reuses that same version.
Deleting the evaluation leaves the version in the history with `retained: false`. A
retained version cannot be deleted; that half is #2566's.

**Deleting a flow does not delete its evaluations.** The evaluation survives with
`flow_id: null` (its history is kept on purpose), so this spec deletes every evaluation it
creates explicitly, before the flow, rather than relying on a cascade.

**What this spec does not see.** A run executes the flow server-side, row by row
(`run_graph_internal`, one session per row) under a background job, so no run stream ever
reaches a page and the fixture's flow-error gate has nothing to judge. The row's `error`
and the run's `failed_items` / `summary.rows.errored` are the verdict instead, and the
spec asserts both are empty. The runs also leave no message in the flow's Playground
history (`GET /api/v1/monitor/messages?flow_id=` stays `[]`), which the spec asserts too.

---

## Tags *(required)*

`@stable` `@api` `@database` `@evals`

Keyless: the only scorer that calls a model, `llm_judge`, is exercised only as a
validation refusal. Not provider-dependent (#1216).

---

## Precondition *(required)*

- A Langflow **1.14+** instance at `PLAYWRIGHT_BASE_URL`, auto-login or superuser.
- The evals premise of #2563, through `readEvalsSurface()`: `feature_flags.evals`
  absent → every test skips naming it; `false` → the suite fails.
- The **Chat Input** and **Chat Output** components in the catalog (core components; the
  flow is built from `GET /api/v1/all`, never from a committed asset).

---

## Step by step *(required)*

Seven independent tests over the `request` fixture, each declaring its operations with
`apiCoverage.declare()`. Every test builds its own echo flow and dataset. Cleanup is
id-scoped and ordered: evaluations first (they do not cascade from the flow), then flows,
then datasets.

**Test 1 — `check reports an evaluable flow and blocks a flow with no output`**
1. `GET /evaluations/check` on the echo → `200`, `blocking: []`, `warnings: []`,
   `output_vertices: [{id: "ChatOutput-out", name: "Chat Output"}]`, `model_pickers: []`.
2. On a flow holding only a Chat Input → `blocking` is exactly the `no_output` issue
   with its message; `output_vertices: []`.
3. An evaluation of that flow is still **created** (`201`); starting a run on it is
   refused `422` with `detail.issues[0].code: "no_output"`.
4. An unknown flow id → `404 "Flow not found"`.

**Test 2 — `estimate counts the rows and no model calls for text scorers`**
1. `POST /evaluations/estimate` with `exact_match` + `contains` → `200`, `items: 6`,
   `variants: 1`, `has_agent: false`, and `llm_calls`, `judge_calls`, `tokens_low`,
   `tokens_high`, `cost_low`, `cost_high` all `0`.

**Test 3 — `refuses invalid scorers and unknown ids`**
Each refusal is asserted on its `loc` and on the stable part of its `msg`, never on the
whole message: since LE-2462 a `422` redacts submitted values inside `msg`, which here
replaces the scorer type with `[redacted]`.
1. An `llm_judge` with no model → `422` at `["body","scorers",0]`, `msg` containing
   `requires config.model`.
2. Two scorers named alike → `422` at `["body","scorers"]`, `Scorer names must be unique`.
3. `exact_match` with `config: {foo: 1}` → `422` at `["body","scorers",0]`, `Unknown config`.
4. `scorers: []` → `422` at `["body","scorers"]`.
5. Unknown evaluation → `404 "Evaluation not found"`; unknown run → `404 "Evaluation run
   not found"`.

**Test 4 — `a keyless run scores every row by exact_match, contains and the threshold`**
1. Create the evaluation (`exact_match` + `contains`) → `201`, the scorers echoed with
   `weight: 1`, `pass_threshold: 0.5`, `last_run: null`.
2. Start a run → `202`, `queued`, `total_items: 6`, `flow_version_source: "latest"`,
   `dataset_revision` equal to the dataset's; a second start → `409 "This evaluation is
   already running."`.
3. Poll the run to `completed`: `completed_items: 6`, `failed_items: 0`,
   `passed_items: 4`, `error: null`, `summary.rows: {total: 6, errored: 0, decided: 5}`,
   `summary.pass_rate: 0.8`, `summary.scores.exact.mean: 0.6`,
   `summary.scores.contains.mean: 0.8`.
4. `GET .../results` → six results in position order: each `actual_output` equals its
   `input`, no `error`, and `scores` and `passed` exactly as the table above; row 5 carries
   the `"No expected output for this row"` comment. `GET .../results/{id}` for row 2 returns
   the same row.
5. `GET .../export` → the CSV attachment named after the run, a BOM, the header
   `position,input,expected_output,actual_output,passed,error,exact,exact comment,contains,contains comment,…`,
   and six data lines whose `input` and `passed` columns match the results.
6. The evaluation, the evaluations list and `GET /evaluations/{id}/runs` all name this
   run as completed; the flow's Playground history is still empty.

**Test 5 — `case_sensitive exact_match fails a case-only mismatch`**
1. `POST /evaluations?run=true` with one `exact_match` scorer, `case_sensitive: true`, over
   `gamma`/`GAMMA` and `epsilon`/*(none)* → `201`, and the body is the **run** (it carries
   `evaluation_id` and `status: "queued"`).
2. The run completes with `passed_items: 0`, `rows.decided: 1`, `pass_rate: 0`; `gamma`
   scores 0 and fails, `epsilon` is undecided.

**Test 6 — `cancel stops a run, and a finished run cannot be cancelled again`**
1. Start a run over a 500-row dataset; wait until at least three rows are scored.
2. `POST .../cancel` → `200`, `status: "cancelled"`, `finished_at` set.
3. Read the run twice, three seconds apart: `completed_items` does not move, and
   `GET .../results` holds exactly that many results; the export has that many lines.
4. Cancel again → `409 "The run already finished (cancelled)."`.

**Test 7 — `a run pins a retained flow version, and deleting the evaluation releases it`**
1. The echo flow lists no versions.
2. Run an evaluation to completion → the flow lists exactly one version, whose id and
   number are the run's `flow_version_id` / `flow_version_number`, with
   `description: "Evaluation run"`, `retained: true`, `retained_reason: "evaluation"`.
3. A second run of the unchanged flow pins the **same** version id.
4. `PATCH` the evaluation's name and `pass_threshold` → `200`, both applied; the last run's
   recorded `config.pass_threshold` is still `0.5` (a run keeps the config it ran with).
5. `DELETE` the evaluation → `204`; `GET` → `404 "Evaluation not found"`; the version is
   still listed, now `retained: false`.

---

## Validation criterion *(required)*

Three consecutive passes at `--retries=0 --workers=1`, with:

- the run's counts, summary and every per-row score asserted against the table above, not
  against "something passed";
- the case-sensitivity default proven in both directions;
- the cancel proven by results that stop growing, not by the status alone;
- the retained version tied to the run by id, reused by a second run, and released by the
  delete;
- every refusal asserted on `loc` and on the stable part of `msg` or on `detail`;
- the declared coverage (14 operations) matching what the fixture recorded;
- no evaluation, flow or dataset left behind.

---

## External dependencies *(required)*

- A running Langflow 1.14+ OSS instance at `PLAYWRIGHT_BASE_URL` with
  `feature_flags.evals: true` (the default).
- No provider key, no model, no network egress.
- Upstream sources the contract was read from (`langflow-ai/langflow@release-1.14.0`):
  - `src/backend/base/langflow/api/v1/evaluations.py`
  - `src/backend/base/langflow/services/evaluations/schemas.py`
  - `src/backend/base/langflow/services/evaluations/run_service.py`
  - `src/backend/base/langflow/services/evaluations/row_runner.py`
  - `src/backend/base/langflow/services/evaluations/scorers/text.py`
  - `src/backend/base/langflow/services/evaluations/versioning.py`
  - `src/backend/base/langflow/services/evaluations/results_export.py`
- Repo helpers: `tests/helpers/api/evals/datasets.ts` (#2563),
  `tests/helpers/flows/build-catalog-flow.ts`.
