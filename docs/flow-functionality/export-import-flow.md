# Flow Functionality — Export and Import Flow

**Last validated:** Langflow 1.12.x (`1.12.1`)

---

## What this test validates *(required)*

Validates that flows can be exported to JSON and imported from JSON, across four scenarios:

1. **Export produces a valid downloadable file with success feedback** — exporting via the three-dot menu shows the "exported successfully" toast *and* the downloaded JSON contains a non-empty `data.nodes` array.
2. **Import via drag and drop loads components** — dropping a collection JSON onto the main page shows "uploaded successfully".
3. **Import via upload button loads flow** — clicking the upload button opens the native file chooser; selecting a single-flow JSON shows "uploaded successfully".
4. **Re-importing a live flow's own export through the UI produces a SECOND flow, not an update** — exporting a flow that still exists and importing that same file back leaves the original untouched and adds a copy named `"<name> (1)"`. Measured, not assumed (#1773): the UI import never reaches `POST /api/v1/flows/upload/` — `useUploadFlow` → `useAddFlow` → `createNewFlow` sets `id: ""`, discarding the id the export carries, renames on collision through `getFolderScopedDuplicateName`, and posts `POST /api/v1/flows/` (`201`). The API layer upserts on that same file; **the UI does not**, and nothing pinned that divergence before this test.

If these break, users cannot share flows, back them up, or restore previously exported flows. Scenario 4 is the one that pins a *surprising* behaviour rather than a broken one: a user restoring a backup over a live flow gets a duplicate, not the update the API contract would suggest. The test states which of the two answers the product actually gives, so a change in either direction is caught.

---

## Tags *(required)*

`@stable` `@release` `@workspace` `@regression` `@api`

Test 4 carries every tag above **except `@stable`**. It is new in #1773 and its three
clean `--retries=0` runs were measured against a source instance at `1.12.1`, not
against the nightly the daily lane runs; promotion waits for that evidence on the
nightly. Tests 1–3 keep `@stable`.

---

## Step by step *(required)*

**Test 1 — export produces a valid downloadable file with success feedback**

1. Create blank flow (capturing the flow id from the `POST /api/v1/flows/` 201
   response) and add a ChatInput component
2. Poll `GET /api/v1/flows/{id}` until `data.nodes.length > 0` — server-truth
   proof the node-add autosave persisted, replacing the quiet-window guard
   (`waitForFlowSaveSettled` resolves after 700 ms of silence even when the
   debounced PATCH hasn't fired yet — the #384 loophole)
3. Return to the main page with `leaveFlowEditor(page)` — the `icon-ChevronLeft`
   click plus its home assertion, wrapped so the exit survives the
   `SaveChangesModal` deadlock (#1153) — then open the three-dot menu **of the
   created flow's own card**: `list-card` filtered by `flow-name-{id}` →
   `home-dropdown-menu`
   inside it. Never `nth(0)`: the home sorts by `updated_at` DESC, so under
   parallel CI the first card is whatever flow a neighbor worker touched last
   — exporting it produced the `nodes: []` failures (#518; export serializes
   the card's client-side data, no server fetch)
4. Arm `page.waitForEvent("download")` BEFORE clicking export (Promise-based capture to avoid race with modal interaction)
5. `btn-download-json` → confirm "Export" modal text → click `modal-export-button`
6. Assert toast matching `.*exported successfully` is visible
7. Await the download event (hard-fails if it doesn't fire within 30s)
8. Read file, `JSON.parse`, assert `data.nodes` is a non-empty array

**Test 2 — imported JSON loads on canvas**

1. Navigate to main page (skipModal: true)
2. `simulateDragAndDrop` with `tests/assets/flows/collection.json` onto `cards-wrapper`
3. Assert "uploaded successfully" text visible (up to 2-minute timeout)

**Test 3 — import via upload button**

1. Navigate to main page (skipModal: true)
2. Hard-assert `upload-project-button` is visible (fails explicitly if Langflow removes the button)
3. Set up `page.waitForEvent("filechooser")` BEFORE clicking the upload button
4. Click `upload-project-button` and feed `tests/assets/flows/flow.json` into the file chooser via `setFiles` — a single-flow fixture so the button takes its `uploadFlow` branch (the project-bundle branch needs a `folder_name` form field that the button doesn't supply)
5. Assert "uploaded successfully" text visible

**Test 4 — re-importing a live flow's own export adds a copy instead of updating it**

1. Create the flow through `POST /api/v1/flows/` under a name unique to this run, and
   track its id for cleanup. The setup is deliberately API-side: a blank flow created
   through the UI gets an auto-generated name drawn from a word list, and two parallel
   workers can land the same one — which would make the by-name counting in step 6
   perturbable by a neighbour, the very defect #1773 is about
2. Main page (`awaitBootstrapTest(page, { skipModal: true })`, `mainpage_title`), then
   locate the flow's **own** card: `list-card` filtered by `flow-name-{id}` — never
   `nth(0)`, for the #518 reason recorded under Test 1
3. Arm `page.waitForEvent("download")` BEFORE exporting, then export from that card:
   `home-dropdown-menu` → `btn-download-json` → `modal-export-button`; assert the
   `.*exported successfully` toast
4. **Save the download under a `.json` filename** (`download.saveAs(...)`), never
   `download.path()`. The raw path is an extension-less temp file, so the browser reports
   its `type` as `""`; `useUploadFlow` throws `Invalid file type` for anything that is not
   `application/json`, and it does so with **no toast and no request** — a Test 4 built on
   `download.path()` observes an unchanged listing and reads it as "the UI upserted".
   Measured: that exact false green
5. Assert the exported JSON carries the original flow's `id` — this is what makes step 6
   a statement about the importer rather than about a lossy export
6. Feed the saved file back in through `upload-project-button` + `filechooser`
   (`setFiles`); wait for `POST /api/v1/flows/` to answer `201`, which is the importer's
   own signal and, unlike the toast, cannot be reached without the upload happening
7. **The load-bearing observables**, read from `GET /api/v1/flows/` filtered by the run's
   unique name — never a global count, never a card count:
   - there are **exactly 2** flows whose name starts with it;
   - one is the **original id**, unchanged;
   - the other is a **new id** under the auto-suffixed name `"<name> (1)"`.
   Track the new id for cleanup

## Validation criterion *(required)*

- "exported successfully" toast visible after export (Tests 1, 4)
- Exported JSON has `data.nodes` array with length > 0 (Test 1)
- "uploaded successfully" toast visible after import (Tests 2, 3)
- The UI export carries the source flow's `id` (Test 4)
- After re-importing a live flow's own export, the listing holds **exactly two** flows
  under that run's unique name (Test 4): the original id untouched, plus a **new** id
  named `"<name> (1)"` — asserted by name, never by a global flow or card count

---

## External dependencies *(required)*

- `src/frontend/src/components/core/flowToolbarComponent/` — flow editor header actions that open the export dialog
- `src/frontend/src/modals/exportModal/` — the export modal itself
- `src/backend/base/langflow/api/v1/flows.py` — flow export/import endpoints
- `tests/helpers/ui/simulate-drag-and-drop.ts` — `simulateDragAndDrop` helper
- `tests/helpers/flows/leave-flow-editor.ts` — the editor exit: drains in-flight flow saves, clicks `icon-ChevronLeft`, and distinguishes the #1153 blocker deadlock from a swallowed click. It depends on upstream `src/frontend/src/pages/FlowPage/index.tsx` (`useBlocker` / `handleSave`), `src/frontend/src/modals/saveChangesModal/index.tsx`, and the `flow.unsavedChangesTitle` string in `src/frontend/src/locales/en.json` — if that title is reworded the dialog stops being recognised and every deadlock silently reclassifies as a swallowed click
- `tests/assets/flows/collection.json` — multi-flow JSON used as import fixture
- `data-testid="home-dropdown-menu"` — three-dot menu on flow cards
- `data-testid="btn-download-json"` — download/export menu item
- `data-testid="modal-export-button"` — confirm button in export modal
- `data-testid="upload-project-button"` — the import entry point Tests 3 and 4 drive
- `data-testid="list-card"` / `data-testid="flow-name-{id}"` — the home card and the
  per-flow name node inside it; Test 4 locates the flow's own card through these

---

## What this test does not cover *(optional)*

- Importing a flow with incompatible component versions
- Export of a flow with custom components
- Partial export (exporting specific nodes only)

---

## Preconditions *(optional)*

- Langflow running at `PLAYWRIGHT_BASE_URL`
- `tests/assets/flows/collection.json` must exist and be a valid Langflow flow collection
- No LLM required — flows are created but never run

---

## Notes *(optional)*

- Test 1 sets up the download event listener via `page.waitForEvent("download")` BEFORE clicking the export button — a race-condition-avoidance pattern. The test hard-fails if the download event doesn't fire and also asserts the visible toast, so both the user-facing signal and the actual file artifact are validated in one run (the toast-only variant was consolidated into this test to avoid redundant blank-flow setup).
- Test 3 hard-asserts `upload-project-button` is visible before importing and then actually exercises it via `filechooser` + `setFiles` — distinct from Test 2's drag-and-drop path.
- The 2-minute timeout on "uploaded successfully" in Test 2 is intentional: large collections can take time to process on slow machines.
- Cleanup tracks the ids returned by this page's own flow-creating responses (`POST` under `/api/v1/flows`) and deletes exactly those in `afterEach`. The previous diff-based cleanup (snapshot → delete-the-difference) deleted any flow created by PARALLEL workers during the test window — the destructive-cleanup class from #553 — and is gone. The describe stays `mode: "serial"` so the three tests share the tracker safely within the file.
- The exported JSON is serialized client-side from the home card's store data (`ExportModal` → `downloadFlow`; no server fetch on download) — which is why exporting the wrong (fresh, empty) card yields `nodes: []` with a perfectly healthy backend.
- **Test 4 pins a DIVERGENCE between the two layers, which is why it is not a duplicate
  of the API spec's Test 2** (`docs/api/flows/api-flows-export-import.md`). Given the
  same file, `POST /api/v1/flows/upload/` upserts — same id, no new row — while the UI
  creates a second flow. Two separate reasons, both measured on 1.12.1: the UI export is
  serialized client-side (`ExportModal` → `downloadFlow`, no server fetch), so it never
  calls `POST /api/v1/flows/download/`; and the UI import goes through
  `useUploadFlow` → `useAddFlow`, which posts `POST /api/v1/flows/` after
  `createNewFlow` has set `id: ""`. Neither layer's test can stand in for the other.
- **The export does carry the id**, so the duplicate is the importer's doing, not a
  lossy export. Test 4 asserts that explicitly (step 5), because without it a future
  regression that stopped exporting the id would produce the same two flows and the test
  would still be green while describing the wrong cause.
- **Do not wait on the "uploaded successfully" toast in Test 4.** The import that
  produces the duplicate answers `POST /api/v1/flows/` `201`, and that response is the
  signal to wait on. A missing toast is exactly what the `Invalid file type` path also
  looks like (step 4), so the toast cannot distinguish "imported" from "silently
  refused".
