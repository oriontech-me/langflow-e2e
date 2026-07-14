# Project Management – Bulk Actions on Flows

**Last validated:** Langflow 1.11.x

---

## What this test validates *(required)*

Validates multi-select and bulk operations on the home flow listing:

1. **Shift selection** — Shift-clicking the first then the third list card selects the contiguous range (all 3 created flows become checked).
2. **Bulk download** — `download-bulk-btn` downloads the selected flows and surfaces a "downloaded successfully" notification.
3. **Deselect** — Shift-clicking the first card again clears the selection.
4. **Ctrl/Cmd selection** — Ctrl/Cmd-clicking the first and third cards selects exactly those two, leaving the second unchecked (proves per-item, not range, selection).
5. **Bulk delete** — `delete-bulk-btn` followed by the confirmation removes the selected flows; the deleted flow names disappear from the listing while the unselected one remains.

The test creates its 3 flows directly via the REST API (`POST /api/v1/flows/`, empty `nodes`/`edges`) and captures each returned flow ID, so cleanup deletes only the IDs it created — never sibling specs' flows, which is required for safety under `fullyParallel`. Creating via the API (rather than clicking through the templates modal three times) also removes the sole source of this spec's historical CI flake — see **Known flakiness**.

---

## Tags *(required)*

`@stable` `@release` `@workspace` `@mainpage` `@regression`

---

## Step by step *(required)*

1. Create 3 flows via `POST /api/v1/flows/` (`createFlow` helper) with unique names (`bulk-actions-<suffix>-1..3`) and empty `data`; capture each returned ID. This runs **before** bootstrap so the instance is non-empty.
2. Bootstrap the test session onto the home listing (`awaitBootstrapTest(page, { skipModal: true })`). `skipModal` skips opening the templates modal; seeding the flows first also skips the empty-page branch (`addFlowToTestOnEmptyLangflow`, which drives the same templates-modal helper), so no part of the historically flaky modal path is exercised. The 3 just-created flows sort to the top by recency.
3. **Guard:** assert the top 3 list cards' names are exactly the 3 created names — selection is positional (shift/ctrl-click by index) and bulk-delete is destructive, so a sibling worker's flow interleaving at the top must fail fast rather than risk a cross-worker delete.
4. Shift-click list card 1 then list card 3; assert all 3 checkboxes are checked.
5. Click `download-bulk-btn`; assert the "downloaded successfully" notification.
6. Shift-click list card 1 again; assert all 3 checkboxes are unchecked.
7. Ctrl/Cmd-click list card 1 and list card 3; assert cards 1 and 3 checked, card 2 unchecked.
8. Capture the three flow names from `flow-name-div` (asserting non-empty text first).
9. Click `delete-bulk-btn`, confirm in the "This can't be undone." dialog; assert "Flows deleted successfully".
10. Assert the first and third flow names are hidden and the second is still visible.
11. **Cleanup (finally):** delete each captured flow ID via `DELETE /api/v1/flows/{id}` (404s on already-deleted flows are ignored).

---

## Validation criterion *(required)*

- Shift-click selects the contiguous range; all 3 created flows are checked.
- Bulk download produces a success notification.
- Shift-click again deselects all.
- Ctrl/Cmd-click selects exactly the clicked items (1 and 3), not the range.
- Bulk delete removes the selected flows: their names become hidden, the unselected flow remains visible.

---

## External dependencies *(required)*

- Home listing UI testids: `list-card`, `checkbox-*`, `flow-name-div`, `download-bulk-btn`, `delete-bulk-btn`.
- REST API `POST /api/v1/flows/` (via the `createFlow` helper) for flow creation and `DELETE /api/v1/flows/{id}` for ID-scoped cleanup (auth via `getAuthToken`).
- No starter template or LLM/provider API key required — flows are created empty via the API.

---

## What this test does not cover *(optional)*

- Bulk operations across folders/projects other than the default listing.
- Drag-select or keyboard-only selection.
- Verifying the actual downloaded file contents (only the success notification is asserted).

---

## Known flakiness *(optional)*

This spec used to create its 3 flows through the UI (opening the templates modal three times and navigating editor↔home after each), which was the sole source of its CI flake. Two load-induced modes recurred on the daily-stable workflow (#723):

- The home listing taking >30s to render after returning from the editor (`page.waitForSelector` timeout in the navigation — daily 2026-07-09).
- Clicking the "New Flow" entry point not opening the templates modal ("swallowed click": the button is actionable but its React handler is not wired yet under load), inside the shared `openNewFlowTemplatesModal` helper — this survived the #420 click-and-probe retry loop under severe contention (`expect(...).toBe(true)` in `dismissWelcomeOverlayAndWaitForModal` — daily 2026-07-13).

Both modes lived entirely in the incidental UI scaffolding, never in the bulk-action assertions under test. #723 **eliminated the whole class** by creating the 3 flows via `POST /api/v1/flows/` and loading the listing with a single `page.goto("/")` — no templates modal, no editor↔home round-trips. The remaining positional risk (a sibling worker's flow interleaving at the top of the recency-sorted listing) is caught by the top-3 name guard before any destructive selection.

---

## Preconditions *(optional)*

- Langflow running and accessible at `PLAYWRIGHT_BASE_URL`.
- No LLM or API key needed.
