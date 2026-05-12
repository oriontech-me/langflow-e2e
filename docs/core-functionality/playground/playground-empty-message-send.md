# Playground — Empty Message Send Behavior

**Last validated:** Langflow 1.10.x

---

## What this test validates *(required)*

Validates send button state and input field behavior in the Playground when dealing with empty input. Covers two scenarios: send button state when the input is empty (Langflow keeps it enabled by design) and input field state after clearing typed content.

---

## Tags *(required)*

`@stable` `@release` `@regression` `@workspace` `@playground`

---

## Step by step *(required)*

**Test 1 — send button stays enabled regardless of input content**
1. Create a blank flow with ChatInput connected to ChatOutput via `setupPlayground`
2. Open the Playground via `playground-btn-flow-io`
3. Wait for `input-chat-playground` to be visible
4. Confirm the input value is `""` (empty)
5. Assert that `button-send` is **enabled** — pins Langflow's design choice of keeping send unconditionally enabled while no file upload is in flight

**Test 2 — clearing the input after typing leaves the field empty**
1. Create a blank flow with ChatInput connected to ChatOutput via `setupPlayground`
2. Open the Playground via `playground-btn-flow-io`
3. Wait for `input-chat-playground` to be visible
4. Fill the input with `"some message"` and confirm the value
5. Call `input.clear()` on the input
6. Assert the input value is `""` (empty)

---

## Validation criterion *(required)*

- **Test 1:** `button-send` is enabled even when `input-chat-playground` is empty. In `button-send-wrapper.tsx`, the `disabled` attribute is tied only to `isLoading` (file upload in progress); chat-text emptiness intentionally does not gate the button. The assertion pins this contract so any regression to a content-aware disabled state surfaces for review.
- **Test 2:** The message input field is empty after previously entered text is cleared.

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

- Test 1 documents Langflow's intentional design: `button-send` is only disabled while a file upload is in progress, not when the textarea is empty. This is a deliberate UX choice — if the team ever switches to a content-aware disabled state, the test will fail and prompt a review of the new contract.
- The `noInput` prop seen in the source (`flow-page-sliding-container.tsx`) signals that the flow has no `ChatInput` node and triggers a different UI (`NoInputView`); it is unrelated to whether the textarea is empty.
- The ChatInput → ChatOutput flow is deterministic and requires no LLM or API keys.
