# API Folders (Projects) CRUD

**Last validated:** Langflow 1.12.x (`1.12.0.dev23`)

---

## What this test validates *(required)*
Validates the CRUD contract of the folders endpoint family, exposed at `/api/v1/projects/` (the current path; "folder" is the legacy alias kept for backward compatibility). Folders/projects are the top-level organizational unit in the UI sidebar — every flow belongs to exactly one folder, and moving a flow between folders is done by patching its `folder_id`.

A regression here silently breaks the sidebar (folders disappear or cannot be created), the "move flow to folder" affordance in the UI, and any external consumer that programmatically organizes flows. The spec exercises create, list, delete, and — the item tracked by QA-CHECKLIST §12.5 — **moving a flow between folders via `PATCH /api/v1/flows/{id}` with a new `folder_id`**.

If any of these tests fail against `langflowai/langflow-nightly:latest`, the folder persistence layer, the projects router, or the flow↔folder association has regressed and the next release is at risk.

---

## Tags *(required)*
`@stable` `@release` `@api` `@regression`

All four tests carry `@stable`. Tests 3 and 4 spent 2026-07-24 → 2026-08-11 as
`test.fixme` without `@stable`, each tracked by its own issue, and both
quarantines were lifted together once the upstream fix reached the nightly:

- **Test 3** (`DELETE`) — quarantined for **#965**: the endpoint returned `500`
  instead of `204` under concurrent writes (a product defect, not a test defect —
  measurements below). Upstream added `services/database/lock_retry.py` and
  wrapped this endpoint in `run_with_lock_retry` (langflow#14308), which was then
  forward-ported to `release-1.12.0`. Re-validated on `1.12.0.dev23`: the
  contention burst returns `204` **24/24 at P=2 and 32/32 at P=4**.
- **Test 4** (`PATCH folder_id`) — quarantined for **#932**, the *same* root cause
  on a second endpoint (see *Relationship between #965 and #932* below).
  `api/v1/flows.py` now wraps its update path in `run_with_lock_retry` as well;
  re-validated on `1.12.0.dev23` at **32/32 PATCH `200` with the association
  persisted, P=4**.

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
- All four tests pass 3× in a row at `--retries=0 --workers=1`
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
- **Quarantine gate for tests 3 and 4 (#965 / #932) — met on 2026-08-11.** The
  gate was never a serial pass: serially both endpoints were already green
  (10/10, 0/30), which is exactly why the daily saw this as a flake. The
  observable is the burst under *concurrent writes*. Measured on `1.12.0.dev23`
  with `docs/upstream-bugs/scripts/scout-965-scope.py` and
  `scout-932-probe.py`: `DELETE /projects` **24/24 `204` at P=2, 32/32 at P=4**
  (against 11/24 failing at P=2 on `1.12.0.dev7`), and `PATCH /flows` **32/32
  `200` with the association persisted at P=4** (against 20/24 failing on
  `1.12.0.dev8`). Re-check with the same two scripts before trusting a future
  green: the endpoints are only as safe as the retry wrapper upstream keeps.

---

## Known product defect behind the quarantine of test 3 (#965) — FIXED upstream

> **Status (2026-08-11): fixed on the nightly line, quarantine lifted.** Upstream
> langflow#14308 added `services/database/lock_retry.py` and wrapped
> `delete_project` in `run_with_lock_retry`; the module was absent from
> `1.12.0.dev10` (which is why #932 recorded the forward-port as an open ask) and
> is present in `1.12.0.dev23`, together with the call site in both
> `api/v1/projects.py` and `api/v1/flows.py`. The measurements below are the
> historical evidence for LE-2020 — keep them, they are what the contention gate
> in *Validation criterion* compares against. Everything in the present tense in
> this section describes builds up to `1.12.0.dev8`.

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

Filed upstream as **[LE-2020](https://datastax.jira.com/browse/LE-2020)** — full evidence
in `docs/upstream-bugs/UPSTREAM-BUG-project-delete-500-under-contention.md`.

## Relationship between #965 and #932 — CORRECTED: one root cause, two endpoints

An earlier pass of this document concluded these were separate causes, on the
premise that *"#932's symptom is a `200` followed by a stale association, which
contention does not reproduce"*. **That premise was wrong**, and the correction
matters because it was being used to rule contention out.

The daily artifact settles it. From `playwright-json-daily-30085452003`
(run 30085452003, 2026-07-24), the failing assertion is:

```
Error: expect(received).toBe(expected)   Expected: 200   Received: 500

> 160 |       expect(patchRes.status()).toBe(200);
```

It is the **HTTP status**, not the `folder_id`. There never was a `200` followed by
a stale association. The `expect(received).toBe(expected) // Object.is equality`
wording in the triage issue reads like an association mismatch, and both this
document and #932's own hypotheses were written from that misreading.

So the earlier measurement was right and its conclusion inverted: `PATCH
/api/v1/flows/{id}` returning `500` under contention (7/20 at P=2, 27/32 at P=4;
independently reproduced 2026-07-29 as 14/24 at P=2, 20/24 at P=4, 0/30 serial)
**is** #932. #965 and #932 are the same root cause — SQLite write contention — on
two different endpoints.

What still distinguishes them is the **user-visible outcome**, which is why they
remain separate reports:

| | `DELETE /projects/{id}` (#965 / LE-2020) | `PATCH /flows/{id}` (#932) |
|---|---|---|
| End state | project **survives** the "successful" delete | flow stays in its source project |
| User signal | **silent no-op** past the retry budget — no toast, notification centre empty | `Failed to save flow` notification, with the raw SQL and bound parameters |
| Severity | Medium (silent) | Medium (reported, consistent state) |

Measured on the UI path 2026-07-29 under 4 background writers: the drag fails, two
`500`s appear in the console, the flow does not move, and the notification centre
is **not** empty. Full evidence:
`docs/upstream-bugs/UPSTREAM-BUG-flow-patch-500-under-contention.md`.

**Do not re-derive "two root causes" from the symptom wording.** Read the artifact.

### The duplicate that was left unquarantined

`core-functionality/project-management/folder-drag-drop-flow.spec.ts` carried
`moving a flow to another folder via API PATCH updates folder_id` — the same
sequence as test 4, differing only in using the `/api/v1/folders/` legacy alias
instead of `/api/v1/projects/`, and asserting `expect(patchRes.status()).toBe(200)`
identically. It was **not** quarantined, so silencing test 4 for #932 left the
same failure reachable from a second file: two flake sites, one signal, and a
quarantine that only looked complete.

It was removed by #932 rather than quarantined too — the API-level folder-move
contract belongs here, in the API spec, and a pure-API test in a UI-focused
project-management file is drift. When #932's upstream fix lands, test 4 here is
the single place to restore.

Noted while doing it, **not** fixed by #932 (out of scope): that file is named for
drag-drop but contains no drag-drop test — its three tests are two API checks and
one UI listing check. The UI move affordance *is* automatable; dragging
`list-card` onto `sidebar-nav-<folder>` moves the flow, verified live on
1.12.0.dev8 while measuring this defect. Worth a checklist item of its own.

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
