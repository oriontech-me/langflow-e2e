# Playground — Clear History & Session Delete

**Last validated:** Langflow 1.12.x

---

## What this test validates *(required)*

Validates session management actions in the Playground:

1. **Clear chat** on the Default session removes all messages from the chat without deleting the session itself.
2. **Delete session** on a user-created session removes it from the session list and returns the user to the Default session.

These are distinct operations: Default sessions expose "Clear chat"; user-created sessions expose "Delete" (and never "Clear chat"). If either breaks, users lose the ability to manage conversation history.

---

## Tags *(required)*

`@stable` `@release` `@regression` `@playground`

---

## Step by step *(required)*

**Test 1 — clear chat on Default session must remove messages but keep the session**

1. Build the flow with the shared `setupPlayground` helper: it creates the flow over
   the API, navigates straight to `/flow/{id}`, and wires ChatInput → ChatOutput
   (echo setup, no LLM required). It returns the flow id for id-scoped cleanup
2. Open the Playground via `playground-btn-flow-io`
3. Send a message ("Hello from test") and confirm it appears as `div-chat-message`
4. Open the Default session menu via `chat-header-more-menu` (using `evaluate` to bypass framer-motion overlay)
5. Click `clear-chat-option`
6. Confirm `div-chat-message` count drops to 0
7. Confirm `chat-header-more-menu` is still present (session was not deleted)

**Test 2 — deleting a user-created session must remove it and return to Default session**

1. Build the same ChatInput → ChatOutput flow (`setupPlayground`) and open the Playground
2. Click `new-chat` to create a new session
3. Send a message ("Message in new session") in the new session
4. Open the session menu via `chat-header-more-menu` and click `delete-session-option`
5. Confirm `chat-header-more-menu` is visible (app returned to Default session)
6. Re-open the menu and confirm `clear-chat-option` is present (confirms Default session is active)
7. Confirm `delete-session-option` has count 0 (not available on Default)

---

## Validation criterion *(required)*

- After clearing: `div-chat-message` count is 0 and `chat-header-more-menu` remains visible
- After deleting: session sidebar entry count decreases by 1; app shows Default session menu (`clear-chat-option` visible, `delete-session-option` absent)

---

## External dependencies *(required)*

- `src/frontend/src/components/core/chatComponents/chatHeader/chat-header.tsx` — `isDefaultSession` logic controls which menu options are shown (`clear-chat-option` vs `delete-session-option`). Any change to this conditional or to the `data-testid` attributes will break these tests.
- `src/frontend/src/components/core/chatComponents/chatHeader/` — `data-testid="chat-header-more-menu"` menu trigger; wrapped in `AnimatedConditional` (framer-motion), which is why `evaluate((el) => el.click())` is used instead of a coordinate-based click.

---

## What this test does not cover *(optional)*

- Renaming a session (covered separately)
- Deleting individual messages within a session
- Session persistence across page reloads
- Voice mode or advanced Playground features

---

## Preconditions *(optional)*

- Langflow running and reachable at `PLAYWRIGHT_BASE_URL`
- No pre-existing flows required; the setup creates a flow per test and `cleanAllFlows` removes it in `afterEach`
- No LLM or API key needed: ChatInput → ChatOutput acts as a synchronous echo

---

## When to review this test *(optional)*

- If the session menu trigger (`chat-header-more-menu`) is renamed or restructured
- If `isDefaultSession` logic changes (e.g., session IDs are no longer compared to the flow ID)
- If framer-motion animation is removed and `evaluate`-based click can be replaced by a normal `.click()`

---

## Notes *(optional)*

- Tests run in `serial` mode because Test 2 asserts a session **count** in the
  playground sidebar, which a concurrent sibling on the same flow would perturb.
  Cleanup is id-scoped — this file never calls `cleanAllFlows`, so it cannot
  delete a parallel worker's flow (#465/#515). The earlier note claiming
  `cleanAllFlows` was the reason for serial mode was stale.
- **Sidebar entry race (#1063).** Both tests previously built the flow through the
  home page → "New Flow" → templates modal → `blank-flow` path, and flaked because
  `FlowPage` mounts the whole `FlowSidebarComponent` inside a `display: none`
  wrapper while the welcome overlay is open — so `sidebar-search-input` sat in the
  DOM with an empty bounding box, which Playwright reports as `hidden`. "New Flow"
  opens that overlay **before** navigating and "Browse more templates" does not
  close it, so the setup raced a multi-hop settle it did not drive. `setupPlayground`
  creates the flow over the API and never opens the overlay, so the condition is
  gone rather than re-budgeted. Full chain in `docs/ui-ux/execution-error-notification.md`.
- Cleanup passes an explicit bearer from `getAuthToken`: under AUTO_LOGIN a bare
  request context is unauthenticated, so an unheadered `DELETE` 401s and silently
  leaks the flow.
- `evaluate((el) => el.click())` is intentional: the menu trigger sits inside an `AnimatedConditional` that may have an overlapping sibling div during the animation, making coordinate-based clicks unreliable
- `evaluate((el) => el.click())` is intentional: the menu trigger sits inside an `AnimatedConditional` that may have an overlapping sibling div during the animation, making coordinate-based clicks unreliable
