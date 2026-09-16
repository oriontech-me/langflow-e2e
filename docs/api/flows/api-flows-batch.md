# API Flows — batch create (`POST /api/v1/flows/batch/`)

**File:** `tests/tests-automations/regression/api/flows/api-flows-batch.spec.ts`

**Last validated:** Langflow 1.13.x (`1.13.0.dev14`)

Owning issue: #1699 (Wave 7 — OSS API coverage, `flows` family). Gauge, definitions
and denominator: `docs/api/api-surface-coverage-gauge.md`.

Product defect against step 2, **fixed upstream in `1.13.0.dev14`**: #1807 / `LE-2598`
— see *The defect step 2 caught* below.

---

## What this test validates *(required)*

This spec predates the gauge and had **no spec doc**. Adopting it surfaced a defect in
the spec itself, recorded here because the fix changes what the file asserts:

**Its first test asserted an endpoint that does not exist.** Titled "DELETE
`/api/v1/flows/batch` endpoint — documents actual behavior", it `POST`ed
`{"flow_ids": [...]}` to `/api/v1/flows/batch` (no trailing slash) expecting a *bulk
delete*, and accepted `200`/`204`. Measured on `1.13.0.dev0`:

| Request | Answer |
|---|---|
| `POST /api/v1/flows/batch` (no slash), any body | `405 Method Not Allowed` — the slash-less spelling falls through to `/api/v1/flows/{flow_id}`, which has no `POST` |
| `POST /api/v1/flows/batch/` with `{"flow_ids": [...]}` | `422`, `detail[0].loc === ["body","flows"]`, `type: "missing"` — the endpoint is a **batch create** and wants `flows` |
| `POST /api/v1/flows/batch/` with `{"flows": [<two flow bodies>]}` | `201`, a **list** of the two created flows (full server bodies, `id`s minted) |
| `POST /api/v1/flows/batch/` with `{"flows": []}` | `201 []` |
| `POST /api/v1/flows/batch/` with a name that already exists | `409 {"detail":"Name must be unique"}` (the `workflows-v2-job-lifecycle` spec pins the lock-release half of this, #14634) |

The test was **red** on the current nightly (`got 405. Feature not implemented.`) and,
carrying `@release @regression` without `@stable`, invisible to the daily. The bulk
delete it was looking for is `DELETE /api/v1/flows/` with the ids in the body — measured
and covered in `api-flows-put-and-bulk-delete.md`.

So the file is re-scoped to what the endpoint **is** — **batch create**: the
`{"flows": [...]}` contract, the empty list, the `409` on a duplicate name, and the
slash-less `405` as the trap it is.

**Its second test is dropped, not kept.** Titled "GET `/api/v1/flows` with size=2
returns at most 2 items", it branched on the response shape and, when the body was a
plain array, asserted `length >= 0` — a test that cannot fail. Measured on
`1.13.0.dev0`, `GET /api/v1/flows/?page=1&size=2` **is** a plain array of every flow
(26 on the instance): `page` and `size` are ignored on this build. Pinning that as
expected behaviour would defend a possible defect; asserting the opposite would be red
with no issue behind it; and "the listing contains the flows I created" is already the
contract `api-flows-crud.spec.ts` asserts and declares for `GET /api/v1/flows/`.
Recorded here so the finding is not lost: **the flows listing does not paginate**.

---

## The defect step 2 caught — `LE-2598` (#1807), fixed in `1.13.0.dev14`

Step 2 reads each created flow back by id, and on a loaded instance that read can answer
`404 {"detail":"Flow not found"}` for an id the batch `POST` has just returned. The cause
is not this route: **every write route taking `DbSession` answers its 2xx before the
transaction commits**, so a read issued with the id the write just returned can correctly
find nothing. The mechanism, the five links and the causal proof are documented once in
`docs/api/flows/api-flows-versions.md`; this file records only what is specific to batch
create.

It fired on the 2026-09-10 daily ([run 34478166565](https://github.com/oriontech-me/langflow-e2e/actions/runs/34478166565), triage #1806 → #1807): attempts 0 and 1
failed at `12:47:10.020` and `12:47:11.763`, and attempt 2 passed 1.9 s later — one of
four tests across three routes inside the same 16 s window on shard 3.

**Batch create is the cheapest witness of the mechanism in the suite**, which is why the
instrumentation is worth having here even though the test recovers on retry: the `POST`
returns **two** ids in one transaction, so a window that hides one and not the other
would be visible as a partial batch, and the loop reads them back-to-back with nothing in
between.

**`@stable` stays on.** The test recovered on attempt 2, so the daily's auto-removal
never took the tag. What step 2 gains is attribution — the next occurrence names its own
shape rather than printing `Received: 404`.

**The fix, verified rather than assumed.** `langflow#15078` scopes the session
dependency to the function (`Depends(injectable_session_scope, scope="function")`), so
the commit precedes the response; it back-merged into the 1.13 line between
`1.13.0.dev12` and `1.13.0.dev14`. A green run is not the evidence — the defect never
reproduced locally to begin with. What was measured is the ordering from both sides: the
same gated 300 ms delay between `session_scope`'s `yield` and its `commit` takes this
step from **0/10 on `dev12`** to **10/10 on `dev14`**, with the `POST` latency going from
11-20 ms to 338-366 ms. The delay moved from after the response to inside it. The
instrumentation stays as a regression detector, not as a workaround.

---

## Tags *(required)*

`@api` `@workspace` `@stable`

`@stable` is new: the red test is replaced, not patched, and the family needs no
provider. The old `@release @regression` pair is dropped — neither described the file
(the batch-create contract is not a happy-path deploy gate, and no fixed bug is
re-asserted here).

---

## Step by step *(required)*

One test over the `request` fixture, declaring through `apiCoverage`. Flows created by
the batch are tracked from the `201` list and deleted by id in `afterEach`.

**Test 1 — `batch create makes every flow in the list and refuses a duplicate name`**
1. `POST /api/v1/flows/batch/` with `{"flows": [A, B]}` (two `Date.now()`-suffixed
   names, empty graphs) → `201`, body is an array of length 2, each entry with a UUID
   `id`, the submitted `name`, and `access_type === "PRIVATE"`.
2. `GET /api/v1/flows/{id}` for each → `200` with the same `name` — the flows exist
   server-side, not only in the response. The `200` is asserted unconditionally. On a
   non-`200` the step builds a diagnosis into the assertion's message from two reads —
   the failing response's own `detail` (`describeResponseDetail`) and a second by-id
   read of the same route (`describeFlowReadback`, the #1759 helper). Neither throws,
   both run only on the failing branch, and the assertion is unchanged.

   **The pair narrows the failure to three cases, and two of them are a verdict.** The
   two reads differ by TIME rather than by route, which is what separates rows 1 and 2 —
   and why row 2 is not a verdict: time discriminates only when the second read lands
   *after* the commit window, which two calls issued in the same breath cannot
   guarantee. Row 3 needs neither read beyond the `detail` string:

   | `detail` | second read | shape |
   |---|---|---|
   | `"Flow not found"` | `200` — the row EXISTS | `LE-2598`'s window: the batch's `201` preceded its commit and the row landed between the two reads. **Transient.** |
   | `"Flow not found"` | `404` — not visible to this read | **UNDECIDED**, not a verdict. Either the row is genuinely gone (a commit that never happened, a cross-worker wipe) **or** the window is still open and wider than the gap between these two reads. |
   | `"Not Found"` | either | FastAPI's unmatched-route 404 — `GET /api/v1/flows/{flow_id}` stopped resolving. |

   A read that cannot answer is `UNDECIDED` and claims neither (#1012). The second read
   must never become the asserted one: `expect` runs on the status captured from the
   **first** read, so a row that lands a moment later still fails the test — it just
   says why.

   **Row 2 was measured, and it is why that row says UNDECIDED rather than "not
   `LE-2598`", which is what this table claimed first (#1878).** Replaying this step on
   `1.13.0.dev12` under the family's toggle — a 300 ms delay between `session_scope`'s
   `yield` and its `commit`, gated on a marker file so control and mutation run in the
   same process — gives 10/10 first reads answering `200` in control, **0/10 under the
   delay with BOTH reads negative in all ten**, and 10/10 again on revert. `LE-2598`
   produces row 2 itself. (An earlier draft cited PR #1873's `×2` on this row as
   corroboration; that `×2` is the **two flows** the batch creates, each read once, not
   two reads of one flow — the row stands on the measurement above.)

   The reason is structural rather than an artefact of that experiment: the second read
   is the **same request** as the failing one, same route and same id, issued
   milliseconds later, so a window wider than that gap makes both miss. What separates a
   wipe from a window is a **later** read or the container log, never a second one
   issued in the same breath. Under the natural window — below one HTTP round trip —
   the second read normally lands after the commit and gives row 1, so the forced window
   is orders of magnitude wider; the reading still holds for the case that matters,
   since a failing occurrence has by definition already outlasted a round trip.
3. `POST /api/v1/flows/batch/` with `{"flows": [<A's name again>]}` → `409`,
   `detail === "Name must be unique"`; the flow count is unchanged.
4. `POST /api/v1/flows/batch/` with `{"flows": []}` → `201`, body deep-equals `[]`.
5. `POST /api/v1/flows/batch` (**no** trailing slash) with the valid body → `405`. The
   trap the old test fell into, pinned so the next author does not.

---

## Validation criterion *(required)*

The test passes three consecutive times at `--retries=0 --workers=1`, with the batch
asserted on the created flows being **readable by id** (not only present in the
response), the duplicate refused on status **and** message, the slash-less call
answering `405`, and the declared coverage — `POST /api/v1/flows/batch/` and
`GET /api/v1/flows/{flow_id}` — matching what the fixture recorded. Zero flows left
behind.

For the `LE-2598` instrumentation specifically: forcing step 2's read-back to a
non-`200` must produce a failure message that names the `detail` string **and** the
second read's verdict, and the step must still **fail** — an instrumented assertion
that stops failing is the defect this suite exists to catch, inverted. Neither
diagnostic read is added to `apiCoverage.declare`: they run on the failing branch only,
and the gate fails a declaration the test never issues.

---

## External dependencies *(required)*

- A running Langflow OSS instance at `PLAYWRIGHT_BASE_URL`, auto-login or superuser.
- `src/backend/base/langflow/api/v1/flows.py` — the flows router these operations live in.
- `src/backend/base/langflow/api/v1/flows_helpers.py` — `_new_flow`, which flushes
  without committing (`LE-2598`).
- `src/backend/base/langflow/api/utils/core.py` — `DbSession`, the
  auto-commit-at-teardown session dependency.
- `src/lfx/src/lfx/services/deps.py` — `session_scope`, where the commit actually happens.
- No provider key, no model, no network egress.
