# Playground — History Persistence

**Last validated:** Langflow 1.10.x

---

## What this test validates *(required)*
Validates that messages sent in the Playground survive a close/reopen cycle. If this test fails, users lose their conversation history when they close and reopen the Playground — a critical regression in the chat UX.

This test complements `llm-agents/memory-history-regression.spec.ts`, which covers the same guarantee via a real LLM and API key. This spec uses a ChatInput → ChatOutput echo flow (no credentials required) so it can run in any CI environment.

---

## Tags *(required)*
`@stable` `@regression` `@playground`

---

## Step by step *(required)*

**Test 1 — messages sent in playground must persist after closing and reopening**
1. Create a blank flow with ChatInput connected to ChatOutput via `setupPlayground()`
2. Open the Playground via `playground-btn-flow-io` and wait for `input-chat-playground`
3. Send the message "history test" and wait for the user bubble `chat-message-User-history test` to appear
4. Wait for `button-stop` to become hidden — this guarantees the run finished and the message has been persisted by the backend before closing
5. Close the Playground via `playground-close-button`; confirm `input-chat-playground` is gone
6. Reopen the Playground via `playground-btn-flow-io`
7. Assert `chat-message-User-history test` is still visible (persisted via backend `/api/v1/run/` and reloaded by `useGetMessagesQuery`)

---

## Validation criterion *(required)*
- The specific user bubble `chat-message-User-history test` is visible after the close/reopen cycle (asserting the exact sent message — not any generic chat bubble — proves real persistence and avoids false positives from the echoed AI reply)
- No mocked API calls — the flow runs end-to-end through the Langflow backend

---

## External dependencies *(required)*
- `src/frontend/src/components/core/playgroundComponent/` — main Playground component; changes to `data-testid="playground-close-button"`, `data-testid="input-chat-playground"`, `data-testid="button-send"`, `data-testid="button-stop"`, or `data-testid="chat-message-User-{text}"` break this test
- `src/frontend/src/components/core/flowToolbarComponent/` — `playground-btn-flow-io` button that opens the Playground
- `src/backend/base/langflow/api/v1/chat.py` — message persistence endpoint; regressions here break the assertion after reopen

---

## What this test does not cover *(optional)*
- Context retention across messages (covered by `memory-history-regression.spec.ts`)
- Session isolation (covered by `playground-session-nav.spec.ts`)
- Persistence across page reloads (covered by `memory-history-regression.spec.ts`)

---

## Preconditions *(optional)*
- Langflow running and accessible at `PLAYWRIGHT_BASE_URL`
- No API keys required — ChatInput → ChatOutput echo needs no LLM

---

## When to review this test *(optional)*
- If message persistence is moved to a different backend endpoint or the `useGetMessagesQuery` hook is replaced
- If the Playground close/open mechanism changes (e.g., router-based navigation instead of a button)
