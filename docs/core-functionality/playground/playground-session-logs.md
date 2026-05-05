# Playground – Message Logs

**Last validated:** Langflow 1.10.x

---

## What this test validates *(required)*

Validates that the Session Logs modal opens correctly from the session more menu and displays the session's messages in an ag-grid table. If this test fails, users cannot inspect individual message history for a session.

---

## Tags *(required)*

`@stable` `@regression` `@playground` (Test 1)
`@regression` `@playground` (Test 2 — skipped, see Notes)

---

## Step by step *(required)*

**Test 1 — Open Message Logs modal**
1. Set up flow, open Playground, send a message
2. Click session more menu (`[data-testid^="session-"][data-testid$="-more-menu"]`)
3. Click `message-logs-option`
4. Verify modal opens with "Session logs" heading and the sent message visible inside `[role="dialog"]`

**Test 2 — Delete messages from the table (skipped)**
1. Set up flow, open Playground, send a message
2. Open Session Logs modal
3. Click `.ag-selection-checkbox` to select the row — verify `delete-row-button` appears
4. Click `delete-row-button` — verify table has 0 rows

---

## Validation criterion *(required)*

- "Session logs" text is visible after clicking `message-logs-option`
- Sent message text appears inside the modal dialog

---

## External dependencies *(required)*

- `src/frontend/src/components/core/playgroundComponent/chat-view/chat-header/components/session-more-menu.tsx` — `message-logs-option`
- `src/frontend/src/modals/IOModal/components/session-view.tsx` — table with row selection and delete; controls `playgroundPage` flag
- `src/frontend/src/components/core/parameterRenderComponent/components/tableComponent/components/TableOptions/index.tsx` — `delete-row-button`

---

## Notes *(optional)*

- **Test 2 is permanently skipped:** When the Session Logs modal is opened from the Playground, `SessionView` receives `playgroundPage === true`, which sets `rowSelection={undefined}` and `onDelete={undefined}`. As a result, `.ag-selection-checkbox` and `delete-row-button` are never rendered. The test body is retained for future reference in case this restriction is lifted.
- The Session Logs modal renders `"Session logs"` with a lowercase L (confirmed from source).
- The ag-grid table shows both the user message and the bot echo as separate rows; assertions use `.first()` to target either.
