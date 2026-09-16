# API Flows — the versions sub-family (`{flow_id}/versions/`)

**File:** `tests/tests-automations/regression/api/flows/api-flows-versions.spec.ts`

**Last validated:** Langflow 1.13.x (`1.13.0.dev14`)

Owning issue: #1699 (Wave 7 — OSS API coverage, `flows` family). Gauge, definitions
and denominator: `docs/api/api-surface-coverage-gauge.md`.

Product defect against step 1, **fixed**: #1777 / `LE-2598`, upstream `langflow#15078`,
in the nightly from `1.13.0.dev14` — see *Known product defect* below. It is why
`@stable` was off, and the measurement that brought it back is there too.

---

## What this test validates *(required)*

The hidden `flow_version_router` — five operations, none in `/openapi.json`, none
driven by any spec, and no documentation of the body shapes anywhere in this repo.
Everything below was measured by probing, which is the point of pinning it:

| Operation | Answer (measured) |
|---|---|
| `GET /api/v1/flows/{id}/versions/` on a fresh flow | `200 {"entries": [], "max_entries": 50}` |
| `POST /api/v1/flows/{id}/versions/` with `{}` | `201 {id, flow_id, user_id, version_number: 1, description: null, created_at, version_tag: "v1"}` |
| `POST … /versions/` with `{"name":"x","description":"probe"}` | `201`, `version_number: 2`, `version_tag: "v2"`, `description: "probe"` — **`name` is ignored**, the tag is derived from the number |
| `GET … /versions/{version_id}` | `200`, the list entry **plus** `data` (the snapshot's `{nodes, edges}`) and `is_deployed` |
| `POST … /versions/{version_id}/activate` | `200` returning the **flow** body (not the version), and the list afterwards holds a **new** entry `version_number: 3`, `description: "Auto-saved before activating v2"` — activation snapshots the current state first |
| `DELETE … /versions/{version_id}` | `204`, empty body |
| `GET … /versions/{unknown}` | `404 {"detail":"Version entry not found"}` |
| `DELETE … /versions/{unknown}` | `404 {"detail":"Version entry <id> not found"}` — the two 404 messages differ |

The auto-snapshot on activate is the load-bearing finding: restoring an old version
is **non-destructive** — the state being replaced is saved as a new version first — and
nothing in the UI or docs says so. A regression that dropped the snapshot would lose
work silently, which is exactly the class of contract worth a test.

---

## Known product defect — `LE-2598` (#1777, in the nightly from `1.13.0.dev14`)

Step 1 reads the versions collection back on the flow the `POST` just created, and
on a loaded instance that read could answer `404 {"detail":"Flow not found"}`. The
cause was not this route: **every write route taking `DbSession` answered its 2xx
before the transaction committed**, so a read-back by `(id, user_id)` could correctly
find nothing.

`_new_flow` does `session.add` → `flush()` → `refresh()` → `return FlowRead` and
never commits; the commit belongs to the `DbSession` dependency
(`session_scope`: `yield session; await session.commit()`), and FastAPI runs a
`yield`-dependency teardown **after** the response has been written to the client.

Proven causally on `1.13.0.dev8`, on an isolated container whose `session_scope`
sleeps 300 ms between the `yield` and the `commit`, gated on a marker file so
control and mutation share one process: replaying step 1 gives **10/10 pass →
0/10 with `404 "Flow not found"` → 10/10 pass**. Measured window (client holds the
`201` → read-back first answers `200`): **8-11 ms idle** — below one HTTP round
trip, hence ~3550 local `POST`→`GET` pairs with zero failures — against **291-296
ms** under the mutation. Two sibling routes break under the same toggle:
`DELETE /flows/{id}` on a just-created id (#1759) and `GET /projects/download/{id}`
(#1807).

### The fix, verified by ordering rather than by a green run

`langflow#15078` scopes the session dependency to the function
(`Depends(injectable_session_scope, scope="function")` in `api/utils/core.py`), so the
teardown that commits runs **before** the response is written. It was merged on
`release-1.12.2` and back-merged into the 1.13 line between `1.13.0.dev12` and
`1.13.0.dev14`; the scoped form is present in the `dev14` image and absent in `dev12`.

A green run proves nothing here — this never reproduced idle. What was measured is the
same gated delay, applied to **this spec's own step 1** (`POST /api/v1/flows/` then
`GET /api/v1/flows/{id}/versions/`), on each image:

| | `1.13.0.dev12` | `1.13.0.dev14` |
|---|---|---|
| step 1 answers `200` on the first read, **un-forced** | 10/10 | 10/10 |
| step 1 answers `200` on the first read, **under the delay** | **0/10** — all `404 {"detail":"Flow not found"}` | **10/10** |
| by-id readback at that moment | `404` × 10 (see the ambiguity below) | n/a |
| the collection answered `200` after | 292-344 ms | n/a |
| `POST` latency under the delay | 11-17 ms — the client is not waiting for the commit | **321-344 ms** — it is |
| marker removed again, same process | 10/10 | 10/10 |

The delay moved from *after* the response to *inside* it. The `POST` latency is what
shows the ordering instead of inferring it.

**What the test does about it: nothing that changes the assertion.** `200` on a
fresh flow's versions collection *is* the contract, so step 1 still asserts it and
must never be softened with a retry, a sleep, a catch or a narrower scope. What it
gains is attribution — on the failing branch it reads the body and the by-id
readback so the next occurrence names its own shape instead of printing
`Received: 404`. Without that, the 2026-09-09 occurrence left `detail` unknown and
cost three dailies of investigation to recover.

---

## Tags *(required)*

`@stable` `@api` `@workspace`

**`@stable` is back on test 1.** The daily's auto-removal took it in `67b6fc39` on
2026-09-09; it is restored on the upstream fix being in
`langflowai/langflow-nightly:latest` and re-validated there — never on a test-side
change, which is what #1777's *Deliverables* forbid. The evidence is the ordering
measurement above, not the burst: un-forced, `dev12` and `dev14` both answer 10/10.

**Test 2 keeps `@stable`, and not because it is immune — it is exposed to the same
window.** `get_single_flow_version` calls `_get_user_flow` before it resolves the
version id, so inside the window test 2's read answers `404 "Flow not found"`
rather than `404 "Version entry not found"`. It simply did not fire on 2026-09-09
(it passed 2 s after test 1's third attempt), so the daily never removed its tag.
It also needs no instrumentation: its assertion already compares the `detail`
string, so the window surfaces as `Received: "Flow not found"` — self-attributing
by construction. That is the shape test 1 lacked.

---

## Step by step *(required)*

Two tests over the `request` fixture, declaring through `apiCoverage`; one flow per
test, deleted by id in `afterEach` (versions go with the flow).

**Test 1 — `versions lifecycle: create, list, read, activate with auto-snapshot, delete`**
1. Create a flow with `data.nodes = []`; `GET {id}/versions/` → `200`,
   `{"entries": [], "max_entries": 50}`. The `200` is asserted unconditionally. On a
   non-`200` the step builds a diagnosis into the assertion's message from two reads:
   the failing response's own `detail` (`describeResponseDetail`) and a by-id readback
   of `GET /api/v1/flows/{id}` (`describeFlowReadback`, the #1759 helper). Neither
   throws, and both run only on the failing branch, so no assertion changes.

   **The pair narrows the failure to three cases, and two of them are a verdict.**
   Both reads are still needed — the `detail` alone cannot reach row 1 at all:

   | `detail` | by-id readback | shape |
   |---|---|---|
   | `"Flow not found"` | `200` — the row EXISTS | `LE-2598`'s window: the `201` preceded the commit, and the row landed between the two reads. **Transient.** |
   | `"Flow not found"` | `404` — not visible to this read | **UNDECIDED**, not a verdict. Either the row is genuinely gone (a cross-worker wipe, a commit that never happened) **or** the window is still open and wider than the gap between these two reads. |
   | `"Not Found"` | either | FastAPI's unmatched-route 404 — the collection route stopped resolving. |

   A readback that cannot answer is `UNDECIDED` and claims neither (#1012). The
   `detail` alone cannot separate rows 1 and 2 — which is the whole reason the
   2026-09-09 occurrence, carrying neither read, cost three dailies.

   **Row 2 was measured, and it is why that row says UNDECIDED rather than "not
   `LE-2598`", which is what this table claimed first.** Under a forced 300 ms window
   on `dev12`, `LE-2598` itself produces row 2 in **10 of 10** trials: both reads land
   inside the window and the row appears 292-344 ms later.

   The mechanism is what makes that a rule rather than one experiment's result: **both
   reads resolve the same `Flow` row by `(id, user_id)`** — the failing `GET
   .../versions/` 404s out of `_get_user_flow`, and the readback 404s out of that same
   row being invisible. A pair of same-row reads cannot separate "not there" from "not
   there *yet*"; what does is a **later** read or the container log, never a second one
   issued in the same breath. #1807 measured the same collapse on the projects family's
   **upload** pair (`docs/api/projects/api-projects-transfer.md`, Test 2). Its Test 1 row
   asserted the opposite and claimed immunity on the grounds that its two reads use
   different keys; #1876 corrected it, measured the same way — 0/10 under the toggle,
   with both reads negative in all ten.

   **How much weight row 2 carries.** Under the *natural* window — 8-11 ms, below one
   HTTP round trip — the second read normally lands after the commit and gives row 1, so
   the forced 300 ms window is ~30× wider than anything measured idle. The
   generalisation holds for the case that matters anyway: a failing occurrence has by
   definition already outlasted a round trip, so its window is wide by construction,
   which is exactly when the pair collapses.
2. `POST {id}/versions/` with `{}` → `201`, `version_number === 1`, `version_tag === "v1"`,
   `description === null`, `flow_id === id`.
3. `PUT /api/v1/flows/{id}` with the flow's `name` (required by PUT — see
   `api-flows-put-and-bulk-delete.md`) and one node in `data.nodes`, so the next
   snapshot differs from the first.
4. `POST {id}/versions/` with `{"name":"ignored","description":"second"}` → `201`,
   `version_number === 2`, `version_tag === "v2"`, `description === "second"`, and **no
   `name` key** in the response.
5. `GET {id}/versions/{v2.id}` → `200`, `data.nodes.length === 1`, `is_deployed` present.
6. `POST {id}/versions/{v1.id}/activate` → `200`, body is the **flow** (`id === flow id`)
   and its `data.nodes.length === 0` — v1's empty graph is now live.
7. `GET {id}/versions/` → `entries.length === 3`; the newest has `version_number === 3`
   and `description === "Auto-saved before activating v1"`; `GET /api/v1/flows/{id}`
   agrees (`data.nodes.length === 0`).
8. `DELETE {id}/versions/{v2.id}` → `204`; the list drops to 2 entries and no longer
   contains `v2.id`.

**Test 2 — `unknown version ids are refused with distinct messages`**
1. Create a flow. `GET {id}/versions/<random uuid>` → `404`, `detail === "Version entry not found"`.
2. `DELETE {id}/versions/<the same uuid>` → `404`, `detail === "Version entry <uuid> not found"`.
3. Recorded rather than judged: the two messages differ in shape; the assertion pins
   each as measured so a unification upstream is noticed, not silently absorbed.

---

## Validation criterion *(required)*

Both tests pass three consecutive times at `--retries=0 --workers=1`, with the
activation asserted on **three** observables (the returned flow state, the auto-
snapshot entry with its exact description, and `GET /flows/{id}` agreeing), the
ignored `name` asserted as absent, and the declared coverage — all five `versions`
operations plus the CRUD/PUT calls issued — matching what the fixture recorded. Zero
flows left behind.

For the `LE-2598` instrumentation specifically — kept after the fix, because an
intermittent product defect is not re-validated by a green run, and because even when
the pair lands on the undecided row it still names the `detail` string and rules out the
unmatched-route shape, which is two of the three questions answered: forcing step 1's read-back to a non-`200`
must produce a failure message that names the `detail` string **and** the by-id readback
verdict, and the step must still fail — an instrumented assertion
that stops failing is the defect this suite exists to catch, inverted. Both reads
are absent from `apiCoverage.declare` on purpose: the gate fails a declaration the
test never issues, so declaring them would redden every green run.

---

## External dependencies *(required)*

- A running Langflow OSS instance at `PLAYWRIGHT_BASE_URL`, auto-login or superuser.
- `src/backend/base/langflow/api/router.py` — the `flow_version_router` include; the endpoint module is hidden from the schema.
- `src/backend/base/langflow/api/v1/flow_version.py` — the five operations, and `_get_user_flow`, whose `detail: "Flow not found"` is the only reachable 404 in the collection route.
- `src/backend/base/langflow/api/v1/flows_helpers.py` — `_new_flow`, which flushes without committing (`LE-2598`).
- `src/backend/base/langflow/api/utils/core.py` — `DbSession`, the auto-commit-at-teardown session dependency.
- `src/lfx/src/lfx/services/deps.py` — `session_scope`, where the commit actually happens.
- No provider key, no model, no network egress.
