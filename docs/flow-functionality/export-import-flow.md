# Flow Functionality — Export and Import Flow

**Last validated:** Langflow 1.12.x

---

## What this test validates *(required)*

Validates that flows can be exported to JSON and imported from JSON, across three scenarios:

1. **Export produces a valid downloadable file with success feedback** — exporting via the three-dot menu shows the "exported successfully" toast *and* the downloaded JSON contains a non-empty `data.nodes` array.
2. **Import via drag and drop loads components** — dropping a collection JSON onto the main page shows "uploaded successfully".
3. **Import via upload button loads flow** — clicking the upload button opens the native file chooser; selecting a single-flow JSON shows "uploaded successfully".

If these break, users cannot share flows, back them up, or restore previously exported flows.

---

## Tags *(required)*

`@stable` `@release` `@workspace` `@regression` `@api`

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

---

## Validation criterion *(required)*

- "exported successfully" toast visible after export (Test 1)
- Exported JSON has `data.nodes` array with length > 0 (Test 1)
- "uploaded successfully" toast visible after import (Tests 2, 3)

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
