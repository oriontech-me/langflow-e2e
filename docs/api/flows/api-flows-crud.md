# API Flows CRUD

**Last validated:** Langflow 1.13.x

---

## What this test validates *(required)*
Validates the full CRUD contract of `/api/v1/flows/` — the endpoint family that backs every flow created in the UI, every flow exported by the MCP server, every integration code snippet (curl/Python) generated from the Publish dropdown, and every external API consumer that programmatically manages flows.

A regression in any of these endpoints silently breaks the editor (saved flows disappear), the MCP integration (server cannot enumerate flows), and the API access modal (codegen targets a broken URL). The spec catches that class of regression by exercising create, read, list, update, delete, and the negative paths around missing/non-existent IDs.

If any of these tests fail against `langflowai/langflow-nightly:latest`, the flow persistence layer or its router has regressed and the next release is at risk.

---

## Tags *(required)*
`@stable` `@release` `@api` `@regression`

**All 9 tests carry `@stable` again.** Test 2 (`GET lists flows and includes the created
one`) lost it at triage of the 2026-09-08 daily (umbrella #1757 → #1759), when it failed
under the same assertion for the second time, and it is restored here on the **upstream
fix** — `langflow#15078`, in the nightly from `1.13.0.dev14` — never on a test-side
change, which is the rule a product verdict carries.

**The evidence is ordering, not a green run.** This defect never reproduced idle — 0/30
serial and 0/80 concurrent while #1759 was open, and 10/10 clean first list reads on both
`1.13.0.dev12` and `1.13.0.dev14` un-forced — so a green burst says nothing about it. The
measurement that does is in *Known product defects* below.

It was quarantined with `test.fixme` at triage (#1761) and **un-quarantined the same day**
(#1768, four hours later) while the tag stayed off, so it kept running in the PR gate and
the full suite with its step-5 diagnostic readable. Be precise about what that bought: the
diagnostic never fired — the test has not failed in any lane since 2026-09-08 — so what
attributed the failure is the same read driven **by hand** under a forced commit window,
which `test.fixme` would not have prevented either. The lift preserved a runnable spec and
the chance of an in-lane reading; the evidence came from the experiment.

Tests 5 and 9 kept `@stable` throughout — they were first occurrences, absorbed by the
daily's retry budget, and while the defect was live they were what said it was still
there.

---

## Step by step *(required)*

The spec runs **9 independent tests** against `/api/v1/flows/` via Playwright's `request` fixture. Each test obtains a Bearer token through `getAuthToken()` (auto-login), creates its own ephemeral flow with a `Date.now()`-suffixed name to avoid collisions, and cleans up via `DELETE` at the end. No global setup/teardown.

---

**Test 1 — `POST creates flow and returns ID`**
1. `POST /api/v1/flows/` with `{ name, description, data, is_component }`
2. Assert HTTP status is `201`
3. Assert response body has a non-empty string `id` and matching `name`
4. Cleanup via `DELETE`

**Test 2 — `GET lists flows and includes the created one`**
1. Create a flow via `POST`
2. `GET /api/v1/flows/`
3. Assert HTTP status is `200` and the response is iterable (array or `{ flows: [...] }`)
4. Assert the freshly created `id` is present in the list with the correct name
5. **When step 4 fails, read `GET /api/v1/flows/{id}` and attach its status together
   with the list's length** — the assertion is unchanged, this only makes the failure
   say which of two different defects it is. `200` there means the row exists and the
   **list** did not return it. `404` means the row is **not visible to a by-id read
   either** — which is not the same as "the row is not there": a write that answered
   before it committed is invisible to both routes (#1881, and the family's measured
   collapse — #1777 / #1876 / #1878). Without this the failure reads
   `expect(received).toBeDefined() / Received: undefined` and names neither.

   **The asymmetry is the point, and it is what makes this readback worth keeping.**
   The read that fails here is the **LIST**, not the by-id route the readback uses, so
   the two reads ask genuinely different questions and the `200` branch stays a
   verdict — that is the attribution #1759 was opened to add.

   Draw that line in the right place: it is **not** *this route versus the siblings*.
   `describe-flow-readback.ts` records that only `api-flows-batch` and `api-invalid-key`
   reissue the **same** request, where the readback adds no second axis at all; on
   `api-flows-versions` and `api-projects-transfer` the failing read differs too, and
   their `200` branches are verdicts for the same reason as this one. What all five
   share is the `404` branch — undecided between *absent* and *written and not yet
   committed*. An editor working the family must not flatten any of those `200`
   branches.

   Here the argument this test needs survives that intact: under a forced window the
   readback answers `404` **too**, so the row is invisible to every read rather than
   missing from one page, and `read_flows` is not the defect.
6. Cleanup

**Test 3 — `GET by ID returns correct flow`**
1. Create a flow via `POST`
2. `GET /api/v1/flows/{id}`
3. Assert HTTP status is `200`
4. Assert `body.id` and `body.name` match the created flow
5. Cleanup

**Test 4 — `PATCH updates flow name and description`**
1. Create a flow via `POST`
2. `PATCH /api/v1/flows/{id}` with `{ name, description }`
3. Assert HTTP status is `200` and the PATCH response reflects both fields
4. `GET /api/v1/flows/{id}` and assert persistence of both fields
5. Cleanup

**Test 5 — `DELETE removes flow and returns 200`**
1. Create a flow via `POST`
2. `DELETE /api/v1/flows/{id}` — a **raw** `DELETE` on purpose: this call's status IS
   the assertion, and `deleteFlow` would absorb a `404` as done and retry one `5xx`
3. Assert HTTP status is `200`
4. **When step 3 fails, attach the response body and the status of `GET
   /api/v1/flows/{id}`** — a `404` from `DELETE` does not say whether the id is wrong
   or the row was merely not visible to that read (see *Known product defect*). The
   `GET` separates the two on its `200` branch; a `404` there is answered alike by a
   wrong id and by a write that has not committed (#1881), so that branch narrows
   nothing and the attribution falls back to shape

**Test 6 — `GET after DELETE returns 404`**
1. Create a flow via `POST`
2. `DELETE /api/v1/flows/{id}`
3. `GET /api/v1/flows/{id}`
4. Assert HTTP status is `404`

**Test 7 — `GET non-existent flow returns 404`**
1. `GET /api/v1/flows/{fakeUUID}` using `00000000-0000-0000-0000-000000000000`
2. Assert HTTP status is `404`

**Test 8 — `POST with missing name returns 422`**
1. `POST /api/v1/flows/` with a body missing the `name` field
2. Assert HTTP status is one of `400` or `422` (FastAPI returns 422 for missing required fields; tolerating 400 keeps the spec robust to backend stack changes)

**Test 9 — `deleted flow does not appear in flows listing`**
1. Create a flow via `POST`
2. `DELETE /api/v1/flows/{id}` — **raw, and its status is asserted `200` before the
   list is read.** This replaces a `deleteFlow` call and is a **strengthening**, not a
   loosening: the helper treats `404` as the desired end state (correct for idempotent
   cleanup, wrong for a test whose subject is the delete contract), so a `404` here
   used to be swallowed and the test then reported *"deleted flow still listed"* —
   accusing the wrong symptom and making one defect look like two. On the 2026-09-08
   daily this test and Test 5 were the same failure seen from two sides
3. `GET /api/v1/flows/`
4. Assert HTTP status is `200` and the deleted `id` is absent from the list
5. **When step 4 fails, attach the status of `GET /api/v1/flows/{id}`** — a `200`
   there is the verdict *"the delete reported success and removed nothing"*. A `404`
   says only that the row is **no longer visible by id**, not that it is gone (#1881):
   the readback is issued milliseconds after the list, so a write that has not
   committed misses both. What settles the database state is a LATER read or the
   container log, never this pair

---

## Known product defects — `LE-2552` and `LE-2598` (both fixed in `1.13.0.dev14`)

Tests 2, 5 and 9 are the three sides of the same sentence — *the HTTP status of a write
is not a post-condition of anything* — and they were filed as two tickets,
[`LE-2552`](https://datastax.jira.com/browse/LE-2552) (this spec, #1759) and
[`LE-2598`](https://datastax.jira.com/browse/LE-2598) (#1777/#1807). **One upstream
commit fixes both**, `langflow#15078`, which scopes the session dependency to the
function (`Depends(injectable_session_scope, scope="function")` in
`api/utils/core.py`) so the teardown that commits runs **before** the response is
written. It was merged on `release-1.12.2` and back-merged into the 1.13 line between
`1.13.0.dev12` and `1.13.0.dev14`.

**The assertions here are the contract and none of them was weakened for it.** What the
tests gained is the ability to say which side fired — and that is kept, because a green
run is not evidence on an intermittent defect and the next one of this family will be
read from a failure message in `results.json`.

### Shape A — the write answered before it committed (`LE-2598`)

Observed by **Test 2** (`POST` → `201`, the list omits the id) and by **Test 5** on the
2026-09-08 daily, where the raw `DELETE` of a just-created id answered `404`. Both are
this shape and not the one below: that id was never deleted twice.

Every write route taking `DbSession` returned its 2xx before the transaction committed:
`_new_flow` does `session.add` → `flush()` → `refresh()` → `return FlowRead` and never
commits; the commit belonged to the teardown of `injectable_session_scope` (the `yield`
dependency wrapping `session_scope`), which FastAPI runs **after** the response has been
written. So `POST` → `201` → the very next
`GET /api/v1/flows/` can correctly not list the flow.

Measured for **this test's own shape** — `POST /api/v1/flows/` then the LIST — with a
300 ms delay inserted between `session_scope`'s `yield` and its `commit`, gated on a
marker file so control and mutation run in the **same process** and a restart cannot be
the confounder:

| | `1.13.0.dev12` (before the fix) | `1.13.0.dev14` (after) |
|---|---|---|
| first list read contains the flow, **un-forced** | 10/10 | 10/10 |
| first list read contains the flow, **under the delay** | **0/10** | **10/10** |
| by-id readback at that moment (the read step 5 performs, driven by hand) | `404` × 10 — invisible to the by-id route **as well**. Not "the row is not there": under this window it had been written and merely not committed, which is exactly what makes both reads miss (#1881) | n/a |
| list showed it after | 276-433 ms (3-4 polls) | n/a |
| `POST` latency under the delay | 9-11 ms — the client is not waiting for the commit | **316-331 ms** — it is |
| marker removed again, same process | 10/10 | 10/10 |

Row three is what attributes the failure #1759 left open, and the strength is worth
stating honestly: the forced window shows this mechanism produces **exactly** Test 2's
observable, while no in-lane failure of Test 2 ever carried a readback, so the 08-19 and
09-08 occurrences are attributed by shape rather than caught in the act. Note what row
three does and does not say — it rules out *the list dropped a row that is otherwise
readable*, and it does **not** establish that the row was absent, since under this very
window it demonstrably was not. The competing explanation is refuted structurally, and
independently of the experiment — `read_flows`
(`api/v1/flows.py`) takes `get_all: bool = True` and the spec calls it unparameterised,
so "the list returned an incomplete page" is not a state that route can be in. The `POST`
latency is what shows the ordering instead of inferring it: the delay moved from *after*
the response to *inside* it.

### Shape B — the delete answered success for a request that removed nothing (`LE-2552`)

Observed by **Tests 5 and 9**, and only when two deletes of the same id overlap. A `404`
from `DELETE` is Shape A; a `200` that removed nothing is this one.

`DELETE` on this route family answered a **success status for a request that removed
nothing**. `_read_flow` runs twice per request — once in the `AuthorizedDeleteFlow`
dependency (`api/v1/authz_route_dependencies.py`, which raises `404 "Flow not found"`
when it returns `None`) and once inside `_delete_operation` (`api/v1/flows.py`,
`delete_flow`). When the calls overlap, the dependency's read lands **before** the
winner commits — so the request enters the handler — and the handler's read lands
**after** it, so `retry_target is None` hits a bare `return` and the handler still
answers `200 {"message": "Flow deleted successfully"}`.

Measured on `1.13.0.dev6` **and** `1.13.0.dev0`, with and without `foreign_keys=ON`,
with and without tracing, at `LANGFLOW_WORKERS=1` (so not multi-worker contention):

| Call | Fan-out | Trials | Result |
|---|---|---|---|
| `DELETE /api/v1/flows/{id}` | 4 | 25 | `200` × 4 — 25/25 |
| `DELETE /api/v1/flows/{id}` | 2 | 40 | `200+200` — 40/40 |
| `DELETE …/versions/{vid}` | 4 | 25 | `204` × 4 — 25/25 |
| `DELETE /api/v1/flows/` (bulk) | 4 | 20 | `deleted: 0+0+0+1` — 20/20 |

Idempotent-DELETE-by-design is refuted by the product itself: the **same** condition —
the row not being there for this request — answers `404` for a never-existed id, `404`
for a second **sequential** delete, and `404` on the versions route in both of those
shapes. Only overlapping calls get `2xx`. The bulk route is unaffected and already
correct, so the right shape exists one route away.

Two consequences for anyone reading a failure here:

- **A `2xx` from `DELETE` is not a post-condition.** Confirm removal with `GET
  /api/v1/flows/{id}` → `404` or by absence from the list — which is what Tests 6 and
  9 do, and why Test 9's own delete is now asserted rather than delegated.
- **A `404` from `DELETE` is not proof the id is wrong.** That is Shape A — the row was
  written and was not yet visible to this request's read.

Test 2's own failure (`POST` → `201`, then the list omits the id) is **not** attributed
to this mechanism — it goes through `read_flows`, a different query, and it did not
reproduce in six local configurations (0/30 serial, 0/80 concurrent, 0/10 `repro-run`,
0/6 daily topology, 0/8 current nightly with tracing, 0/10 with the daily's exact
SQLite pragmas). It is `LE-2598`, measured above; the same scoping fixes both, which is
why all three symptoms clear on the same image.

**Both are fixed on the current nightly**, and the same scoping settles `LE-2552`:
four concurrent `DELETE`s of one flow id answer `200 404 404 404` in 5 of 5 trials on
`1.13.0.dev14`, against `200` × 4 in 25 of 25 before it (#1807). The losing caller's
dependency read now lands after the winner's commit, so it gets the honest `404` the
sequential path always gave.

---

## Validation criterion *(required)*
- All 9 tests pass 5× in a row against `langflowai/langflow-nightly:latest`.
- Status codes match: `POST` returns `201`; `GET`/`PATCH`/`DELETE` on existing flows return `200`; operations against unknown IDs return `404`; missing required fields return `400` or `422`.
- PATCH changes are durable: a subsequent `GET` reflects the new values.
- Deleted flows disappear from both `GET /api/v1/flows/{id}` and the list endpoint.
- Each test cleans up after itself — no orphan flows remain in the database after the suite completes.
- **A failure of Test 2, 5 or 9 names what the backend did.** The distinctive
  observable: the failure message carries the status of `GET /api/v1/flows/{id}` taken
  at the moment of the failure (and, for Test 2, the list's length). A run that fails
  one of those three without that reading has not met this criterion even if the
  assertion itself is right — the whole reason #1759 needed an investigation instead of
  a triage is that the three original messages named none of it. Forced-failure
  evidence for this is the mutation that flips the assertion while the diagnostic still
  prints.
- **A green run is not evidence that this family is gone, and was never accepted as
  such.** `LE-2552`/`LE-2598` never reproduced idle here; what re-validated them is the
  forced-ordering measurement in *Known product defects*, run on the image before the fix
  and on the image with it. If one of the three fails again, read the diagnostic first.
  A `200` with the id absent from the list would be a genuinely new defect in
  `read_flows`. A `404` from the by-id readback is **consistent with** the
  write-before-commit shape returning and does not establish it (#1881) — a
  cross-worker wipe and a row that never committed answer that read alike — so take a
  read after the window, or the container log, before reopening `LE-2598`.

---

## What this test does not cover *(optional)*
- Flow **execution** via `POST /api/v1/run/{flow_id}` — covered by `api-run-flow.spec.ts` and `api-run-with-tweaks.spec.ts`.
- Authentication failure modes (invalid API key, missing token) — covered by `api-invalid-key.spec.ts`.
- Multi-user isolation (one user's flows not visible to another) — out of scope; would require seeding a second user.
- Pagination, ordering, and filter parameters on `GET /api/v1/flows/` — the spec only asserts the unfiltered list contract.
- Flow `data` field validation (nodes/edges schema) — the spec uses an empty data graph.

---

## Preconditions *(optional)*
- Langflow running and reachable at `PLAYWRIGHT_BASE_URL` (default `http://localhost:7860`).
- Auto-login enabled (the default in nightly) so `getAuthToken()` can mint a Bearer token. If auth is reconfigured, the helper at `tests/helpers/auth/get-auth-token.ts` must be updated first.

---

## External dependencies *(required)*
<!-- Files from the Langflow repository that, if changed, could break this test. -->

- `src/backend/base/langflow/api/v1/flows.py` — router that exposes `POST/GET/PATCH/DELETE /api/v1/flows/`; any signature, status code, or response shape change here directly affects the spec.
- `src/backend/base/langflow/services/database/models/flow/model.py` — flow schema (name, description, data, is_component); renaming or removing a field breaks the POST payload and the PATCH/GET assertions.
- `src/backend/base/langflow/api/utils/` — shared API helpers used by the flows router (validation, current-user resolution); changes here can shift 422 vs 400 boundaries.
- `src/backend/base/langflow/api/v1/authz_route_dependencies.py` — resolves the flow for `GET`/`PATCH`/`DELETE` by id and is where the `404 "Flow not found"` originates. It performs the **first** of the two `_read_flow` calls per request; the second is in the router. `LE-2552` lives in the gap between them, so a change to either read (or to the retry that wraps the second one) changes what Tests 5 and 9 observe.
- `src/backend/base/langflow/api/v1/flows_helpers.py` — `_read_flow` itself (owner-scoped unless an authorization plugin widens it) and `_new_flow`; the query that decides whether a just-written row is visible to the next read.
- `src/backend/base/langflow/api/utils/core.py` — where `DbSession` is declared. `LE-2598` was the absence of `scope="function"` on this `Depends`, which put the commit in a teardown FastAPI runs after the response; dropping it again makes Test 2 fail exactly as it did on 2026-08-19 and 2026-09-08.
- `src/lfx/src/lfx/services/deps.py` — `session_scope` (the `@asynccontextmanager` carrying the `commit`) and `injectable_session_scope`, the `yield` dependency wrapping it; `LE-2598` was that dependency's teardown running after the response.

---

## Coverage declarations (#1699)

Since the API coverage gauge landed (#1692, `docs/api/api-surface-coverage-gauge.md`),
this spec **declares** the operations it asserts through the `apiCoverage` fixture:
`POST /api/v1/flows/`, `GET /api/v1/flows/`, `GET /api/v1/flows/{flow_id}`,
`PATCH /api/v1/flows/{flow_id}`, `DELETE /api/v1/flows/{flow_id}`. No assertion
changed. A declaration the test never issues fails it, so the declaration cannot be
wrong silently — and the five operations now count in `npm run api:coverage`, where
they counted for nothing before despite being driven as contracts here since the
spec was written.
