# Playground – Bulk Session Deletion

**Last validated:** Langflow 1.10.x

---

## What this test validates *(required)*

Validates the bulk session management controls in the Playground sidebar: individual session selection via checkbox, select-all toggle, and bulk deletion. If these tests fail, users cannot efficiently manage multiple sessions at once.

---

## Tags *(required)*

`@stable` `@regression` `@playground`

---

## Step by step *(required)*

**Test 1 — Individual checkbox reveals bulk-delete-button**
1. Set up flow, open Playground, create 1 user session via `new-chat`
2. Click `session-{id}-checkbox` for the user session
3. Verify `bulk-delete-button` becomes visible

**Test 2 — select-all-checkbox selects all non-default sessions**
1. Create 2 user sessions
2. Click `select-all-checkbox`
3. Verify ≥2 individual session checkboxes exist and `bulk-delete-button` is visible
4. Click `select-all-checkbox` again — verify `bulk-delete-button` is removed from DOM (count 0)

**Test 3 — bulk-delete-button removes all selected sessions**
1. Create 2 user sessions, select all via `select-all-checkbox`
2. Click `bulk-delete-button`
3. Verify sidebar has exactly 1 `session-selector` (only Default session remains)
4. Verify no `session-{id}-checkbox` elements remain

---

## Validation criterion *(required)*

- `bulk-delete-button` appears only when at least one session is selected; it is removed from the DOM (not hidden) when `selectedSessions.size === 0`
- After `select-all-checkbox`, all individual session checkboxes are present and `bulk-delete-button` is visible
- After bulk delete, sidebar returns to exactly 1 session (Default)

---

## External dependencies *(required)*

- `src/frontend/src/components/core/playgroundComponent/chat-view/chat-header/components/chat-sidebar.tsx` — `select-all-checkbox`, `bulk-delete-button`, and the `selectedSessions` state
- `src/frontend/src/components/core/playgroundComponent/chat-view/chat-header/components/session-selector.tsx` — `session-{id}-checkbox` on each user session row

---

## Notes *(optional)*

- The Default session (`flowId`) is excluded from checkboxes — only user-created sessions are selectable.
- `select-all-checkbox` renders only after the first non-default session entry exists in the list.
- No confirmation dialog is shown before bulk deletion — `handleBulkDelete` fires directly.
