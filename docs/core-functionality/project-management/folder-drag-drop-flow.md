# Project Management – Flow Placement in a Folder (API and Listing)

**Last validated:** Langflow 1.13.x (nightly `1.13.0.dev8`)

---

## What this test validates *(required)*

Validates that a folder (project) is a real container for flows on both surfaces
the product exposes, one test per surface:

1. **API placement** — `POST /api/v1/flows/` with an explicit `folder_id` creates
   the flow **inside** that folder, and the `201` body echoes back the same
   `folder_id` it was given. This is the contract every other spec relies on when
   it seeds a flow into a folder over the API instead of dragging it in the UI.
2. **Listing** — a folder created over the API appears in the home sidebar, and
   clicking it lists the flow that was created inside it. The flow is addressed by
   its own unique name (`ui-flow-<timestamp>`), so the assertion cannot be
   satisfied by an unrelated pre-existing flow.

The two tests are deliberately not one: the first is a pure API contract and
finishes in ~1 s, the second needs a browser and the home page. Merging them
would make an API regression indistinguishable from a sidebar regression.

**Scope note — the folder MOVE assertion does not live here.** A third test
(`moving a flow to another folder via API PATCH updates folder_id`) was removed
from this file by #932: it duplicated `api/flows/api-folders-crud.spec.ts` test 4
line for line, differing only in using the `/api/v1/folders/` legacy alias, and it
was not quarantined — so silencing the canonical test left the identical failure
reachable from a second file. The underlying failure is a product defect
(`PATCH /api/v1/flows/{id}` answers `500 (sqlite3.OperationalError) database is
locked` under two concurrent writers, 14/24; 0/30 serial — tracked upstream as
LE-2020, evidence in
`docs/upstream-bugs/UPSTREAM-BUG-flow-patch-500-under-contention.md`). The restore
point is `api-folders-crud.spec.ts` test 4, not this file.

---

## Tags *(required)*

`@stable` `@release` `@workspace` `@regression`

---

## Step by step *(required)*

### Test 1 — creating a flow in a specific folder via API places it in that folder

1. Mint a bearer with `getAuthToken(request)`.
2. `POST /api/v1/folders/` with a unique name (`test-folder-<timestamp>`); assert
   `201` and capture the folder id. `/api/v1/folders/` is a `307` alias of
   `/api/v1/projects/`, and it is used here on purpose — the alias is part of the
   contract this file covers.
3. `POST /api/v1/flows/` with `folder_id` set to that id, an empty graph
   (`nodes: []`, `edges: []`) and `is_component: false`; assert `201`.
4. Assert the response body's `folder_id` **equals** the folder id that was
   requested.
5. **Cleanup (finally):** delete the created flow id-scoped through `deleteFlow`,
   then `DELETE /api/v1/folders/{id}`. Both are attempted even when the assertion
   above failed.

### Test 2 — folder listing shows flows correctly via UI

1. Mint a bearer; create the folder (`ui-folder-<timestamp>`) and, inside it, a
   flow (`ui-flow-<timestamp>`) over the API, exactly as in test 1.
2. Enter the app with `awaitBootstrapTest(page, { skipModal: true })`.
3. Assert the folder's home-sidebar entry is visible, addressed through
   `projectSidebarEntry(page, { id, name })` — the nightly keys the testid on the
   project **id** and `1.11.x` on its **name**, and the helper matches both (#1363).
4. Click that entry.
5. Assert the flow's unique name is visible in the main content area.
6. **Cleanup (afterEach + finally):** the flow and the folder created here are
   deleted id-scoped as in test 1, and every flow the **page** created is deleted
   through `trackCreatedFlows` — see *Why the tracker is needed on top of the
   explicit deletes* below.

---

## Validation criterion *(required)*

- **Test 1 fails** if `POST /api/v1/flows/` answers anything but `201`, or answers
  `201` with a `folder_id` that is not the one requested (a flow silently landing
  in the default project).
- **Test 2 fails** if the folder never appears in the home sidebar under either
  testid spelling, or if the flow created inside it is not listed after the folder
  is opened.

---

## External dependencies *(required)*

- `src/backend/base/langflow/api/v1/projects.py` — the projects (folders) router
  that `/api/v1/folders/` `307`-redirects onto: `POST /` (create) and `DELETE /{id}`.
- `src/backend/base/langflow/api/v1/flows.py` — `POST /api/v1/flows/`, which is
  what must honour an explicit `folder_id` instead of falling back to the default
  project, and `DELETE /api/v1/flows/{id}`.
- `src/frontend/src/components/core/folderSidebarComponent/components/sideBarFolderButtons/index.tsx`
  — the home sidebar project list this spec clicks; it is where the project entry's
  testid is spelled (`sidebar-nav-<id>` on the nightly, `sidebar-nav-<name>` on
  `1.11.x` — #1363).
- REST API: `POST`/`DELETE /api/v1/folders/` (a `307` alias of
  `/api/v1/projects/`) and `POST`/`DELETE /api/v1/flows/` with `folder_id`; auth
  via `getAuthToken`.
- Home sidebar testids: the project entry and the container it is scoped to
  (`project-sidebar`), both addressed through `tests/helpers/ui/project-sidebar.ts`,
  which matches `sidebar-nav-<project id>` (the nightly) and `sidebar-nav-<name>`
  (`main` and `1.11.x`) — see #1363.
- Helpers: `tests/helpers/auth/get-auth-token.ts`,
  `tests/helpers/flows/delete-flow.ts`,
  `tests/helpers/flows/track-created-flows.ts`,
  `tests/helpers/other/await-bootstrap-test.ts`,
  `tests/helpers/ui/project-sidebar.ts`.
- No LLM or provider API key required (model-independent).

---

## Why the tracker is needed on top of the explicit deletes *(optional)*

Both tests already delete the flow and the folder they create by id. Measured on
2026-09-10 against a **purged** instance (0 user flows, default project empty),
the file still left **2** flows behind: `New Flow` and `Basic Prompting`.

They come from `awaitBootstrapTest`, not from the test body: when the default
project is empty the home page renders `new_project_btn_empty_page` and the helper
calls `addFlowToTestOnEmptyLangflow`, which creates both. Nothing in this file ever
saw their ids, so a source grep for `deleteFlow` reports this spec as clean while it
leaks on every run against a fresh instance — which is why the leak audit is a
measurement (purge, run, diff the flow list) and never a grep.

`trackCreatedFlows(page)` captures every `POST /api/v1/flows/` → `201` the page
performs and deletes those ids in `afterEach`, id-scoped. It never touches a flow
another parallel worker created.

---

## What this test does not cover *(optional)*

- Folder CRUD through the UI (create / rename / delete) — `folder-crud.spec.ts`.
- Moving a flow **between** folders — see the Scope note above;
  `api/flows/api-folders-crud.spec.ts` test 4.
- Drag-and-drop of a flow **file** onto a folder (import) —
  `flow-functionality/dragAndDrop.spec.ts`.
- Deletion integrity across folders — `folder-deletion-integrity.spec.ts`.
- Navigating between two folders — `flow-navigation-between-folders.spec.ts`.

---

## Preconditions *(optional)*

- A running Langflow instance at `PLAYWRIGHT_BASE_URL`, in auto-login mode or with
  the superuser credentials configured (`getAuthToken` covers both).
- No provider credential and no seeded flow required — both tests create every
  object they assert on.
