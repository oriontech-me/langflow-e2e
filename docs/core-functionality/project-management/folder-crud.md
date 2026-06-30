# Project Management – Folder (Project) CRUD

**Last validated:** Langflow 1.10.x

---

## What this test validates *(required)*

Validates the folder (project) CRUD lifecycle from the home sidebar, exercising
the `MainPage` folder helpers (`addProject` / `renameProject` / `deleteProject` /
`clickProject`):

1. **Create** — `add-project-button` creates a new folder that appears in the
   project sidebar as `sidebar-nav-New Project`.
2. **Rename** — double-clicking the folder and committing a new name updates the
   sidebar entry to `sidebar-nav-<new name>`. We assert only the new unique entry
   (not the absence of `New Project`), since other specs may create `New Project`
   folders in parallel against the same backend.
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
2. Click `add-project-button`; assert `sidebar-nav-New Project` is visible.
3. Rename the folder to a unique name (`crud-folder-<timestamp>`); assert the new
   `sidebar-nav-<name>` is visible (the unique entry alone proves the rename
   committed — see note above on parallel `New Project` collisions).
4. Delete the folder via its more-options menu and confirm; assert the
   "Project deleted successfully" notification and that the sidebar entry is gone.

### Test 2 — delete a folder containing a flow

1. Create a folder via `POST /api/v1/folders/`; capture `folderId`.
2. Create a flow inside it via `POST /api/v1/flows/` with `folder_id`; assert the
   echoed `folder_id` matches and capture `flowId`.
3. Bootstrap the session (`skipModal: true`); assert `sidebar-nav-<folder>` is
   visible, open it and assert the flow name is listed.
4. Delete the folder through the UI; assert the "Project deleted successfully"
   notification and that the sidebar entry is gone.
5. `GET /api/v1/flows/{flowId}` must return **404** — the contained flow was
   deleted with the folder.
6. **Cleanup (finally):** delete the captured flow ID (ignored if already gone)
   and, only if the UI deletion did not complete, the folder ID.

---

## Validation criterion *(required)*

- Creating a folder adds a `New Project` entry to the sidebar.
- Renaming updates the sidebar entry to the new name and removes the old one.
- Deleting an empty folder produces the success notification and removes the entry.
- Deleting a folder that contains a flow removes both — the flow returns 404 via API.

---

## External dependencies *(required)*

- Home sidebar testids: `add-project-button`, `project-sidebar`, `input-project`,
  `sidebar-nav-<name>`, `more-options-button_<slug>`, `btn-delete-project`, and
  the "Delete" confirmation control.
- REST API `POST`/`GET`/`DELETE /api/v1/projects/` (folders) and `/api/v1/flows/`
  (auth via `getAuthToken`). `/api/v1/folders/` is a legacy alias of `/projects/`.
- No LLM or provider API key required.

---

## What this test does not cover *(optional)*

- Empty-folder deletion integrity, deletion not affecting other folders, and
  create-after-delete-all — covered by `folder-deletion-integrity.spec.ts`.
- API-level folder placement and moving a flow between folders — covered by
  `folder-drag-drop-flow.spec.ts` and `general-bugs-move-flow-from-folder.spec.ts`.
- Whether a deleted folder's flow is recoverable / moved to a default folder
  (the observed and asserted behavior is hard deletion).

---

## Preconditions *(optional)*

- Langflow running and accessible at `PLAYWRIGHT_BASE_URL`.
- No LLM or API key needed.
