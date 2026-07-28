# Playground — Input Text Pre-fill Behavior

**Last validated:** Langflow 1.12.x

---

## What this test validates *(required)*

Validates that the value set in the **Chat Input** node's `input_value` field
("Input Text" on the canvas) is automatically written into the Playground
chat textarea when chat history is empty. Three behaviors are exercised:
the initial pre-fill when the Playground first opens, the re-pre-fill after
the user creates a new session, and the ability to send the pre-filled value
as the first message of a session without any user typing.

The pre-fill effect is implemented in
`flow-page-sliding-container.tsx` and runs whenever
`chatHistory.length === 0`. If this effect breaks, users lose the pre-fill
UX silently — none of the previously existing playground specs checked the
initial value of the textarea, since they all called `.fill()` immediately.

---

## Tags *(required)*

`@stable` `@regression` `@playground`

---

## Step by step *(required)*

A small helper, `setupFlowWithPrefill(page)`, performs the common setup for
all three tests:

1. Call `setupPlayground(page)` to create a `ChatInput → ChatOutput` flow
2. Poll `GET /api/v1/flows/{flowId}` until `data.edges.length >= 1`, so the
   autosave-driven persistence of the connection is confirmed before reload
3. Register a `page.route` interceptor on `**/api/v1/flows/{flowId}` that
   patches the response and writes `"prefill message"` into the ChatInput
   node's `template.input_value.value`
4. Reload the page so the canvas re-fetches the flow and renders with the
   patched template

**Test 1 — playground opens with chat textarea pre-filled from ChatInput Input Text**
1. Run `setupFlowWithPrefill`
2. Click `playground-btn-flow-io` and wait for `input-chat-playground`
3. Assert `input-chat-playground` has value `"prefill message"` — without
   any prior `.fill()` call

**Test 2 — creating a new session re-applies the Input Text pre-fill**
1. Run `setupFlowWithPrefill`
2. Open the Playground and confirm the pre-fill (history is empty)
3. Click `button-send` to dispatch the pre-filled message; wait for the
   user bubble (`chat-message-User-prefill message`) and for `button-stop`
   to disappear (run finished)
4. Click `new-chat` to create a new session
5. Assert `input-chat-playground` is once again pre-filled with
   `"prefill message"`

**Test 3 — pre-filled value is sent as the first message of the session**
1. Run `setupFlowWithPrefill`
2. Open the Playground; assert the textarea is pre-filled
3. Click `button-send` without typing anything
4. Assert `div-chat-message` is visible and that the user-bubble
   (`chat-message-User-prefill message`) shows the pre-filled value
5. Wait for `button-stop` to disappear (run finished)

---

## Validation criterion *(required)*

- **Test 1:** the chat textarea value equals the ChatInput node's
  `input_value` (`"prefill message"`) immediately on opening the Playground,
  without any user input
- **Test 2:** after sending the pre-filled message and creating a new
  session via `new-chat`, the textarea is pre-filled again with the same
  value (the effect re-fires because the new session starts with empty
  history)
- **Test 3:** clicking `button-send` with the textarea holding only the
  pre-filled value sends `"prefill message"` as the first message and the
  user bubble shows the same text

---

## External dependencies *(required)*

References in the **main Langflow repository** (compatible with Langflow 1.10.x):

- `src/frontend/src/components/core/playgroundComponent/sliding-container/components/flow-page-sliding-container.tsx`
  — defines the pre-fill `useEffect` that reads
  `chatInputNode.data.node.template["input_value"].value` when
  `chatHistory.length === 0`
- `src/frontend/src/components/core/playgroundComponent/chat-view/chat-input/components/text-area-wrapper.tsx`
  — defines `data-testid="input-chat-playground"`
- `src/frontend/src/components/core/playgroundComponent/chat-view/chat-input/components/button-send-wrapper.tsx`
  — defines `data-testid="button-send"` / `"button-stop"`
- `src/frontend/src/components/core/playgroundComponent/chat-view/chat-header/components/chat-sidebar.tsx`
  — defines `data-testid="new-chat"`
- `src/frontend/src/components/core/playgroundComponent/chat-view/chat-messages/components/bot-message.tsx`
  — defines `data-testid="div-chat-message"`
- `src/lfx/src/lfx/components/input_output/chat.py` — `ChatInput` declares
  `input_value` as a `MultilineInput` (display name "Input Text", default
  empty)

References in this repository:

- `tests/helpers/flows/setup-playground.ts` — shared helper that creates the
  ChatInput → ChatOutput flow and returns its ID for cleanup
- `tests/tests-automations/regression/core-components/webhook-component-regression.spec.ts`
  — same `page.route` interception pattern used here to inject a value into
  a node template that has no editable canvas UI

---

## What this test does not cover *(optional)*

- Sending the pre-filled value when an LLM-backed flow is used — this spec
  uses `ChatInput → ChatOutput` (echo) which is deterministic and free
- The pre-fill behavior with non-empty history (the effect intentionally
  does **not** overwrite the textarea once the user has interacted)
- Pre-fill behavior in the fullscreen Playground at `/playground/{id}` —
  only the IOModal flavor is exercised here

---

## Preconditions *(optional)*

- Langflow running and accessible at `PLAYWRIGHT_BASE_URL`
- No pre-existing flow needed; `setupPlayground` creates the flow and
  `afterEach` deletes it via `DELETE /api/v1/flows/{id}`
- ChatInput defaults to `minimized = True`, which collapses the node and
  hides `input_value` from the canvas UI — that is why the value is
  injected via the API response interceptor instead of being typed into a
  visible textarea on the node

---

## Notes *(optional)*

- The interceptor only handles `GET` requests — `PATCH`/`DELETE` to the
  same URL fall through with `route.fallback()` so autosave traffic and the
  cleanup `DELETE /api/v1/flows/{id}` are not touched
- The injected value is written into the **response** of
  `GET /api/v1/flows/{flowId}` — the database row keeps `input_value=""`,
  so cleanup via `DELETE /api/v1/flows/{id}` still works with no extra
  steps
- `page.unrouteAll({ behavior: "ignoreErrors" })` is called in `afterEach`
  to remove the interceptor between tests in the serial group
