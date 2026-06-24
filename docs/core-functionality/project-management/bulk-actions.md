# Project Management – Bulk Actions on Flows

**Last validated:** Langflow 1.10.x

---

## What this test validates *(required)*

Validates multi-select and bulk operations on the home flow listing:

1. **Shift selection** — Shift-clicking the first then the third list card selects the contiguous range (all 3 created flows become checked).
2. **Bulk download** — `download-bulk-btn` downloads the selected flows and surfaces a "downloaded successfully" notification.
3. **Deselect** — Shift-clicking the first card again clears the selection.
4. **Ctrl/Cmd selection** — Ctrl/Cmd-clicking the first and third cards selects exactly those two, leaving the second unchecked (proves per-item, not range, selection).
5. **Bulk delete** — `delete-bulk-btn` followed by the confirmation removes the selected flows; the deleted flow names disappear from the listing while the unselected one remains.

The test creates its 3 flows from starter templates and captures each flow ID from the URL, so cleanup deletes only the IDs it created via the API — never sibling specs' flows, which is required for safety under `fullyParallel`.

---

## Tags *(required)*

`@stable` `@release` `@workspace` `@mainpage` `@regression`

---

## Step by step *(required)*

1. Bootstrap the test session (`awaitBootstrapTest`).
2. Create 3 flows by opening the templates modal and picking, in order, **Basic Prompting**, **Document Q&A**, **Basic Prompting**; after each, capture the `/flow/<id>` URL and return to the home listing.
3. Shift-click list card 1 then list card 3; assert all 3 checkboxes are checked.
4. Click `download-bulk-btn`; assert the "downloaded successfully" notification.
5. Shift-click list card 1 again; assert all 3 checkboxes are unchecked.
6. Ctrl/Cmd-click list card 1 and list card 3; assert cards 1 and 3 checked, card 2 unchecked.
7. Capture the three flow names from `flow-name-div` (asserting non-empty text first).
8. Click `delete-bulk-btn`, confirm in the "This can't be undone." dialog; assert "Flows deleted successfully".
9. Assert the first and third flow names are hidden and the second is still visible.
10. **Cleanup (finally):** delete each captured flow ID via `DELETE /api/v1/flows/{id}` (404s on already-deleted flows are ignored).

---

## Validation criterion *(required)*

- Shift-click selects the contiguous range; all 3 created flows are checked.
- Bulk download produces a success notification.
- Shift-click again deselects all.
- Ctrl/Cmd-click selects exactly the clicked items (1 and 3), not the range.
- Bulk delete removes the selected flows: their names become hidden, the unselected flow remains visible.

---

## External dependencies *(required)*

- Home listing UI testids: `side_nav_options_all-templates`, `new-project-btn` / `new_project_btn_empty_page`, `modal-title`, `flow-builder-welcome-panel` / `flow-builder-welcome-browse-more` (the 1.10.x welcome overlay), `sidebar-search-input`, `icon-ChevronLeft`, `home-dropdown-menu`, `list-card`, `checkbox-*`, `flow-name-div`, `download-bulk-btn`, `delete-bulk-btn`.
- Starter templates **Basic Prompting** and **Document Q&A** must exist.
- REST API `DELETE /api/v1/flows/{id}` for ID-scoped cleanup (auth via `getAuthToken`).
- No LLM or provider API key required.

---

## What this test does not cover *(optional)*

- Bulk operations across folders/projects other than the default listing.
- Drag-select or keyboard-only selection.
- Verifying the actual downloaded file contents (only the success notification is asserted).

---

## Known flakiness *(optional)*

Under `fullyParallel` CI load this is a heavy test (it creates 3 flows and navigates editor↔home repeatedly). Two load-induced flake modes have been observed on the weekly run:

- The home listing taking >10s to render after returning from the editor (the `Projects` visibility wait). **Mitigated** by raising that wait to 30s.
- Clicking the "New Flow" entry point not opening the templates modal within 30s, inside the shared `openNewFlowTemplatesModal` helper — **tracked separately** (not yet mitigated).

Both reproduce only under contention; a single isolated run against a fresh instance passes consistently.

---

## Preconditions *(optional)*

- Langflow running and accessible at `PLAYWRIGHT_BASE_URL`.
- No LLM or API key needed.
