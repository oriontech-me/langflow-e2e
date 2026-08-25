# Workflows v2 — the job lifecycle

**Last validated:** Langflow 1.12.0.dev37 — `langflowai/langflow-nightly@sha256:b672ab7e91981c6f1719b2932bfa7e2255324d4cfac18b7fedf0dbf5722761de`, the digest `:latest` resolves to (`docker inspect --format '{{index .RepoDigests 0}}'`); upstream revision `50340f2a4322eca624b7ef5684237d87f863fc1b`.

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

**No `@stable`.** Two independent reasons, and the first is the disqualifying one:

- **Test 4 is declared failing** (`test.fail()`) against a live product defect. Even declared, it does not belong in a scheduled lane: the day upstream lands the fix it starts reporting *"expected to fail but passed"*, and that alarm should reach a reviewer on a PR, not open a `daily-failure` issue at 05:00.
- The rest is a new spec awaiting a validation cycle, so its bullets are `[-]`.

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

1. `POST /api/v2/workflows` with `{flow_id, input_value: "ping", session_id: <unique>, mode: "sync"}`. Assert `200`, `status === "completed"`, `session_id` equals the submitted session, and `outputs` carries the Chat Output content. *These are the premise: the run finished and the API said so.*
2. `GET /api/v2/workflows?job_id=<job_id>` **once**, immediately — the call a client makes next.
3. Assert `status === "completed"` — it is, which is what makes the rest a contradiction rather than a timing question.
4. Assert `session_id` equals the submitted session and is **not** the flow id. **Fails today.**
5. Assert `outputs` is non-empty. **Fails today.**

**Test 5 — attribution control: the same read is correct once the job's rows settle**

1. Submit a second `mode=sync` run exactly as in Test 4.
2. Poll `GET /api/v2/workflows?job_id=…` for up to 10 s until the response carries the submitted `session_id` **and** non-empty `outputs`.
3. Assert it converged, and assert the converged `session_id` is the submitted one.

This test exists to make Test 4's red **attributable**, and it is the pairing that decides the diagnosis: *Test 4 red + Test 5 green* is the race described above; *both red* is a strictly worse regression — reconstruction dead, the session unrecoverable at any time — and would otherwise be reported as the same finding.

---

## Validation criterion *(required)*

- Tests 1, 2, 3 and 5 pass. **Test 4 fails and is declared to** (`test.fail()`), so the run reports `5 passed` with Test 4 counted as an expected failure; its failure is at the read-back step, with the reported `session_id` equal to the flow id. Should it ever *pass*, Playwright reports *"expected to fail but passed"* — that is the fix landing, and the annotation plus this criterion come off together.
- **Detection is 15/15, and that took a design decision worth keeping.** The settle window is 250–463 ms (median 434), measured over 12 cold jobs. The defect is a race, so the submit and the read-back are issued back to back with no assertion between them — the sequence a real client runs. An earlier draft parsed the submit body and asserted its four premises first, and that work was enough to let the race go the other way: the defect went undetected in 1 of 13 measured runs. Any future edit that reintroduces work between those two calls silently weakens the test to ~92 %.
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
- **Reconstruction** — `src/backend/base/langflow/api/v2/workflow_reconstruction.py`, the module `get_workflow_status` falls back to when the durable `Job.result` blob carries no **outputs** (or an invalid/version-skewed shape, or predates capture) — not when it lacks the session. The two are separate, and reading them as one misreads the spec's assertion: the session comes from `job_metadata["request"]` via `effective_session_id = persisted_request.get("session_id") or flow_id_str`, and reconstruction only supplies it afterwards, in the `if reconstructed.session_id is None` branch (`api/v2/workflow.py:812` and `:860`, measured 2026-08-25 on `release-1.12.0`). It resolves on every ref (blob `418f95f8d0d0` on `main`, `release-1.12.0` and `release-1.11.5`, measured 2026-08-25) and is **older than the behaviour this spec pins**: it landed with #11438 in January 2026, while #14353 is what made it the recovery path. Read the two apart — a resolved path is evidence that a **file** exists, never that the code is in it.
- **Setting** — `src/lfx/src/lfx/services/settings/groups/telemetry.py`, where `sync_result_storage_enabled` is declared (**default off**, the flag-on half scoped out above). Same split as the module: the file resolves on all three refs, the setting itself is 1.12-era — present on `main` and `release-1.12.0`, absent from `release-1.11.5` (measured 2026-08-25), consistent with it arriving in #14512.
- **Fixture** — `tests/assets/flows/chat-io-ok-trace-fixture.json`, via `createRunnableChatFlowViaApi`.
- **No external network, no provider account.**
