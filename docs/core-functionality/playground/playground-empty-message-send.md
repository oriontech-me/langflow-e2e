# Playground — Empty Message Send Behavior

**Last validated:** Langflow 1.10.x

---

## What this test validates *(required)*

Validates send button state and input field behavior in the Playground when dealing with empty input. Covers three scenarios: send button state when the input is empty (documenting a known Langflow bug), send button state after typing a message, and input field state after clearing typed content.

---

## Tags *(required)*

`@stable` `@release` `@regression` `@workspace` `@playground`

---

## Step by step *(required)*

**Test 1 — send button is enabled when input is empty (Langflow bug)**
1. Create a blank flow with ChatInput connected to ChatOutput via `setupPlayground`
2. Open the Playground via `playground-btn-flow-io`
3. Wait for `input-chat-playground` to be visible
4. Confirm the input value is `""` (empty)
5. Assert that `button-send` is **enabled** — documents the current buggy behavior

**Test 2 — send button becomes enabled after typing a message**
1. Create a blank flow with ChatInput connected to ChatOutput via `setupPlayground`
2. Open the Playground via `playground-btn-flow-io`
3. Wait for `input-chat-playground` to be visible
4. Fill the input with `"Hello, Langflow!"`
5. Confirm the input holds the typed value
6. Assert that `button-send` is enabled

**Test 3 — clearing the input after typing leaves the field empty**
1. Create a blank flow with ChatInput connected to ChatOutput via `setupPlayground`
2. Open the Playground via `playground-btn-flow-io`
3. Wait for `input-chat-playground` to be visible
4. Fill the input with `"some message"` and confirm the value
5. Call `input.clear()` on the input
6. Assert the input value is `""` (empty)

---

## Validation criterion *(required)*

- **Test 1 (bug documentation):** `button-send` is enabled even when `input-chat-playground` is empty. This reflects the **current buggy behavior**; the assertion must be updated to expect the button to be disabled once Langflow fixes the issue.
- **Test 2:** `button-send` is enabled after the user types a non-empty message.
- **Test 3:** The message input field is empty after previously entered text is cleared.

---

## External dependencies *(required)*

References in the **main Langflow repository** (compatible with Langflow 1.10.x):

- `src/frontend/src/components/core/playgroundComponent/chat-view/chat-input/components/text-area-wrapper.tsx` — defines `data-testid="input-chat-playground"`
- `src/frontend/src/components/core/playgroundComponent/chat-view/chat-input/components/button-send-wrapper.tsx` — defines `data-testid="button-send"`
- `src/frontend/src/components/ui/simple-sidebar.tsx` — defines `data-testid="playground-btn-flow-io"`

References in this repository:

- `tests/helpers/flows/setup-playground.ts` — shared helper that creates the ChatInput → ChatOutput flow and returns its ID for cleanup

---

## What this test does not cover *(optional)*

- Sending a message while a response is in progress
- Streaming, polling, and direct response modes
- Voice mode and advanced Playground features

---

## Preconditions *(optional)*

- Langflow running and accessible at `PLAYWRIGHT_BASE_URL`
- No pre-existing flow needed; the `setupPlayground` helper creates the flow and the `afterEach` deletes it via `DELETE /api/v1/flows/{id}`

---

## Notes *(optional)*

- Test 1 intentionally documents a **known Langflow bug**: the send button remains enabled on empty input. It reflects actual behavior; once the bug is fixed, the assertion must be updated to expect the button to be disabled and the test name updated accordingly.
- The ChatInput → ChatOutput flow is deterministic and requires no LLM or API keys.
