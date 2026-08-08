# Project Management – Bulk Actions on Flows

**Last validated:** Langflow 1.12.x (nightly `1.12.0.dev20`)

---

## What this test validates *(required)*

Validates multi-select and bulk operations on the home flow listing:

1. **Shift selection** — Shift-clicking the first then the third list card selects the contiguous range (all 3 created flows become checked).
2. **Bulk download** — `download-bulk-btn` downloads the selected flows and surfaces a "downloaded successfully" notification.
3. **Deselect** — Shift-clicking the first card again clears the selection.
4. **Ctrl/Cmd selection** — Ctrl/Cmd-clicking the first and third cards selects exactly those two, leaving the second unchecked (proves per-item, not range, selection).
5. **Bulk delete** — `delete-bulk-btn` followed by the confirmation removes the selected flows; the deleted flow names disappear from the listing while the unselected one remains.

The test creates its 3 flows in a **dedicated project/folder** via the REST API (`POST /api/v1/projects/` for the folder, then `POST /api/v1/flows/` with that `folder_id`, empty `nodes`/`edges`) and captures each returned ID, so cleanup deletes only the IDs it created — never sibling specs' flows, which is required for safety under `fullyParallel`. It then navigates to that folder's listing, which shows **only** those 3 flows, so the positional selection (shift/ctrl-click by card index) and destructive bulk-delete operate on an isolated set — a sibling worker's concurrently-created flow lands in the **default** project and can no longer interleave into this test's listing (the recurrent `#869` cross-worker flake). Creating via the API (rather than clicking through the templates modal three times) also removes the sole source of this spec's historical CI flake — see **Known flakiness**.

---

## Tags *(required)*

`@stable` `@release` `@workspace` `@mainpage` `@regression`

---

## Step by step *(required)*

1. Create a dedicated folder via `POST /api/v1/projects/` with a unique name; capture its ID. Then create 3 flows via `POST /api/v1/flows/` (`createFlow` helper) with unique names (`bulk-actions-<suffix>-1..3`), empty `data`, and `folder_id` set to that folder; capture each returned ID. This runs **before** bootstrap so the instance is non-empty.
2. Bootstrap the test session (`awaitBootstrapTest(page, { skipModal: true })`), then navigate to the dedicated folder's listing via its sidebar entry so **only** the 3 created flows are shown. `skipModal` skips opening the templates modal; seeding the flows first also skips the empty-page branch (`addFlowToTestOnEmptyLangflow`, which drives the same templates-modal helper), so no part of the historically flaky modal path is exercised.
3. **Guard:** assert the folder listing contains exactly the 3 created names — selection is positional (shift/ctrl-click by index) and bulk-delete is destructive. Because the listing is folder-scoped, a sibling worker's flow (created in the default project) cannot interleave; the guard confirms isolation before any destructive selection.
4. Shift-click list card 1 then list card 3; assert all 3 checkboxes are checked.
5. Click `download-bulk-btn`; assert the "downloaded successfully" notification.
6. Shift-click list card 1 again; assert all 3 checkboxes are unchecked.
7. Ctrl/Cmd-click list card 1 and list card 3; assert cards 1 and 3 checked, card 2 unchecked.
8. Capture the three flow names from `flow-name-div` (asserting non-empty text first).
9. Click `delete-bulk-btn`, confirm in the "This can't be undone." dialog; assert "Flows deleted successfully".
10. Assert the first and third flow names are hidden and the second is still visible.
11. **Cleanup (finally):** delete each captured flow ID via `DELETE /api/v1/flows/{id}` (404s on already-deleted flows are ignored), then delete the dedicated folder via `DELETE /api/v1/projects/{id}`.

---

## Validation criterion *(required)*

- Shift-click selects the contiguous range; all 3 created flows are checked.
- Bulk download produces a success notification.
- Shift-click again deselects all.
- Ctrl/Cmd-click selects exactly the clicked items (1 and 3), not the range.
- Bulk delete removes the selected flows: their names become hidden, the unselected flow remains visible.

---

## External dependencies *(required)*

- Home listing UI testids: `list-card`, `checkbox-*`, `flow-name-div`, `download-bulk-btn`, `delete-bulk-btn`, and the folder sidebar entry, addressed through `helpers/ui/project-sidebar.ts` — `sidebar-nav-<project id>` on the nightly, `sidebar-nav-<name>` on `main` / `1.11.x` (#1363).
- REST API `POST /api/v1/projects/` + `DELETE /api/v1/projects/{id}` for the dedicated folder, `POST /api/v1/flows/` (via the `createFlow` helper, with `folder_id`) for flow creation, and `DELETE /api/v1/flows/{id}` for ID-scoped cleanup (auth via `getAuthToken`).
- No starter template or LLM/provider API key required — flows are created empty via the API.

---

## What this test does not cover *(optional)*

- Drag-select or keyboard-only selection.
- Verifying the actual downloaded file contents (only the success notification is asserted).

---

## Known flakiness *(optional)*

This spec used to create its 3 flows through the UI (opening the templates modal three times and navigating editor↔home after each), which was the sole source of its CI flake. Two load-induced modes recurred on the daily-stable workflow (#723):

- The home listing taking >30s to render after returning from the editor (`page.waitForSelector` timeout in the navigation — daily 2026-07-09).
- Clicking the "New Flow" entry point not opening the templates modal ("swallowed click": the button is actionable but its React handler is not wired yet under load), inside the shared `openNewFlowTemplatesModal` helper — this survived the #420 click-and-probe retry loop under severe contention (`expect(...).toBe(true)` in `dismissWelcomeOverlayAndWaitForModal` — daily 2026-07-13).

Both modes lived entirely in the incidental UI scaffolding, never in the bulk-action assertions under test. #723 **eliminated the whole class** by creating the 3 flows via `POST /api/v1/flows/` and loading the listing with a single `page.goto("/")` — no templates modal, no editor↔home round-trips. The remaining positional risk (a sibling worker's flow interleaving at the top of the recency-sorted listing) is caught by the top-3 name guard before any destructive selection.

**#790 (load-collateral, top-3 guard hardened — superseded by #869).** On load-degraded / guard-tripped dailies (2026-07-09/13/15/16) the top-3 name guard failed with `expect(received).toEqual(expected) // deep equality`. It was first hardened by wrapping the card-name read in `expect.poll(...).toEqual(...)` so the guard retried until the listing settled. That reduced but did not eliminate the flake.

**#869 (root-caused and fixed by folder isolation).** The deep-equality guard kept recurring (2026-07-15/16/17/21). Root cause is **not** a product regression and **not** pure saturation — it is cross-worker data interference: under `fullyParallel`, a sibling spec's freshly-created flow floats into the **shared** recency-sorted home listing's top 3 and stays there past the 30s poll window, so this spec's positional guard (top 3 must be exactly its 3 flows) legitimately fails. Fixed deterministically by creating the 3 flows in a **dedicated project/folder** (`folder_id` on create) and running the whole positional flow against that folder's listing, where a sibling's default-project flow can never appear. This removes the interference at the source rather than polling around it; the poll was kept as a settle-wait on the now-isolated listing. `@stable` restored on the fix.

---

## Preconditions *(optional)*

- Langflow running and accessible at `PLAYWRIGHT_BASE_URL`.
- No LLM or API key needed.
