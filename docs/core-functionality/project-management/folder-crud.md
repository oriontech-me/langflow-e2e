# Project Management – Folder (Project) CRUD

**Last validated:** Langflow 1.12.x (nightly `1.12.0.dev20`)

---

## What this test validates *(required)*

Validates the folder (project) CRUD lifecycle from the home sidebar, exercising
the `MainPage` folder helpers (`addProject` / `renameProject` / `deleteProject` /
`clickProject`):

1. **Create** — `add-project-button` creates a new folder that appears in the
   project sidebar. The entry is addressed by the name the **backend** assigned
   (`createProjectThroughSidebar` reads it from the `201` body), not by the
   literal `sidebar-nav-New Project`: Langflow de-duplicates the name into
   `New Project (N)` whenever one already exists, so the literal was a bet on the
   instance having no other folder by that name (#1023).
2. **Rename** — double-clicking the folder and committing a new name updates the
   entry's text. We assert only that this project's entry now reads the new
   unique name (not the absence of `New Project`), since other specs may create
   `New Project` folders in parallel against the same backend. The text, not the
   testid, is the observable: since #1363 the entry's testid is the project id
   and does not change with a rename, so asserting on it would pass whether the
   rename landed or not.
3. **Delete (empty)** — the folder's more-options → delete → confirm flow removes
   the folder and surfaces a "Project deleted successfully" notification.
4. **Delete (with a flow inside)** — a second test sets up a folder containing a
   flow via the REST API, deletes the folder through the UI, and confirms the
   contained flow is deleted as well (`GET /api/v1/flows/{id}` returns 404).

The delete-with-flow test creates its folder and flow via the API and captures
both IDs, so cleanup deletes only what it created — never sibling specs' data,
which is required for safety under `fullyParallel`.

---

## Tags *(required)*

`@stable` `@release` `@workspace` `@mainpage`

---

## Step by step *(required)*

### Test 1 — create, rename and delete an empty folder

1. Bootstrap the session without the templates modal (`awaitBootstrapTest(page, { skipModal: true })`).
2. Create the folder with `createProjectThroughSidebar(page)`; it clicks
   `add-project-button`, captures the `201` body and asserts the project's
   sidebar entry is visible. The id it returns is what teardown deletes.
3. Rename the folder to a unique name (`crud-folder-<timestamp>`); assert the
   entry now CONTAINS that name (the unique text alone proves the rename
   committed — see note above on parallel `New Project` collisions).
4. Delete the folder via its more-options menu and confirm; assert the
   "Project deleted successfully" notification and that the sidebar entry is gone.
5. **Cleanup (finally):** delete the captured project id through `deleteProject`
   — see *Why the UI delete is the assertion, not the cleanup* below.

### Test 2 — delete a folder containing a flow

1. Create a folder via `POST /api/v1/folders/`; capture `folderId`.
2. Create a flow inside it via `POST /api/v1/flows/` with `folder_id`; assert the
   echoed `folder_id` matches and capture `flowId`.
3. Bootstrap the session (`skipModal: true`); assert the folder's sidebar entry is
   visible, open it and assert the flow name is listed.
4. Delete the folder through the UI; assert the "Project deleted successfully"
   notification and that the sidebar entry is gone.
5. `GET /api/v1/flows/{flowId}` must return **404** — the contained flow was
   deleted with the folder.
6. **Cleanup (finally):** delete the captured flow ID (ignored if already gone)
   and, only if the UI deletion did not complete, the folder ID.

---

## Why the UI delete is the assertion, not the cleanup (#1023)

Test 1 deletes its folder through the UI and asserts the toast plus the sidebar
entry disappearing. **Neither proves the folder is gone.** The sidebar entry is
removed optimistically, and `DELETE /api/v1/projects/{id}` answers **500** under
concurrent writes while the toast still reads "Project deleted successfully"
(#965 / LE-2020 — `database is locked` on `DELETE FROM folder`). The folder then
survives with nothing left to remove it.

Measured on `1.12.0.dev9`, this folder's four specs at `--workers=2`: a **7/7
green** run still logged a `500` on a project delete, and six consecutive runs
from a clean instance left **11 orphan folders** named `New Project`,
`New Project (2)`… Those leftovers are not cosmetic — with 8 of them seeded,
`folder-deletion-integrity.spec.ts` goes from *3 passed in 18.4 s* to *2 failed
in 55.0 s*.

So the `finally` block deletes the captured id unconditionally via
`deleteProject`, which retries the 500 and treats `404` (the happy path, where
the UI really did delete it) as done. The UI assertions are unchanged.

---

## Validation criterion *(required)*

- Creating a folder adds a `New Project` entry to the sidebar.
- Renaming updates the sidebar entry to the new name and removes the old one.
- Deleting an empty folder produces the success notification and removes the entry.
- Deleting a folder that contains a flow removes both — the flow returns 404 via API.

---

## External dependencies *(required)*

- Home sidebar testids: `add-project-button`, `project-sidebar`, `input-project`,
  `btn-delete-project`, the "Delete" confirmation control, and the project entry
  plus its kebab — both addressed through `helpers/ui/project-sidebar.ts`, which
  matches `sidebar-nav-<project id>` / `more-options-button_<project id>` (the
  nightly, since upstream `23f91d8587`) and the older `sidebar-nav-<name>` /
  `more-options-button_<slug>` still rendered by `main` and `1.11.x` (#1363).
- REST API `POST`/`GET`/`DELETE /api/v1/projects/` (folders) and `/api/v1/flows/`
  (auth via `getAuthToken`). `/api/v1/folders/` is a legacy alias of `/projects/`.
- No LLM or provider API key required.

---

## What this test does not cover *(optional)*

- Empty-folder deletion integrity, deletion not affecting other folders, and
  create-after-delete-all — covered by `folder-deletion-integrity.spec.ts`.
- API-level folder placement and moving a flow between folders — covered by
  `folder-drag-drop-flow.spec.ts`.
- Whether a deleted folder's flow is recoverable / moved to a default folder
  (the observed and asserted behavior is hard deletion).

---

## Preconditions *(optional)*

- Langflow running and accessible at `PLAYWRIGHT_BASE_URL`.
- No LLM or API key needed.
