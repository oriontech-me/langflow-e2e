# Playground – Session Creation and Switching

**Last validated:** Langflow 1.10.x

---

## What this test validates *(required)*

Validates that users can create new sessions via the sidebar `new-chat` button and switch between sessions using the sidebar. Each session maintains isolated message history — messages sent in one session are not visible in another. If these tests fail, multi-session workflows in the Playground are broken.

---

## Tags *(required)*

`@stable` `@regression` `@playground`

---

## Step by step *(required)*

**Test 1 — new-chat creates an isolated session**
1. Set up ChatInput → ChatOutput flow and open Playground
2. Send "default-session-message" in Default session
3. Click `new-chat` button — verify sidebar `session-selector` count increases by 1
4. Verify new session starts with empty chat (0 `div-chat-message` elements)
5. Send "new-session-message" in new session
6. Click first `session-selector` (Default session) in the sidebar
7. Verify "default-session-message" is visible in `div-chat-message` and "new-session-message" is not

**Test 2 — Switching sessions via sidebar preserves isolation in both directions**
1. Set up flow, open Playground, send "switch-test-default" in Default session
2. Click `new-chat`, send "switch-test-new-session" in new session
3. Click first `session-selector` (Default) — verify Default message visible, new-session message absent
4. Click last `session-selector` (new session) — verify new-session message visible, Default message absent

---

## Validation criterion *(required)*

- After `new-chat`, sidebar has one more `session-selector` item
- New session has 0 messages immediately after creation
- After switching sessions, only the selected session's messages are shown in `div-chat-message`
- Message isolation is verified in both switch directions

---

## External dependencies *(required)*

- `src/frontend/src/components/core/playgroundComponent/chat-view/chat-header/components/chat-sidebar.tsx` — `new-chat` button
- `src/frontend/src/components/core/playgroundComponent/chat-view/chat-header/components/session-selector.tsx` — `session-selector` items

---

## What this test does not cover *(optional)*

- The `session-selector-trigger` header dropdown (`ChatSessionsDropdown`) is architecturally untestable in normal flow: it lives inside the `{!isFullscreen}` conditional in `ChatHeader`, and the flow-page playground always opens in fullscreen mode (`FlowPage.onOpenChange` sets `isFullscreen=true`). The element is never rendered during a standard test run. Session switching via the sidebar exercises the same underlying store logic.
- Session persistence across browser reloads (covered in `playground-history-persist.spec.ts`)
- Session rename (covered in `playground-session-rename.spec.ts`)

---

## Preconditions *(optional)*

- Langflow running at `PLAYWRIGHT_BASE_URL`
- No LLM required — ChatInput → ChatOutput is synchronous
