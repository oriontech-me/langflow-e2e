# Playground – Bulk Session Delete

**Last validated:** Langflow 1.13.x

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
3. Assert `select-all-checkbox` is visible; click it; assert `bulk-delete-button` is visible
4. Assert count ≥ 2 and every per-session checkbox has a `.text-status-red` child visible (custom div — selected state is indicated by the icon CSS class, not a native checked attribute)

**Test 3 — bulk-delete-button must delete selected sessions**

1. Create a ChatInput → ChatOutput flow and open the Playground
2. Click `new-chat` twice; record total `session-selector` count (`totalBefore`)
3. Assert `select-all-checkbox` is visible; click it; assert `bulk-delete-button` is visible; record selectable checkbox count (`selectableCount`)
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
- `session-selector.tsx` — `data-testid="session-${session}-checkbox"` (dynamic; rendered only when `showCheckbox={selectableSessions.includes(session)}`); a custom `div` — selected state is indicated by `.text-status-red` on the inner icon (`SquareCheck`), not by a native checked attribute
- Default session is never selectable; its entry never has a checkbox

References in this repository:

- `tests/helpers/flows/setup-playground.ts` — shared helper that creates the
  `ChatInput → ChatOutput` flow and returns its id for cleanup. Its
  postcondition is **durability**: every canvas edit is confirmed server-side
  (`GET /api/v1/flows/{id}`) before the next edit is made, so the three tests
  may open the Playground immediately after it returns. When that gate expires
  the helper must name **which** of the three exits fired — the read never
  completed (transport), the read came back non-2xx, or the read came back and
  the graph was stale — because only the last one is the autosave-overtake
  race of #988; the first two are the instance, not the product (#1695).

---

## What this test does not cover *(optional)*

- Deselecting individual sessions after a select-all
- Bulk-delete confirmation dialog (none exists; deletion is immediate)
- Session isolation or message persistence after bulk deletion

---

## Preconditions *(optional)*

- Langflow running and accessible at `PLAYWRIGHT_BASE_URL`
- No LLM or API key needed

---

## Notes *(optional)*

- The three tests are **independent** and run without `test.describe.configure({
  mode: "serial" })`. Each one builds its own flow through `setupPlayground`,
  creates its own sessions and deletes its flow in `afterEach`; nothing is
  handed from one test to the next. Serial mode had made a failure in the first
  test mark the other two `skipped` and restart the whole group on retry, so the
  later tests spent the retry budget without ever being measured — the collateral
  recorded in #1695. The daily's sharded lane sets `PW_SHARD_FILE_LEVEL=1`
  (`fullyParallel: false`), so the file still runs one test at a time there;
  what changes is only that a failure no longer suppresses its file-mates.
