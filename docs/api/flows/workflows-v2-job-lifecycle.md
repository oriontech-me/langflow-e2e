# Workflows v2 — the job lifecycle

**Last validated:** Langflow 1.14.0.dev35 — `langflowai/langflow-nightly@sha256:a2f75e01e05dfecba01bc54bde43bdbf38b6e21e9b322666a2f657cef0d08fa9`, the digest `:latest` resolves to (`docker inspect --format '{{index .RepoDigests 0}}'`). Re-measured for #2216, which redesigned Test 4's declaration; Tests 1–3 and 5 were last measured on 1.13.0.dev7, the version the nine #1784 dispatches ran against.

---

## What this test validates *(required)*

Validates the **job lifecycle** of `POST /api/v2/workflows` — submit, then read the job back through `GET /api/v2/workflows?job_id=…` — and the **conflict contract** of `POST /api/v1/flows/batch/`.

`POST /api/v2/workflows` is the run path the product itself uses: the flow editor, the playground and every agent run go through it. This suite already **observes** that path — `tests/fixtures/flow-error-policy.ts` classifies its stream and eight specs trigger it incidentally — but nothing **drives it as an API contract**. The only spec addressing the endpoint directly is `security/tweaks-graph-path-floor.spec.ts` (#1567), and it covers the tweaks floor, not the lifecycle. So the submit half is exercised constantly and the read-back half is exercised by nothing.

That read-back half is where three upstream PRs on `release-1.12.0` changed behaviour:

| Upstream | What it changed |
|---|---|
| [#14353](https://github.com/langflow-ai/langflow/pull/14353) | `GET`-status reads the durable `Job.result` blob first; `vertex_build` reconstruction becomes the recovery path. The completed response preserves the submitted `session_id`, falling back to the flow id. |
| [#14512](https://github.com/langflow-ai/langflow/pull/14512) | Fixes completed `mode=sync` runs reporting `session_id == flow_id` on `GET` — *"a regression from #14353"*. Adds `sync_result_storage_enabled` (**default off**); with it off, the session is meant to resolve through `vertex_build` reconstruction. |
| [#14634](https://github.com/langflow-ai/langflow/pull/14634) | `POST /api/v1/flows/batch/` builds `Flow` rows directly instead of going through `_new_flow`, which pre-deduplicates names — so a duplicate reached `session.flush()` as an unhandled `UNIQUE` violation. On SQLite the failed `INSERT` was never rolled back and **held the write lock for the full 30 s `busy_timeout`**, so a duplicate surfaced as *"database is locked"* on the *next* writer; the unhandled exception also **leaked the SQL statement and its bound parameters** to the caller. |

**The `session_id` is not cosmetic.** It is the key message memory and chat history scope to, so a status read that reports the wrong one hands the caller a thread that is not the one that ran.

Three of the four axes below are green on the measured build. The fourth is **red on purpose** — see *The sync defect* — and the file is designed so that a red there is attributable rather than ambiguous.

---

## Tags *(required)*

`@api` `@regression`

No **functional** tag applies, following the `api/flows/` family: `api-run-with-tweaks`, `api-run-flow`, `api-flows-crud` and `api-key-expiry-enforcement` all carry cross-cutting tags only, because the tag table's functional axis names product areas (playground, agents, MCP…) and this is the transport layer under all of them. `@api` marks the layer; `@regression` is what #1575 asks for — every axis here pins a specific upstream fix.

**All five tests are `@stable`.** Tests 1, 2, 3 and 5 were promoted by #1786 after nine 3/3-green `manual.yml` dispatches. Test 4 was promoted with them, quarantined by #2216 (`test.fixme`, `@stable` removed) and restored by #2216's redesign.

This doc used to argue that Test 4 does not belong in a scheduled lane: when the fix lands, the *"expected to fail but passed"* alarm should reach a reviewer on a PR, not open a `daily-failure` issue. #1786 overruled that, for a reason the argument missed: the PR lane selects specs by import graph, so it runs this file only when a PR touches it. Without a scheduled lane, nothing would run Test 4 on the day upstream fixes the defect. The daily is the lane where the fix alarm can actually fire.

That only works if the declaration is deterministic. A declaration that loses the race now and then turns a day with no change into a red day, which is the #2216 flake. See *The sync defect* and the *Validation criterion*.

**Why Test 4 is `test.fail()` rather than a plain red.** The assertions are identical either way — `test.fail()` inverts the *verdict*, never the assertion, so nothing is weakened. What it buys is the half a plain red does not have: **the fix becomes detectable**. A permanent red is a signal that decays — it fails every run, reviewers learn its name, and the day it starts passing nobody notices. Declared failing, the fix arrives as a *new* red (`expected to fail but passed`) asking for the annotation back.

This suite rejects `test.fail()` elsewhere, and the reason is sound: `mcp/client/mcp-client-agent-gemini-tool-regression.spec.ts` records that it *"converts ANY failure (a broken bootstrap, a down instance, an unregistered MCP server) into a green 'expected failure'"*. That objection is answered here **by construction, not by argument**: Test 5 issues the same submit and the same read-back, against the same flow, through the same helpers, and is not declared failing. A broken bootstrap or a dead instance reddens it — and Tests 1–3 — instead of disappearing into Test 4's declaration.

Not `@destructive`: the file creates and deletes only its own flows and sets no instance-wide state. (`sync_result_storage_enabled=true` **would** be instance-global — scoped out below.)

---

## Measured contract *(required reading)*

Every figure below was measured against `1.12.0.dev37` with the instance identity asserted first (`GET /api/v1/version` → `package: "Langflow Nightly"`), because a shadowed port silently answers as a different instance — the trap that invalidated a whole measurement pass on #1567.

### `POST /api/v1/flows/batch/` — all green

| Request | Observed |
|---|---|
| `{flows: [A, B]}`, unique names | `201`, both rows created |
| `{flows: [D, D]}`, duplicate name in one payload | `409` `{"detail":"Name must be unique"}` **in 18 ms** |
| `{flows: [E]}` where `E`'s name already exists | `409`, same message, 12 ms |
| `{flows: [x1, x2]}` sharing an `endpoint_name` | `409` `{"detail":"Endpoint name must be unique"}` |
| a plain `POST /api/v1/flows/` right after a `409` | `201` in 14 ms |

The last row is the load-bearing one. A `409` that left the write lock held would satisfy every other assertion in this file and still be the exact defect #14634 fixed — the caller sees a clean conflict and the *next* writer dies 30 s later with an unrelated-looking error. Asserting that the following write simply succeeds is enough, and is preferable to a duration threshold: if the lock were held, that request would stall out rather than return `201`.

The **absence of SQL** in the `409` body is asserted for the same reason it was fixed: an unhandled `IntegrityError` renders the statement and its bound parameters, so the failure mode is a leak, not just an ugly message. Nothing else in this suite would notice.

### `POST /api/v2/workflows` `mode=background` — green

The first `GET` that reports `status: "completed"` already carries the submitted `session_id` and the populated `outputs`. This path persists `job_metadata["request"]` at submit time, so the session is read back from storage rather than reconstructed.

### `POST /api/v2/workflows` `mode=sync` — **red**

`sync_result_storage_enabled` reads `False` (its default) and `vertex_builds_storage_enabled` reads `True`, so the reconstruction path #14512 documents is the live one. Yet:

```
POST /api/v2/workflows  {mode: "sync", session_id: "ses-38b014ff"}
  → 200  status="completed"  session_id="ses-38b014ff"  outputs=[ChatOutput-…]

GET  /api/v2/workflows?job_id=<that job>        ← the obvious next call
  → 200  status="completed"  session_id="<flow_id>"  outputs=[]
                                                     output={reason:"none", text:null}
```

Reproduced 15/15 through the spec. It **self-heals in 250–463 ms** — median 434 ms, 12 of 12 cold jobs, each on its own freshly created flow — so a caller that polls converges and a caller that reads once loses the session *and* every output. The window is narrow, which is what makes the ordering of the two calls a design constraint rather than a detail (see *Validation criterion*).

**The race is sometimes won, and that is what #2216 is about.** The 15/15 figure did not hold over time. On the QA VM lane, the single-job version of Test 4 passed its first attempt on two dailies (`1.13.0.dev16` on 2026-09-18 and `1.13.0.dev35` on 2026-10-07), so a declared-failing test went red on days when nothing had changed. Re-measured on `1.14.0.dev35` (2026-11-22, local Docker, one worker):

| Measurement | Defect reproduced | Race won |
|---|---|---|
| The single-job Test 4, `--repeat-each=30 --retries=0` | 26 / 30 | 4 / 30 (13 %) |
| A probe running the same POST → GET pair, 5 fresh flows × 20 jobs | 89 / 100 | 11 / 100 (11 %) |

The wins in the probe are spread out. There are no consecutive wins, and the job's position on its flow makes no difference (job 1 won 2 of 5 times, later positions 0–2 of 5). So each job is an independent draw with a win rate of about 11 %. A submit takes a median 64 ms and the read-back 20 ms, so one pair costs under 100 ms. The defect is still live on `1.14.0.dev35`; the wins are not an upstream fix.

Mechanism, read from `langflow/api/v2/workflow.py` inside the image (the `COMPLETED` branch): with the flag off `job_metadata` is `null`, so `effective_session_id = flow_id_str`; `job.result` is `null`, so the primary path is skipped; `reconstruct_workflow_response_from_job_id` then raises `ValueError("No vertex builds found for job_id …")` because the `vertex_build` rows have not committed yet, and the `except` arm returns an empty response carrying the flow id. The reconstruction itself is **correct** — a later `GET` on the same job returns the submitted session and the outputs, and the stored blob carries `session_id` at `results.message.data.session_id`, exactly where `_recover_session_id` looks.

What rules out *"eventual consistency, working as intended"*: **the same response body asserts `status: "completed"` while reporting no outputs**, and `mode=background` answers correctly on its first completed `GET`. A caller cannot distinguish this from a run that genuinely produced nothing.

No upstream issue exists for it; a ticket is drafted alongside this spec and not filed, by the reporter's decision.

---

## Step by step *(required)*

Five tests via Playwright's `request` fixture, sharing one flow created in `beforeAll`. No browser, no LLM, no provider key.

**Setup (`beforeAll`)**
1. `getAuthToken(request)` → bearer token, used as `Authorization` on every call (the v2 workflow routes accept it; unlike `POST /api/v1/run/{id}` no `x-api-key` is minted).
2. `createRunnableChatFlowViaApi(request, { Authorization: bearer })` → a `Chat Input → Chat Output` passthrough flow. It echoes its input, so a run's output text is deterministic with no provider configured.

**Teardown (`afterAll`)**
Delete the shared flow plus every flow the batch tests created, each by id, in nested `try/finally` so one failure cannot strand the rest. Batch-created ids are collected as the tests run.

---

**Test 1 — a duplicate name is refused `409`, leaks no SQL, and leaves the next write working**

1. `POST /api/v1/flows/batch/` with `{flows: [A, B]}` carrying two unique names. Assert `201` and that two ids came back; record them for teardown. *This control comes first: without it, every assertion below is equally consistent with the batch endpoint being broken outright.*
2. `POST` again with `{flows: [D, D]}` — the same name twice in one payload. Assert `409` and `detail === "Name must be unique"`, asserted exactly so this guard cannot later collapse onto the endpoint-name one.
3. Assert the raw response body contains none of `INSERT`, `SELECT`, `UNIQUE constraint`, `sqlalchemy`, `[SQL:` or `parameters:` — the leak #14634 closed.
4. `POST /api/v1/flows/batch/` with `{flows: [E]}` where `E` reuses the name of a flow created in step 1. Assert `409` with the same message — a name already committed is a different code path from two names inside one flush.
5. `POST /api/v1/flows/` (the singular endpoint) with a fresh unique name. Assert `201` — the rollback released the write lock. Record the id for teardown.

**Test 2 — a duplicate `endpoint_name` is refused with its own message**

1. `POST /api/v1/flows/batch/` with two flows carrying distinct names and the **same** `endpoint_name`. Assert `409` and `detail === "Endpoint name must be unique"`.
2. Assert that message is **not** `"Name must be unique"` — two guards, two strings; a regression collapsing them would still return `409` and would still pass Test 1.
3. Assert no SQL in the body, as in Test 1.

**Test 3 — a completed background run reports the session it was given**

1. `POST /api/v2/workflows` with `{flow_id, input_value: "ping", session_id: <unique>, mode: "background"}`. Assert `200`, a `job_id`, and `status: "queued"`.
2. Poll `GET /api/v2/workflows?job_id=<job_id>` until `status === "completed"` (bounded; the measured run completes on the first or second poll).
3. On that **first completed** response assert: `session_id` equals the submitted session; `session_id` is **not** the flow id — the specific degradation #14512 names, so the assertion is not vacuous; `outputs` carries the Chat Output node key, and its content is the echoed `"ping"`.

**Test 4 — a completed sync run answers its own status query with what it just returned** *(expected red)*

The title is unchanged since #1575 even though the test now runs 10 jobs: the daily history and the `@stable` orphan reconciler both match tests by title.

1. Run **10** sync jobs one after another. For each one, with a unique `session_id`:
   - `POST /api/v2/workflows` with `{flow_id, input_value: "ping", session_id: <unique>, mode: "sync"}`;
   - read its `job_id`, and `GET /api/v2/workflows?job_id=<job_id>` **once**, immediately: the call a client makes next.

   Nothing else happens between a submit and its read-back. Every assertion is deferred until all 10 pairs have answered, and the next pair starts as soon as the previous read-back returns.
2. Record, as a test annotation, how many of the 10 read-backs came back degraded (`session_id` not the submitted one, or no Chat Output). The count is computed before any assertion runs, so it is reported even when the test fails at the first job.
3. For each of the 10 submits, assert `200`, `status === "completed"`, `session_id` equals its submitted session, and `outputs` carries the Chat Output content. *These are the premise: every run finished and the API said so.*
4. For each of the 10 read-backs, assert `200` and `status === "completed"`. They all are, which is what makes the rest a contradiction rather than a timing question.
5. For each of the 10 read-backs, assert `session_id` equals its submitted session and is **not** the flow id, and that `outputs` carries the Chat Output content `"ping"`. **Fails today**, on the first job that lost the race. Every assertion message names the job's index.

**Test 5 — attribution control: the same read is correct once the job's rows settle**

1. Submit a second `mode=sync` run exactly as in Test 4.
2. Poll `GET /api/v2/workflows?job_id=…` for up to 10 s until the response carries the submitted `session_id` **and** non-empty `outputs`.
3. Assert it converged, and assert the converged `session_id` is the submitted one.

This test exists to make Test 4's red **attributable**, and it is the pairing that decides the diagnosis: *Test 4 red + Test 5 green* is the race described above; *both red* is a strictly worse regression — reconstruction dead, the session unrecoverable at any time — and would otherwise be reported as the same finding.

---

## Validation criterion *(required)*

- Tests 1, 2, 3 and 5 pass. **Test 4 fails and is declared to** (`test.fail()`), so the run reports `5 passed` with Test 4 counted as an expected failure; its failure is at the read-back step, with the reported `session_id` equal to the flow id. Should it ever *pass*, Playwright reports *"expected to fail but passed"* — that is the fix landing, and the annotation plus this criterion come off together.
- **Test 4's declaration must be deterministic, so the contract is asserted over 10 jobs, not one (#2216).** Each job is an independent draw that wins the race about 11 % of the time (*The sync defect*). A single-job test therefore "passed" about 1 run in 8 while the defect was live, and on a scheduled lane that reads as the fix landing. With 10 jobs the declared failure holds unless every job wins: about 3 × 10⁻¹⁰ at the measured 11 %, and about 6 × 10⁻⁶ even if a faster host pushed the win rate to 30 %. The fix, by contrast, makes every read-back correct, so all 10 pass and the alarm fires deterministically. The extra cost is under one second.
- **The annotation shows a partial fix before it shows as a pass.** It reports `k of 10` read-backs degraded on every run. If upstream narrows the window without closing it, `k` drops before the test ever flips to an unexpected pass.
- **The no-work-between rule still applies to each pair.** The settle window is 250–463 ms (median 434), measured over 12 cold jobs. The submit and its read-back are issued back to back with no assertion between them, the sequence a real client runs. An earlier draft asserted the submit's premises first, and that alone let the race go the other way in 1 of 13 runs. Any future edit that puts work between the two calls raises every job's win rate, which the 10-job margin hides until it does not.
- Test 1's control (step 1) passes, so the `409`s are refusals and not a broken endpoint.
- Test 3's first completed response carries the submitted session — proving the endpoint *can* do this, which is what makes Test 4 a defect rather than an unsupported feature.
- Test 5 converges within 10 s, so Test 4's red is the race and not a dead reconstruction path.
- No orphan flows: `GET /api/v1/flows/?remove_example_flows=true` returns the same count before and after the file runs.
- No `🚨 Backend Error:` in the log — and, for this file, that is a weaker statement than it looks: see *Preconditions*.

---

## What this test does not cover *(and why)*

- **`sync_result_storage_enabled=true`** — the flag-on half of #14512, where the submit request is persisted to `job_metadata` before `Job.result` and the cached blob must carry the session while carrying **no** `tweaks` or `globals`. The setting is instance-global, so it needs a dedicated container; a spec gated on it would skip on every lane and could never be `@stable` (#1010). The keyless default-off path is the one every lane actually runs.
- **`mode=stream`** — its read-back is the event stream, not the status endpoint; `tweaks-graph-path-floor.spec.ts` already drives that surface.
- **`/api/v2/workflows/stop`, `/resume`, `/pending`** — separate surfaces with their own lifecycles (HITL suspend/resume is #14353's third axis).
- **The 30 s SQLite lock timing itself.** #14634's pre-fix symptom was a stall, but asserting a duration bound would make the test a performance assertion on shared CI hardware. Step 5's plain `201` proves the lock released without one.

---

## Preconditions *(required)*

- A running Langflow instance reachable at `PLAYWRIGHT_BASE_URL`, on the nightly image.
- Auto-login superuser (the suite's default), for `getAuthToken`.
- **No provider key, no model, no browser.** Every test is `request`-only against a Chat Input → Chat Output flow.
- **No `allowHttpErrors()` is needed, and the reason is worth stating rather than assuming.** The batch tests drive `/api/v1/flows/batch/` into a deliberate `409`, and the HTTP-error policy reports every 4xx/5xx on an `/api/` route — but it is wired to `page.on("response")`, so it only ever sees browser-driven traffic. Every request in this file goes through Playwright's `request` fixture, which never passes through a `page`, so none of it reaches the monitor at all. The same is true of every sibling in `api/flows/` — none calls `allowHttpErrors()`, including `api-invalid-key.spec.ts`, which exists to provoke a `401`/`403`.

  The honest consequence: for a `request`-only spec, checklist step 4 ("confirm no backend error was logged") carries no information — the log would be empty whether the endpoint answered `409` or `500`. What replaces it here is that every call asserts its own status explicitly, so an unexpected `500` fails the test rather than passing quietly into a log nobody reads.

---

## External dependencies *(required)*

- **Langflow API** — `POST /api/v1/flows/`, `POST /api/v1/flows/batch/`, `DELETE /api/v1/flows/{id}`, `POST /api/v2/workflows`, `GET /api/v2/workflows?job_id=`, `GET /api/v1/version`.
- **Upstream source** — `src/backend/base/langflow/api/v2/workflow.py` (the `COMPLETED` branch of `get_workflow_status`, which resolves `effective_session_id` and falls back to reconstruction) and `src/backend/base/langflow/api/v1/flows.py` (`POST /flows/batch/`, `_handle_unique_constraint_error`).
- **Reconstruction** — `src/backend/base/langflow/api/v2/workflow_reconstruction.py`, the module `get_workflow_status` falls back to when the durable `Job.result` blob carries no **outputs** (or an invalid/version-skewed shape, or predates capture) — not when it lacks the session. The two are separate, and reading them as one misreads the spec's assertion: the session comes from `job_metadata["request"]` via `effective_session_id = persisted_request.get("session_id") or flow_id_str`, and reconstruction only supplies it afterwards, in the `if reconstructed.session_id is None` branch. Both anchors are in `api/v2/workflow.py` and each is unique to a `grep -n`, which is how they are cited here on purpose: that region took 16 commits in 60 days and the two lines sat at five distinct positions in 20 days — they are at 812/860 on `release-1.12.0` and 732/780 on `main` (measured 2026-08-25), so a line number would rot while the symbol does not. It resolves on every ref (blob `418f95f8d0d0` on `main`, `release-1.12.0` and `release-1.11.5`, measured 2026-08-25) and is **older than the behaviour this spec pins**: it landed with #11438 in January 2026, while #14353 is what made it the recovery path. Read the two apart — a resolved path is evidence that a **file** exists, never that the code is in it.
- **Setting** — `src/lfx/src/lfx/services/settings/groups/telemetry.py`, where `sync_result_storage_enabled` is declared (**default off**, the flag-on half scoped out above). Same split as the module: the file resolves on all three refs, the setting itself is 1.12-era — present on `main` and `release-1.12.0`, absent from `release-1.11.5` (measured 2026-08-25), consistent with it arriving in #14512.
- **Fixture** — `tests/assets/flows/chat-io-ok-trace-fixture.json`, via `createRunnableChatFlowViaApi`.
- **No external network, no provider account.**
