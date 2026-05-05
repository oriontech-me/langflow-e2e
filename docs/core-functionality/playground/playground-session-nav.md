# Playground – Session Creation and Navigation

**Last validated:** Langflow 1.10.x

---

## What this test validates *(required)*

Covers two related session navigation behaviors in the Playground:

1. **New session creation via `new-chat`** — clicking the button adds a new entry to the session sidebar and opens an empty chat input.
2. **Session switching via the header dropdown (`session-selector-trigger`)** — opening the dropdown lists all sessions; selecting one loads that session's messages and hides the others.

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

**Test 2 — session selector dropdown must switch to the selected session**

1. Create a ChatInput → ChatOutput flow and open the Playground
2. Send "default session message" in the Default session; wait for the echo to appear
3. Click `new-chat`; send "new session message"; wait for the echo
4. Click `session-selector-trigger` to open the header dropdown
5. Assert the `Default Session` menu item is visible
6. Click `Default Session`
7. Assert "default session message" is visible and "new session message" count is 0

---

## Validation criterion *(required)*

- After `new-chat`: `session-selector` count increases by 1 and `input-chat-playground` is visible
- After switching sessions: only the target session's messages are shown; the other session's messages have count 0

---

## External dependencies *(required)*

- `chat-sidebar.tsx` — `data-testid="new-chat"` (creates session) and `data-testid="session-selector"` (sidebar items)
- `chat-sessions-dropdown.tsx` — `data-testid="session-selector-trigger"` (header dropdown trigger); dropdown items labeled "Default Session" or the session ID (Radix `role="menuitem"`)
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
