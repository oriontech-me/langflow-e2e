# API Folders (Projects) CRUD

**Last validated:** Langflow 1.12.x (`1.12.0.dev6` / `1.12.0.dev7`)

---

## What this test validates *(required)*
Validates the CRUD contract of the folders endpoint family, exposed at `/api/v1/projects/` (the current path; "folder" is the legacy alias kept for backward compatibility). Folders/projects are the top-level organizational unit in the UI sidebar — every flow belongs to exactly one folder, and moving a flow between folders is done by patching its `folder_id`.

A regression here silently breaks the sidebar (folders disappear or cannot be created), the "move flow to folder" affordance in the UI, and any external consumer that programmatically organizes flows. The spec exercises create, list, delete, and — the item tracked by QA-CHECKLIST §12.5 — **moving a flow between folders via `PATCH /api/v1/flows/{id}` with a new `folder_id`**.

If any of these tests fail against `langflowai/langflow-nightly:latest`, the folder persistence layer, the projects router, or the flow↔folder association has regressed and the next release is at risk.

---

## Tags *(required)*
`@stable` `@release` `@api` `@regression`

Tests 1 and 2 carry `@stable`. Tests 3 and 4 do **not**, and both are currently
`test.fixme` — each for a different, independently tracked reason:

- **Test 3** (`DELETE`) — quarantined for **#965**. The endpoint returns `500`
  instead of `204` under concurrent writes; a product defect, not a test defect
  (measurements below). `@stable` stays off and the test stays `test.fixme`
  until the upstream fix lands on `langflowai/langflow-nightly:latest`, at which
  point the test is re-validated there and both are restored.
- **Test 4** (`PATCH folder_id`) — quarantined for **#932**, a *different* root
  cause (see *Relationship between #965 and #932* below).

---

## Step by step *(required)*

The spec runs **4 independent tests** against `/api/v1/projects/` and `/api/v1/flows/` via Playwright's `request` fixture. Each test obtains a Bearer token through `getAuthToken()` (auto-login) and creates its own ephemeral folder(s)/flow with a `Date.now()`-suffixed name to avoid collisions. Cleanup is **id-scoped in `afterEach`**: every test pushes the ids it creates (from the `POST` 201 response) into a tracker, and `afterEach` deletes exactly those — so a mid-test assertion failure never leaks folders/flows. Deletes are targeted by id (never a global wipe), which under the suite's parallelism would remove concurrent workers' data. No pre-test cleanup, no global setup.

---

**Test 1 — `POST creates folder and returns ID and name`**
1. `POST /api/v1/projects/` with `{ name, description }`
2. Assert HTTP status is `201`
3. Assert response body has a non-empty string `id` and matching `name`
4. Cleanup via `DELETE`

**Test 2 — `GET lists folders and includes the created one`**
1. Create a folder via `POST`
2. `GET /api/v1/projects/`
3. Assert HTTP status is `200` and the response is iterable (array or `{ folders: [...] }`)
4. Assert the freshly created `id` is present in the list with the correct name
5. Cleanup

**Test 3 — `DELETE removes folder and it no longer appears in listing`** *(quarantined, #965)*
1. Create a folder via `POST`
2. `DELETE /api/v1/projects/{id}`
3. Assert HTTP status is `204` (No Content)
4. `GET /api/v1/projects/` and assert the deleted `id` is absent from the list

The assertion in step 3 is **deliberately unchanged**: `204` is the documented
contract (`@router.delete("/{project_id}", status_code=204)`) and the endpoint
breaks it under concurrent writes. Accepting a `500`, retrying the delete, or
widening the assertion would hide a product defect — see the section below.

**Test 4 — `moving flow between folders via PATCH folder_id updates association`** *(QA-CHECKLIST §12.5)*
1. Create two folders (A and B) via `POST /api/v1/projects/`
2. Create a flow via `POST /api/v1/flows/` with `folder_id` = folder A's id
3. Assert the created flow's `folder_id` equals folder A's id
4. `PATCH /api/v1/flows/{id}` with `{ folder_id: <folder B id> }`; assert HTTP status is `200`
5. `GET /api/v1/flows/{id}` and assert the persisted `folder_id` now equals folder B's id
6. Cleanup: delete the flow and both folders

---

## Validation criterion *(required)*
- The **active** tests (1 and 2) pass 3× in a row at `--retries=0 --workers=1`
  against `langflowai/langflow-nightly:latest`.
- Status codes match: folder `POST` returns `201`; folder `GET` returns `200`; folder `DELETE` returns `204`; flow `PATCH`/`GET` return `200`.
- **Move is durable and observable**: after `PATCH /api/v1/flows/{id}` with a new `folder_id`, a fresh `GET /api/v1/flows/{id}` reports the new `folder_id` — proving the association moved and persisted, not just that the request was accepted.
- Deleted folders disappear from `GET /api/v1/projects/`.
- Each test cleans up after itself — no orphan folders or flows remain after the
  suite completes. This is stronger than "issue a DELETE": the cleanup runs
  through `deleteProject()`
  (`tests/helpers/flows/delete-project.ts`, sibling of `delete-flow.ts`), which
  **verifies** the folder is gone and retries the delete when it comes back
  `500`, because a swallowed `500`
  leaves a permanent orphan (see the defect below). The observable is
  `GET /api/v1/projects/` no longer listing the id, not the status of one call.
- **Quarantine gate for test 3 (#965)** — the concrete observable that lifts it:
  the burst under *concurrent writes* returns `204` for every delete. Measured on
  `1.12.0.dev7` with 2 concurrent clients issuing create+delete cycles, **44 %**
  of the deletes come back `500` (40 of 90); the criterion is 0 of 90 with the
  same script, at which point `test.fixme` and `@stable` are restored together.
  A serial pass is NOT sufficient evidence — serially the endpoint is already
  green (10/10), which is exactly why the daily saw this as a flake.

---

## Known product defect behind the quarantine of test 3 (#965)

`DELETE /api/v1/projects/{id}` answers **`500`** — not `204` — whenever another
write transaction is in flight, and **the folder is not deleted**. The response
leaks the raw SQL:

```json
{"detail":"(sqlite3.OperationalError) database is locked\n[SQL: DELETE FROM folder WHERE folder.id = ?]\n[parameters: ('0913fdcdc2bd4f68bfa26d8ed3f0fc83',)]\n(Background on this error at: https://sqlalche.me/e/20/e3q8)"}
```

Why this is a product defect and not "SQLite being SQLite":

| Endpoint, same P=2 contention, 12 rounds | Result |
|---|---|
| `POST /api/v1/projects/` | 24/24 → `201` |
| `POST /api/v1/flows/` | 24/24 → `201` |
| `DELETE /api/v1/flows/{id}` | 24/24 → `200` |
| `DELETE /api/v1/projects/{id}` | 13/24 → `204`, **11/24 → `500`** |

Sibling write paths survive the identical contention. `busy_timeout` **is**
configured (30 000 ms, plus WAL — `lfx/services/settings/groups/database.py`),
yet the failures return in ~0.03 s, so SQLite's busy handler never waits on this
path. `delete_project` wraps every exception into
`HTTPException(status_code=500, detail=str(e))` and only
`retry_project_operation_on_deployment_guard` retries — `OperationalError` is not
covered, so a transient lock becomes a permanent client-visible failure.

Rate versus the previous release (A/B/A/B, one arm at a time, 3 alternations,
P=2, 30 deletes per round, orphans purged between rounds):

| Build | `204` | `500` | median latency of a failure |
|---|---|---|---|
| stable `1.10.3` | 66/90 | **5 (6 %)** | 1.80 s |
| nightly `1.12.0.dev7` | 50/90 | **40 (44 %)** | 0.03 s |

So the defect is **not new** — 1.10.3 produces the same instant `500` — but 1.12
makes it ~7× more frequent and changes the failure mode: 1.10.3 mostly blocks and
still honours the contract (rounds of 68–196 s, individual deletes waiting up to
42 s, some connections dropped), 1.12 gives up in 0.03 s. The endpoint source and
`services/database/service.py` are byte-identical between the two builds, as are
SQLAlchemy 2.0.51 / aiosqlite 0.22.1 / SQLite 3.46.1 — the rate change is
reproducible but **not explained at code level**, and the upstream report says so
explicitly.

Filed upstream: see `docs/upstream-bugs/UPSTREAM-BUG-project-delete-500-under-contention.md`.

## Relationship between #965 and #932 — separate causes, both stay

Settled with evidence, not assumption. Under the same contention that breaks the
DELETE, `PATCH /api/v1/flows/{id}` also returns `500` (7/20 at P=2, 27/32 at
P=4) — but **every** `PATCH` that returned `200` had persisted the new
`folder_id` (13/13 and 5/5). #932's symptom is a `200` followed by a **stale**
association, which contention does not reproduce. Two issues, two root causes.

---

## What this test does not cover *(optional)*
- Folder **rename** and delete-with-flows-inside — covered by the UI spec `core-functionality/project-management/folder-crud.spec.ts`.
- Cascade behavior when a folder holding flows is deleted (do the flows move to root, or are they deleted?) — out of scope here.
- Multi-user isolation of folders — out of scope; would require seeding a second user.
- The UI drag-drop affordance for moving a flow between folders — this spec covers the API contract only.
- **Concurrency as a first-class scenario.** The spec asserts the single-client
  contract; it does not itself drive concurrent writers. The #965 defect is
  *observed* through this spec (the suite runs `fullyParallel`, so other workers
  supply the contention) but is *measured* with the standalone scripts recorded in
  the upstream report. A dedicated load spec is not in scope here.

---

## Preconditions *(optional)*
- Langflow running and reachable at `PLAYWRIGHT_BASE_URL` (default `http://localhost:7860`).
- Auto-login enabled (the default in nightly) so `getAuthToken()` can mint a Bearer token. If auth is reconfigured, the helper at `tests/helpers/auth/get-auth-token.ts` must be updated first.

---

## External dependencies *(required)*
<!-- Files from the Langflow repository that, if changed, could break this test. -->

- `src/backend/base/langflow/api/v1/projects.py` — router that exposes `POST/GET/DELETE /api/v1/projects/`; any signature, status code (notably the `204` on DELETE), or response shape change here directly affects the folder tests.
- `src/backend/base/langflow/api/v1/folders.py` — legacy folders router / alias kept for compatibility; changes to how folders and projects share models can shift behavior.
- `src/backend/base/langflow/api/v1/mappers/deployments/sync.py` — `retry_project_operation_on_deployment_guard` wraps the whole delete in a nested transaction and decides which failures are retried; widening it to cover `OperationalError` is the likely shape of the #965 fix, and would flip test 3 back to green.
- `src/backend/base/langflow/api/v1/flows.py` — exposes `PATCH /api/v1/flows/{id}`; the move-flow test depends on `folder_id` being an accepted, persisted field on this endpoint.
- `src/backend/base/langflow/services/database/models/flow/model.py` — flow schema including the `folder_id` foreign key; renaming/removing it breaks the move assertion.
