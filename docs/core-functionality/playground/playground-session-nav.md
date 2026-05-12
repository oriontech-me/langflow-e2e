# Playground – Session Creation and Navigation

**Last validated:** Langflow 1.10.x

---

## What this test validates *(required)*

Covers two related session navigation behaviors in the Playground:

1. **New session creation via `new-chat`** — clicking the button adds a new entry to the session sidebar and opens an empty chat input.
2. **Session switching via the sidebar (`session-selector`)** — clicking a session entry in the sidebar loads that session's messages and hides the others.

These ensure users can manage multiple parallel conversations without cross-contamination between sessions.

---

## Tags *(required)*

`@stable` `@regression` `@playground`

---

## Step by step *(required)*

**Test 1 — new-chat button must add a new session entry to the sidebar**

1. Create a ChatInput → ChatOutput flow and open the Playground via `playground-btn-flow-io`
2. Count the current number of `session-selector` entries
3. Click `new-chat`
4. Assert `session-selector` count is `before + 1`
5. Assert `input-chat-playground` is visible (new empty chat is active)

**Test 2 — session selector sidebar must switch to the selected session**

1. Create a ChatInput → ChatOutput flow and open the Playground
2. Send "default session message" in the Default session; wait for the echo to appear
3. Click `new-chat`; send "new session message"; wait for the echo
4. Click the `session-selector` sidebar entry that contains "Default Session"
5. Assert "default session message" is visible and "new session message" count is 0

---

## Validation criterion *(required)*

- After `new-chat`: `session-selector` count increases by 1 and `input-chat-playground` is visible
- After clicking a sidebar session entry: only that session's messages are shown; the other session's messages have count 0

---

## External dependencies *(required)*

- `src/frontend/src/components/core/playgroundComponent/chat-view/chat-header/components/chat-sidebar.tsx` — `data-testid="new-chat"` (creates session)
- `src/frontend/src/components/core/playgroundComponent/chat-view/chat-header/components/session-selector.tsx` — `data-testid="session-selector"` (sidebar items); clicking an item switches the active session; item displays "Default Session" when `session === currentFlowId`
- No API key required: ChatInput → ChatOutput is a synchronous echo flow

---

## What this test does not cover *(optional)*

- Renaming sessions (covered in `playground-session-rename.spec.ts`)
- Deleting sessions (covered in `playground-clear-history.spec.ts`)
- Bulk session deletion (covered in `playground-bulk-delete.spec.ts`)

---

## Preconditions *(optional)*

- Langflow running and accessible at `PLAYWRIGHT_BASE_URL`
- No LLM or API key needed

---

## Notes *(optional)*

- `session-selector-trigger` (the header dropdown) exists only in the fullscreen `playgroundComponent`, not in the IOModal opened via `playground-btn-flow-io`. Session switching in this test is done via the sidebar `session-selector` items.
