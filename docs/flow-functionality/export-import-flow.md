# Flow Functionality — Export and Import Flow

**Last validated:** Langflow 1.10.x

---

## What this test validates *(required)*

Validates that flows can be exported to JSON and imported from JSON, across four scenarios:

1. **Export triggers success message** — exporting via the three-dot menu shows "exported successfully" toast.
2. **Import via drag and drop loads components** — dropping a collection JSON onto the main page shows "uploaded successfully".
3. **Exported JSON is valid** — downloaded file contains a `data.nodes` array with at least one entry.
4. **Import via upload button loads flow** — clicking the upload button opens the native file chooser; selecting a collection JSON shows "uploaded successfully".

If these break, users cannot share flows, back them up, or restore previously exported flows.

---

## Tags *(required)*

`@stable` `@release` `@workspace` `@regression` `@api`

---

## Step by step *(required)*

**Test 1 — export triggers success message**

1. Create blank flow, add ChatInput component
2. Return to main page
3. Click three-dot menu (`home-dropdown-menu`) on the flow card
4. Click `btn-download-json`
5. Confirm "Export" text is visible; click `modal-export-button`
6. Assert text matching `.*exported successfully` is visible

**Test 2 — imported JSON loads on canvas**

1. Navigate to main page (skipModal: true)
2. `simulateDragAndDrop` with `tests/assets/flows/collection.json` onto `cards-wrapper`
3. Assert "uploaded successfully" text visible (up to 2-minute timeout)

**Test 3 — exported JSON contains flow data**

1. Create blank flow, add ChatOutput component, return to main page
2. Set up `page.waitForEvent("download")` BEFORE clicking export (Promise-based capture)
3. Trigger export via three-dot menu → `btn-download-json` → `modal-export-button`
4. Await the download event (hard-fails if download doesn't fire within 30s — the test's whole purpose)
5. Read file, `JSON.parse`, assert `data.nodes` is a non-empty array

**Test 4 — import via upload button**

1. Navigate to main page (skipModal: true)
2. Hard-assert `upload-project-button` is visible (fails explicitly if Langflow removes the button)
3. Set up `page.waitForEvent("filechooser")` BEFORE clicking the upload button
4. Click `upload-project-button` and feed `tests/assets/flows/flow.json` into the file chooser via `setFiles` — a single-flow fixture so the button takes its `uploadFlow` branch (the project-bundle branch needs a `folder_name` form field that the button doesn't supply)
5. Assert "uploaded successfully" text visible

---

## Validation criterion *(required)*

- "exported successfully" toast visible after export (Tests 1, 3)
- "uploaded successfully" toast visible after import (Tests 2, 4)
- Exported JSON has `data.nodes` array with length > 0 (Test 3 primary path)

---

## External dependencies *(required)*

- `src/frontend/src/components/core/flowEditorComponents/` — flow editor header, export modal
- `src/backend/base/langflow/api/v1/flows.py` — flow export/import endpoints
- `tests/helpers/ui/simulate-drag-and-drop.ts` — `simulateDragAndDrop` helper
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

- Test 3 sets up the download event listener via `page.waitForEvent("download")` BEFORE clicking the export button — a race-condition-avoidance pattern. The test hard-fails if the download event doesn't fire (no toast-fallback).
- Test 4 hard-asserts `upload-project-button` is visible before importing and then actually exercises it via `filechooser` + `setFiles` — distinct from Test 2's drag-and-drop path.
- The 2-minute timeout on "uploaded successfully" in Test 2 is intentional: large collections can take time to process on slow machines.
- The describe is configured `mode: "serial"` so the diff-based cleanup (`beforeEach` snapshot of existing flow IDs, `afterEach` delete-the-diff) runs without cross-worker races within this file. The list calls use `get_all=true&remove_example_flows=true` to match the existing `cleanAllFlows` helper. A null sentinel on snapshot failure skips cleanup entirely so a hiccup on the list endpoint can never delete the whole workspace.
