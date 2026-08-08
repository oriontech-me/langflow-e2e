# Project Management – Navigate Between Folders

**Last validated:** Langflow 1.12.x (nightly `1.12.0.dev20`)

---

## What this test validates *(required)*

Validates **folder-to-folder navigation** on the home page (QA-CHECKLIST §10.2
"Navigate between folders"): clicking a folder in the project sidebar filters the
flow listing to **that folder's own flows**, and switching to another folder
swaps the listing to the second folder's flows. This is the navigation/scoping
behavior — distinct from folder CRUD, flow search, and moving a flow.

Setup is API-first for determinism: two folders (projects) are created via
`POST /api/v1/projects/`, and one uniquely-named flow is created **inside each**
via `POST /api/v1/flows/` with the folder's `folder_id`. The UI then navigates
between the two folders and asserts each listing is correctly scoped.

The key assertion is **mutual exclusion**: folder A's view shows flow A and
**not** flow B, and folder B's view shows flow B and **not** flow A — proving the
sidebar navigation actually re-scopes the listing rather than showing a global
list.

---

## Tags *(required)*

`@release` `@workspace` `@mainpage` `@regression`

> Not `@stable` yet — new spec, pending team validation on a clean run (mirrors
> the sibling `flow-navigation-folders.spec.ts` / `folder-crud.spec.ts` tag set;
> `@workspace` is this area's functional tag).

---

## Step by step *(required)*

### Test — navigating between two folders scopes the listing to each folder

1. Create folder **A** via `POST /api/v1/projects/` (unique name `nav-folderA-<timestamp>`); capture `folderAId`.
2. Create folder **B** via `POST /api/v1/projects/` (unique name `nav-folderB-<timestamp>`); capture `folderBId`.
3. Create flow **A** via `POST /api/v1/flows/` with `folder_id = folderAId` (unique name `nav-flowA-<timestamp>`); assert the echoed `folder_id` matches; capture `flowAId`.
4. Create flow **B** via `POST /api/v1/flows/` with `folder_id = folderBId` (unique name `nav-flowB-<timestamp>`); assert the echoed `folder_id` matches; capture `flowBId`.
5. Bootstrap the session (`awaitBootstrapTest(page, { skipModal: true })`); assert both folders' sidebar entries are visible.
6. `clickProject(folderA)` → assert flow **A** name is visible **and** flow **B** name is hidden (`toBeHidden` / `toHaveCount(0)`).
7. `clickProject(folderB)` → assert flow **B** name is visible **and** flow **A** name is hidden.
8. **Cleanup (finally):** delete `flowAId`, `flowBId` (id-scoped, ignored if already gone), then folders `folderAId`, `folderBId` via `DELETE /api/v1/projects/{id}`.

---

## Validation criterion *(required)*

- With folder A selected: flow A is listed and flow B is **not** — `getByText(flowA)` visible, `getByText(flowB)` hidden.
- With folder B selected: flow B is listed and flow A is **not** — `getByText(flowB)` visible, `getByText(flowA)` hidden.
- Both folders remain visible in the sidebar throughout (navigation, not deletion).

A regression that made the listing global (ignoring the selected folder) would
show both flows in each view and fail the mutual-exclusion assertion. Unique
timestamped names make each `getByText` unambiguous under `fullyParallel`.

---

## External dependencies *(required)*

- Home sidebar testids: `project-sidebar`, `mainpage_title`, and the project entry addressed through `helpers/ui/project-sidebar.ts` (via `MainPage.clickProject`) — `sidebar-nav-<project id>` on the nightly, `sidebar-nav-<name>` on `main` / `1.11.x` (#1363).
- Flow listing surface: the flow name rendered on the home grid (asserted via `page.getByText(<flowName>)`, the same surface `folder-crud.spec.ts` uses after `clickProject`).
- REST API: `POST`/`DELETE /api/v1/projects/` (folders), `POST`/`DELETE /api/v1/flows/` with `folder_id` (auth via `getAuthToken`).
- No LLM or provider API key required (model-independent).

---

## What this test does not cover *(optional)*

- Folder CRUD (create/rename/delete) — `folder-crud.spec.ts`.
- Flow search-by-name filtering and API-created flows appearing on the listing — `flow-navigation-folders.spec.ts`.
- Moving a flow between folders (drag-drop / API placement) — `folder-drag-drop-flow.spec.ts`.
- Deletion integrity across folders — `folder-deletion-integrity.spec.ts`.

---

## Preconditions *(optional)*

- Langflow running and accessible at `PLAYWRIGHT_BASE_URL`.
- No LLM or API key needed.
