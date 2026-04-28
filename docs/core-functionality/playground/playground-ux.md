# Playground — Chat UX

**Last validated:** Langflow 1.10.x

---

## What this test validates *(required)*

Validates the chat UX behavior in the Playground using a deterministic flow (ChatInput → ChatOutput), without LLM dependency. Covers three fundamental properties: immediate rendering of the user's message, auto-scroll after sending and input field readiness after the flow responds.

---

## Tags *(required)*

`@release` `@regression` `@playground`

---

## Step by step *(required)*

**Test 1 — user message must appear instantly in playground before AI responds**
1. Create a blank flow with ChatInput connected to ChatOutput via `setupPlayground`
2. Open the Playground via `playground-btn-flow-io`
3. Confirm that `input-chat-playground` is visible
4. Fill the field with "Hello from regression test" and click `button-send`
5. Confirm that the message text appears in the chat within 3 s
6. Wait for the input to re-enable (flow completed)

**Test 2 — playground must scroll to latest message after sending**
1. Create a blank flow with ChatInput connected to ChatOutput via `setupPlayground`
2. Open the Playground via `playground-btn-flow-io`
3. Send 6 sequential messages, waiting for the input to re-enable between each one
4. Confirm that the last message ("Message 6.") is visible and within the viewport

**Test 3 — playground input field must be ready after flow responds**
1. Create a blank flow with ChatInput connected to ChatOutput via `setupPlayground`
2. Open the Playground via `playground-btn-flow-io`
3. Send "Hi." and wait for the input to re-enable
4. Confirm that the input is visible and enabled
5. Confirm that it accepts a follow-up ("Follow-up message.")

---

## Validation criterion *(required)*

- User message appears in the chat with a 3 s timeout after clicking send
- The last message of a sequence is visible and within the viewport after sending
- The `input-chat-playground` field is enabled after flow completion and accepts new input

---

## External dependencies *(required)*

References in the **main Langflow repository** (compatible with Langflow 1.10.x):

- `src/frontend/src/components/core/playgroundComponent/chat-view/chat-input/components/text-area-wrapper.tsx` — defines `data-testid="input-chat-playground"`
- `src/frontend/src/components/core/playgroundComponent/chat-view/chat-input/components/button-send-wrapper.tsx` — defines `data-testid="button-send"`
- `src/frontend/src/components/core/playgroundComponent/chat-view/chat-messages/components/bot-message.tsx` — renders messages in the chat with `data-testid="div-chat-message"`
- `src/frontend/src/components/ui/simple-sidebar.tsx` — defines `data-testid="playground-btn-flow-io"`

References in this repository:

- `tests/helpers/flows/setup-playground.ts` — shared helper that sets up the flow and returns the ID for cleanup

---

## What this test does not cover *(optional)*

- Streaming, polling and direct response mode
- Voice mode and advanced Playground features
- Empty message sending (covered in `playground-empty-message-send.spec.ts`)
- Sending a message while a response is in progress

---

## Preconditions *(optional)*

- Langflow running and accessible at `PLAYWRIGHT_BASE_URL`
- No pre-existing flow needed; the `setupPlayground` helper creates the flow, records the ID returned by the API and deletes it via `DELETE /api/v1/flows/{id}` in the `afterEach`

---

## Notes *(optional)*

- The three tests run in `serial` mode to avoid state conflicts in the editor
- The ChatInput → ChatOutput flow is deterministic: the output echoes the input, eliminating LLM dependency and making the tests executable without API keys
