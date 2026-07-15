# API Folders (Projects) CRUD

**Last validated:** Langflow 1.11.x

---

## What this test validates *(required)*
Validates the CRUD contract of the folders endpoint family, exposed at `/api/v1/projects/` (the current path; "folder" is the legacy alias kept for backward compatibility). Folders/projects are the top-level organizational unit in the UI sidebar — every flow belongs to exactly one folder, and moving a flow between folders is done by patching its `folder_id`.

A regression here silently breaks the sidebar (folders disappear or cannot be created), the "move flow to folder" affordance in the UI, and any external consumer that programmatically organizes flows. The spec exercises create, list, delete, and — the item tracked by QA-CHECKLIST §12.5 — **moving a flow between folders via `PATCH /api/v1/flows/{id}` with a new `folder_id`**.

If any of these tests fail against `langflowai/langflow-nightly:latest`, the folder persistence layer, the projects router, or the flow↔folder association has regressed and the next release is at risk.

---

## Tags *(required)*
`@stable` `@release` `@api` `@regression`

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

**Test 3 — `DELETE removes folder and it no longer appears in listing`**
1. Create a folder via `POST`
2. `DELETE /api/v1/projects/{id}`
3. Assert HTTP status is `204` (No Content)
4. `GET /api/v1/projects/` and assert the deleted `id` is absent from the list

**Test 4 — `moving flow between folders via PATCH folder_id updates association`** *(QA-CHECKLIST §12.5)*
1. Create two folders (A and B) via `POST /api/v1/projects/`
2. Create a flow via `POST /api/v1/flows/` with `folder_id` = folder A's id
3. Assert the created flow's `folder_id` equals folder A's id
4. `PATCH /api/v1/flows/{id}` with `{ folder_id: <folder B id> }`; assert HTTP status is `200`
5. `GET /api/v1/flows/{id}` and assert the persisted `folder_id` now equals folder B's id
6. Cleanup: delete the flow and both folders

---

## Validation criterion *(required)*
- All 4 tests pass 5× in a row against `langflowai/langflow-nightly:latest`.
- Status codes match: folder `POST` returns `201`; folder `GET` returns `200`; folder `DELETE` returns `204`; flow `PATCH`/`GET` return `200`.
- **Move is durable and observable**: after `PATCH /api/v1/flows/{id}` with a new `folder_id`, a fresh `GET /api/v1/flows/{id}` reports the new `folder_id` — proving the association moved and persisted, not just that the request was accepted.
- Deleted folders disappear from `GET /api/v1/projects/`.
- Each test cleans up after itself — no orphan folders or flows remain after the suite completes.

---

## What this test does not cover *(optional)*
- Folder **rename** and delete-with-flows-inside — covered by the UI spec `core-functionality/project-management/folder-crud.spec.ts`.
- Cascade behavior when a folder holding flows is deleted (do the flows move to root, or are they deleted?) — out of scope here.
- Multi-user isolation of folders — out of scope; would require seeding a second user.
- The UI drag-drop affordance for moving a flow between folders — this spec covers the API contract only.

---

## Preconditions *(optional)*
- Langflow running and reachable at `PLAYWRIGHT_BASE_URL` (default `http://localhost:7860`).
- Auto-login enabled (the default in nightly) so `getAuthToken()` can mint a Bearer token. If auth is reconfigured, the helper at `tests/helpers/auth/get-auth-token.ts` must be updated first.

---

## External dependencies *(required)*
<!-- Files from the Langflow repository that, if changed, could break this test. -->

- `src/backend/base/langflow/api/v1/projects.py` — router that exposes `POST/GET/DELETE /api/v1/projects/`; any signature, status code (notably the `204` on DELETE), or response shape change here directly affects the folder tests.
- `src/backend/base/langflow/api/v1/folders.py` — legacy folders router / alias kept for compatibility; changes to how folders and projects share models can shift behavior.
- `src/backend/base/langflow/api/v1/flows.py` — exposes `PATCH /api/v1/flows/{id}`; the move-flow test depends on `folder_id` being an accepted, persisted field on this endpoint.
- `src/backend/base/langflow/services/database/models/flow/model.py` — flow schema including the `folder_id` foreign key; renaming/removing it breaks the move assertion.
