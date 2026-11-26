# API Flows — the flow save precondition (`If-Match`, `409 flow_version_conflict`, fork, overwrite)

**File:** `tests/tests-automations/regression/api/flows/flow-version-precondition.spec.ts`

**Last validated:** Langflow 1.14.x (`1.14.0.dev32`)

Owning issue: #2341 (Wave 11 — Multi-edit, instance migration & integrations; tracker #2356).
Upstream feature: multi-edit safety, `langflow-ai/langflow#14903`, follow-up `#15824`.

---

## What this test validates *(required)*

Multi-edit safety turns a flow save into a conditional write. The client sends the
`version_token` it loaded as `If-Match`. When the row has moved on since then, the
server refuses the write with `409` instead of overwriting whoever saved in between.
Every other multi-edit behaviour depends on this contract (the conflict banner, the
review dialog, *Duplicate Flow*, *Keep my version*), and nothing else asserts it.

Every row below was measured with `curl` on `1.14.0.dev7` before any assertion was
written:

| Request | Answer (measured) |
|---|---|
| `GET /api/v1/flows/{id}/version-state` | `200 {version_token, last_modified_by, last_modified_by_username, updated_at}` |
| `PATCH /api/v1/flows/{id}`, graph change, `If-Match: <current>` | `200`, and the row gets a **new** `version_token` |
| the same `PATCH`, `If-Match: <old>` | `409`, `detail` = `{code: "flow_version_conflict", message, flow_id, expected_version_token, current_version_token, modified_by: {id, username}, modified_at}` |
| `If-Match: not-a-uuid` | `400 {"detail": "Invalid If-Match header: expected a version token"}` |
| `If-Match: "<current>"` and `If-Match: W/"<current>"` | `200`, both accepted |
| no `If-Match` at all | `200`, saved (ADR-002: the precondition is optional) |
| 6 parallel `PATCH`es, same token | exactly **one** `200`, five `409`, no `5xx` |
| `POST /api/v1/flows/{id}/fork` | `201`, a new flow named `<source> (copy)`; `endpoint_name: null`, `webhook: false`, `mcp_enabled: false`, `access_type: "PRIVATE"`; the source's `name`, `data` and `version_token` are unchanged |
| `POST /api/v1/flows/{id}/overwrite`, no `If-Match` | `428`, *"Overwriting requires an If-Match header naming the version you reviewed…"* |
| `POST … /overwrite`, `If-Match: <current>` | `200`, and `GET /api/v1/flows/{id}/versions/` gains an entry with `description: "Replaced by a newer edit"` |
| `POST … /overwrite`, `If-Match: <old>` | `409` |

The issue left the history route open (*"or whatever route lists the history"*).
It is the existing `GET /api/v1/flows/{id}/versions/`. Its full contract is pinned
by `api-flows-versions.spec.ts`, so this spec only reads the one entry that
`overwrite` adds.

### Facts that shape the assertions

- **Only a graph change takes the write turn** (`_patch_flow`:
  `graph_changed = "data" in update_data and update_data["data"] != db_flow.data`).
  Each "winning" or "losing" write below therefore changes `data`, by moving the
  `viewport`, so that a rotation is caused by the request under test. A payload
  equal to the stored graph would not rotate the token, and the test would pass
  for the wrong reason.
- **`modified_by` cannot be discriminated on OSS.** The issue asks to assert that
  `modified_by.username` names the account that made the winning write. On OSS,
  a second user cannot write someone else's flow at all. This was measured: a
  second user's `PATCH` on the superuser's flow, and the superuser's `PATCH` on the
  second user's flow, both answer `404 {"detail":"Flow not found"}`. So the winner
  and the loser are always the same account here. The spec asserts what is still
  decidable: `modified_by.id` and `modified_by.username` equal what
  `version-state` reports for the row (`last_modified_by`,
  `last_modified_by_username`), and the username equals the account the test
  logged in as. Attribution *across* users needs a shared flow, which only an
  Enterprise authorization lane can provide. That is out of scope for this spec.
- **`page.allowHttpErrors()` does not apply.** The issue asks for every deliberate
  `409`/`400` to be declared with it. The HTTP-error monitor watches **page**
  traffic, though, and this spec makes no page requests: it drives the `request`
  fixture only, like every spec in `api/flows/`. A deliberate status is therefore
  an **assertion** here, never an exemption, and nothing reaches the advisory log.
- **SQLite was the backend that broke.** The `claim_version_token` docstring
  records six of six concurrent writes being accepted under `SELECT … FOR UPDATE`,
  and a loser getting an opaque `500` (`MissingGreenlet`). The local container and
  the daily both run SQLite, so the concurrency test runs on exactly the backend
  that regressed.

---

## Known product defect: a concurrent loser's `409` names a token the row never held

This was found by test 5 on `1.14.0.dev7`. It is **not filed yet**.

**Owner: #2577.** Still reproduces on `1.14.0.dev32`: the declared test failed as expected
in each #2525 run. No upstream report exists — a search of `langflow-ai/langflow` issues finds
none, and no Jira key is cited anywhere in this repo. #2341 is this spec's own (closed)
authoring issue, not a tracker for the defect, so #2525 opened #2577 to own the declaration
until an upstream report is filed; when it is, cite that ticket in the `test.fail()`
description, here, and in the QA-CHECKLIST bullet. On the VM daily of 2026-11-25
(`1.14.0.dev38`) the declared body passed on 1 of 2 attempts before failing as declared: the
defect now reproduces intermittently, so a single pass is not a fix.

**What fails.** When two or more writers race with the same token, the winner
answers `200` and every loser answers `409` with a correct `expected_version_token`.
The loser's `current_version_token`, however, is a UUID that **never was the row's
token**:
- each loser reports a different one;
- none of them equals what `version-state` reports afterwards;
- the loser's `modified_at` is not the row's `updated_at` either.

**How it was measured.** Raw `curl`, no Playwright, on `1.14.0.dev7`:
- with 2 parallel writers, 10 of 10 races produced the phantom token;
- with 6 writers, 4 to 5 of the 5 losers per round.

Re-measured for #2525 on `1.14.0.dev32`: under Playwright the declared test failed as expected
in 4 of 4 runs (the #2525 review saw 20 of 20), but raw `curl` races produced a phantom token far
less often than on `dev7` (the review saw 1 of 23 and 1 of 6). The defect stands; how often a
bare race shows it has dropped, so the `dev7` rates are not today's.

**Impact.** The frontend stores `detail.current_version_token` as the conflict's
`currentToken`. *Keep my version* / *Update Current Flow* sends that value as the
`overwrite` `If-Match` (`DuplicateFlowModal.tsx` → `reviewedVersionToken`). Measured:
`overwrite` with a loser's reported token answers `409` again. So the person who
lost a real race cannot resolve the conflict on the first attempt.

**Probable mechanism (not proven).** It is consistent with `claim_version_token`'s
ORM `update(Flow)…` synchronising the in-session `Flow` object to the loser's own
`claimed` uuid, even though the database matched zero rows. The `select(Flow)` that
follows would then return that identity-mapped object, not the row. This fits two
observations:
- a *sequential* stale write reports the correct token (test 1 passes), because the
  loser's in-memory token then already differs from `expected`;
- only racing writers that loaded the same token are affected.

**What the test does about it.** The race is split into two tests, so the
guarantee that holds is not hidden behind the one that does not:

- **Test 5** asserts the lost-update guarantee itself: one `200`, five `409`, no
  `5xx`, and the winner's graph stored. It is green.
- **Test 6** asserts that every loser's `409` names the real current token. It is
  wrapped in `test.fail()` citing this defect, so it passes while the defect is
  present. It **turns red the day upstream fixes it**, which is the signal to
  remove the `test.fail()`. Because Playwright fails a `test.fail()` test that
  unexpectedly passes, the assertion stays falsifiable in both directions.
  One phantom token is enough for the expected failure. Measured with `curl` on
  `1.14.0.dev7`, in three six-writer rounds, 4, 5 and 5 of the 5 losers carried
  one. The assertion also failed in all four Playwright runs of the original
  combined test.

  One case `test.fail()` cannot tell apart: a race where every loser happens to
  report the right token. On `1.14.0.dev7` that was never observed (0 of 10
  two-writer races, 0 of those six-writer runs). **On `1.14.0.dev32` it is the
  common outcome of a bare race**: under raw `curl` the #2525 review saw a phantom
  token in only 1 of 23 and 1 of 6 races. The Playwright test reproduced the
  defect in every local run (20 of 20 in the review, 4 of 4 for #2525; the VM daily on
  `1.14.0.dev38` then missed it once, see the owner paragraph above), presumably because
  its writers fire from one `request` context in the same tick, which keeps the
  race tighter than separate `curl` processes; that is inferred, not measured.
  **The risk:** if the harness ever races the way bare `curl` does (a slower host,
  a change in how `race()` dispatches), the test sees a clean race, `test.fail()`
  reports an unexpected pass, and the VM daily auto-removes `@stable` with the
  defect still live. If that happens, re-measure before treating it as a fix.

---

## Tags *(required)*

`@stable` `@api` `@workspace` `@database`

**`@stable` since #2469.** Measured for #2469 on `1.14.0.dev32` under the daily's shard settings (2 workers, file-level parallelism, `--retries=0`): 35 of 35 across 5 repeats at a host load of 21–25 on
10 cores, plus 14 of 14 in a combined run of the five multi-edit specs. The `test.fail()`
test failed as declared every time; it turns red the day upstream fixes the phantom token.

---

## Step by step *(required)*

The spec has seven tests, all on the `request` fixture. Each test creates its own
flow via `POST /api/v1/flows/` with a unique name and an empty graph, and declares
the routes it drives through `apiCoverage`. An id-scoped `afterEach` deletes every
flow the test created, fork included.

A *graph change* below means `PATCH {data: {nodes: [], edges: [], viewport: {x: <n>, y: <n>, zoom: 1}}}`
with a value of `n` the row does not hold yet.

1. **A stale token is refused with a structured `409`, and nothing is written.**
   - Read `T0` from `version-state`.
   - Graph change with `If-Match: T0` → `200`. Read `T1` from `version-state`.
   - Graph change with `If-Match: T0` (now stale) → `409`.
   - `detail` has exactly the key set `{code, message, flow_id, expected_version_token,
     current_version_token, modified_by, modified_at}`.
   - `code` is `"flow_version_conflict"`, `flow_id` is the flow,
     `expected_version_token` is `T0` and `current_version_token` is `T1`.
   - `modified_by` has exactly `{id, username}`, and equals `version-state`'s
     `{last_modified_by, last_modified_by_username}`. The username is the
     logged-in superuser.
   - `modified_at` is the same instant as `version-state.updated_at` (compared as
     dates, because one is written `Z` and the other `+00:00`).
   - Afterwards `GET /api/v1/flows/{id}` still holds the first change's
     `viewport`, and `version-state` still reports `T1`.

2. **A fresh token saves and rotates.**
   - Graph change with `If-Match: T0` → `200`.
   - The response's `version_token` is not `T0`.
   - `version-state.version_token` equals the response's token.
   - The stored `data` equals what was sent.

3. **A malformed precondition is refused; quoted and weak forms are accepted.**
   - `If-Match: not-a-uuid` with a graph change → `400`, and `detail` is exactly
     `"Invalid If-Match header: expected a version token"`. The token and the
     graph are unchanged afterwards.
   - `If-Match: "<current>"` with a graph change → `200`, and the token rotates.
   - `If-Match: W/"<current>"` with a graph change → `200`, and the token rotates
     again.

4. **The precondition is optional (ADR-002).**
   - Graph change with **no** `If-Match` → `200`.
   - The stored `data` equals what was sent, and the token rotated.
   - This is the path every pre-multi-edit client and every public-API user takes.

5. **Concurrent writers: exactly one winner, no `5xx`.**
   - Read `T` and fire **6** graph changes in parallel (`Promise.all`), each with
     `If-Match: T` and a distinct `viewport.x`. Six is the count upstream recorded
     as all accepted.
   - Exactly one answers `200` and the other five `409`. No response is `5xx`.
   - Every `409` carries `code: "flow_version_conflict"` and
     `expected_version_token: T`.
   - The stored graph is the **winner's** payload.

6. **Concurrent losers are told the real current token** (`test.fail()`, see
   *Known product defect*).
   - Same race as test 5.
   - Every `409`'s `current_version_token` equals the final `version-state`
     token. It does not today, so this test is expected to fail.

7. **`fork` copies inertly; `overwrite` is guarded and archives the replaced graph.**
   - **`fork`.** Snapshot the source's `{name, data, version_token}`, then
     `POST /fork` with `{data: <distinct graph>}` → `201`.
     - The returned id differs from the source's.
     - The copy's `data` is the supplied graph and its name is `<source> (copy)`.
     - It is inert: `endpoint_name: null`, `webhook: false`, `mcp_enabled: false`,
       `access_type: "PRIVATE"`.
     - Reading the source back gives the snapshot unchanged.
   - **`overwrite` without `If-Match`** → `428`. The flow's versions list is still
     empty.
   - **`overwrite` with the current token** and a new graph → `200`.
     - The flow's `data` is the new graph, and the token rotated.
     - `GET /versions/` holds exactly one entry, with `description: "Replaced by a
       newer edit"`.
     - `GET /versions/{id}` returns the **replaced** graph as that entry's `data`.
   - **`overwrite` with the now-stale token** → `409`, with
     `code: "flow_version_conflict"`. The versions list still holds exactly one
     entry. The upstream docstring records a refused overwrite once leaving an
     orphan version behind, so this count is the check for that regression.

---

## Validation criterion *(required)*

- All seven tests pass three consecutive times at `--retries=0 --workers=1` on the
  current nightly. Test 6 passes because it fails as expected under `test.fail()`.
- Each test fails under a mutation of its load-bearing assertion, run in isolation:
  - expect `200` on the stale write;
  - drop the rotation check by asserting the old token;
  - expect `200` on `not-a-uuid`;
  - expect `409` without `If-Match`;
  - expect two winners;
  - expect `0` version entries after the overwrite.
- The declared coverage matches what the fixture recorded.
- Zero flows named `flow-version-precondition*` are left behind.

---

## External dependencies *(required)*

- A running Langflow OSS instance at `PLAYWRIGHT_BASE_URL`, with auto-login or the superuser.
- `src/backend/base/langflow/api/v1/flow_conflict.py`: `parse_if_match`, `build_conflict_detail`,
  `ensure_version_precondition`, `claim_version_token` (the conditional `UPDATE`).
- `src/backend/base/langflow/api/v1/flow_conflict_routes.py`: `version-state`, `fork`, `overwrite` (`428` without `If-Match`).
- `src/backend/base/langflow/api/v1/flow_fork.py`: `build_fork_payload`, which neutralises the copy.
- `src/backend/base/langflow/api/v1/flows.py`: `update_flow`, which parses `If-Match`.
- `src/backend/base/langflow/api/v1/flows_helpers.py`: `_patch_flow`, where only a graph change claims the token.
- `src/backend/base/langflow/api/v1/flow_version.py`: the versions list and read that `overwrite` archives into.
- No provider key, no model, no network egress.
