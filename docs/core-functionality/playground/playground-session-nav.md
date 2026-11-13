# Playground – Session Creation and Navigation

**Last validated:** Langflow 1.14.x (`1.14.0.dev25`, #2418)

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
2. Send "default session message" in the Default session and wait for **its run** to end: the `POST /api/v2/workflows` the click issues must carry that text as `input_value` and the flow id as `session_id`, its stream must finish, the user bubble must be shown and `button-stop` must be hidden
3. Click `new-chat`; send "new session message" the same way — this run must carry that text and a `session_id` other than the flow id
4. Click the `session-selector` sidebar entry that contains "Default Session"
5. Assert "default session message" is visible and "new session message" count is 0

---

## Validation criterion *(required)*

- After `new-chat`: `session-selector` count increases by 1 and `input-chat-playground` is visible
- Each send reaches the backend as a run carrying the typed text, in the session that was active: the flow id for the Default session, another id after `new-chat`
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
- **Wait for the run, not for `button-stop` (#2418).** The run behind a send is `POST /api/v2/workflows`, and under load it can leave the page after the click by more than the test takes to reach the next step. `button-stop` is hidden *before* the run starts as well as after it ends, so `toBeHidden()` passed at once and the test clicked `new-chat` while the Default session's run was still in flight. The next send was then lost (no second run at all) or sent with an empty `input_value`, and `"new session message"` never appeared — the recurrent `toBeVisible()` flake of 2026-10-16 and 2026-11-11. Measured on `1.14.0.dev25` with 4 workers and `--retries=0`: 8 failures in 80 runs of this test before the change, 0 in 60 after it.
