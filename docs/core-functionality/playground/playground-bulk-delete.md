# Playground – Bulk Session Delete

**Last validated:** Langflow 1.10.x

---

## What this test validates *(required)*

Validates the bulk session selection and deletion feature in the Playground sidebar:

1. **Individual session checkbox** — clicking a per-session checkbox reveals the `bulk-delete-button`.
2. **Select All** — clicking `select-all-checkbox` selects every non-default session simultaneously.
3. **Bulk delete** — clicking `bulk-delete-button` removes all selected sessions and leaves the Default Session intact.

The Default session is excluded from bulk operations by design: `selectableSessions = sessions.filter(s => s !== flowId)`.

---

## Tags *(required)*

`@stable` `@regression` `@playground`

---

## Step by step *(required)*

**Test 1 — individual checkbox must reveal bulk-delete-button**

1. Create a ChatInput → ChatOutput flow and open the Playground
2. Click `new-chat` to create one non-default session
3. Assert `bulk-delete-button` count is 0 (no selection yet)
4. Click the per-session checkbox: `[data-testid$="-checkbox"]:not([data-testid="select-all-checkbox"])` (first match)
5. Assert `bulk-delete-button` is visible

**Test 2 — select-all-checkbox must select all non-default sessions**

1. Create a ChatInput → ChatOutput flow and open the Playground
2. Click `new-chat` twice to create two non-default sessions
3. Click `select-all-checkbox`
4. Assert `bulk-delete-button` is visible (at least one session selected)

**Test 3 — bulk-delete-button must delete selected sessions**

1. Create a ChatInput → ChatOutput flow and open the Playground
2. Click `new-chat` twice; record total `session-selector` count and selectable count
3. Click `select-all-checkbox`; assert `bulk-delete-button` is visible
4. Click `bulk-delete-button`
5. Assert `session-selector` count is `totalBefore - selectableCount`
6. Assert "Default Session" entry is still visible

---

## Validation criterion *(required)*

- Individual checkbox: `bulk-delete-button` appears after first selection
- Select all: `bulk-delete-button` visible; all selectable checkboxes in selected state
- Bulk delete: session count decreases by the number of selected sessions; Default Session entry remains

---

## External dependencies *(required)*

- `chat-sidebar.tsx` — `data-testid="select-all-checkbox"` (appears between Default session and first non-default session when `selectableSessions.length > 0`); `data-testid="bulk-delete-button"` (appears when `selectedSessions.size > 0`)
- `session-selector.tsx` — `data-testid="session-${session}-checkbox"` (dynamic; rendered only when `showCheckbox={selectableSessions.includes(session)}`)
- Default session is never selectable; its entry never has a checkbox

---

## What this test does not cover *(optional)*

- Deselecting individual sessions after a select-all
- Bulk-delete confirmation dialog (none exists; deletion is immediate)
- Session isolation or message persistence after bulk deletion

---

## Preconditions *(optional)*

- Langflow running and accessible at `PLAYWRIGHT_BASE_URL`
- No LLM or API key needed
