# Playground – Clear Chat (Default Session)

**Last validated:** Langflow 1.12.x

---

## What this test validates *(required)*

Validates that the **Clear chat** action in the Default session header menu removes all messages from the active chat without deleting the session itself.

This is a focused regression guard for the `clear-chat-option` path: open the header more-menu, click "Clear chat", and confirm that `div-chat-message` drops to zero. If this breaks, users lose the ability to reset the Default session's conversation history.

---

## Tags *(required)*

`@stable` `@regression` `@playground`

---

## Step by step *(required)*

1. Create a ChatInput → ChatOutput echo flow (no LLM required) and open the Playground via `playground-btn-flow-io`
2. Send "hello clear test" and wait for the bot echo to appear as `div-chat-message`
3. Assert at least one `div-chat-message` exists (pre-condition)
4. Open the header menu by calling `.evaluate((el) => el.click())` on `chat-header-more-menu` (bypasses framer-motion overlay)
5. Assert `clear-chat-option` is visible
6. Click `clear-chat-option`
7. Assert `div-chat-message` count is 0

---

## Validation criterion *(required)*

- After clicking `clear-chat-option`: `div-chat-message` count drops to 0

---

## External dependencies *(required)*

- `src/frontend/src/components/core/playgroundComponent/chat-view/chat-header/components/chat-header.tsx` — `clear-chat-option` is rendered only when `isDefaultSession` is true; clicking it fires `clearDefaultSession`. Any rename of the `data-testid` or change to the default-session condition will break the test.
- `src/frontend/src/components/core/playgroundComponent/chat-view/chat-header/components/session-more-menu.tsx` — `chat-header-more-menu` trigger wrapped in `AnimatedConditional` (framer-motion); that is why `evaluate((el) => el.click())` is used instead of a coordinate-based click.

---

## What this test does not cover *(optional)*

- Deleting a user-created session (covered in `playground-clear-history.spec.ts`)
- Renaming sessions (covered in `playground-session-rename.spec.ts`)
- Session persistence across page reloads

---

## Preconditions *(optional)*

- Langflow running and accessible at `PLAYWRIGHT_BASE_URL`
- No LLM or API key needed: ChatInput → ChatOutput acts as a synchronous echo

---

## Notes *(optional)*

- `evaluate((el) => el.click())` is intentional: the menu trigger sits inside an `AnimatedConditional` that may have an overlapping sibling during the animation, making coordinate-based clicks unreliable.
- `playground-clear-history.spec.ts` covers the same clear-chat behavior but in a more comprehensive serial suite that also covers delete-session. This spec is a simpler standalone guard for the clear-chat path only.
