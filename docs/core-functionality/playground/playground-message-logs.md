# Playground – Message Logs

**Last validated:** Langflow 1.10.x

---

## What this test validates *(required)*

Validates the Message Logs feature accessible from the session more-menu in the Playground sidebar:

1. **Open Message Logs** — clicking `message-logs-option` in the session sidebar more-menu opens the Session Logs modal (`SessionLogsModal`) containing an ag-grid table of messages.
2. **Delete messages** — selecting rows via ag-grid checkboxes and clicking `delete-row-button` removes those rows from the table.

Message Logs give users a structured view of a session's full message history and the ability to clean up individual messages without clearing the entire session.

---

## Tags *(required)*

`@stable` `@regression` `@playground`

---

## Step by step *(required)*

**Test 1 — message-logs-option must open the Session Logs modal**

1. Create a ChatInput → ChatOutput flow and open the Playground
2. Send "test log message" and wait for the echo
3. Click the sidebar session more-menu: `[data-testid^="session-"][data-testid$="-more-menu"]` (first match = Default session)
4. Click `message-logs-option`
5. Assert "Session logs" text is visible (modal header)
6. Assert at least one `.ag-row` is present in the table

**Test 2 — selecting and deleting messages must reduce the row count**

1. Create a ChatInput → ChatOutput flow and open the Playground
2. Send "message to delete" and wait for the echo
3. Open Message Logs modal (same steps as Test 1); wait for `.ag-row` to be visible and record the initial row count (`rowsBefore`)
4. Click `.ag-checkbox-input` (first row checkbox in ag-grid)
5. Assert `delete-row-button` is enabled
6. Click `delete-row-button`
7. Assert row count is `rowsBefore - 1`

---

## Validation criterion *(required)*

- After opening: modal with "Session logs" header is visible; `.ag-row` count > 0
- After deletion: `.ag-row` count is `rowsBefore - 1`

---

## External dependencies *(required)*

- `session-more-menu.tsx` — `data-testid="message-logs-option"` (visible by default for all sessions; `showMessageLogs` defaults to `true`)
- `session-logs-modal.tsx` — renders `SessionView` inside `BaseModal`
- `session-view.tsx` — ag-grid table with `rowSelection="multiple"` and `onDelete` enabled when `playgroundPage = false` (which is the case in the embedded playground); row and checkbox selectors (`.ag-row`, `.ag-checkbox-input`) are ag-grid internal CSS classes — ag-grid does not expose `data-testid` on row elements
- `tableComponent/TableOptions/index.tsx` — `data-testid="delete-row-button"` (disabled until `hasSelection = true`)
- `flowStore.ts` — `playgroundPage` defaults to `false`; deletion is only disabled on the standalone shareable playground page

---

## What this test does not cover *(optional)*

- Editing message text inline in the table
- Pagination behavior with large numbers of messages
- Message Logs for a user-created session (same mechanism; only the sidebar menu trigger differs)

---

## Preconditions *(optional)*

- Langflow running and accessible at `PLAYWRIGHT_BASE_URL`
- No LLM or API key needed — ChatInput → ChatOutput produces real messages stored via the messages API
