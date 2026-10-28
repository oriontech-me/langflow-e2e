# Playground — Chat UX

**Last validated:** Langflow 1.14.x

---

## What this test validates *(required)*

Validates the chat UX behavior in the Playground using a deterministic flow (ChatInput → ChatOutput), without LLM dependency. Covers three fundamental properties: immediate rendering of the user's message, auto-scroll after sending and input field readiness after the flow responds.

Every wait for "the flow responded" goes through `sendAndAwaitPlaygroundTurn`, which requires the turn to **start** (a new `div-chat-message` mounts) before it waits for it to **finish** (`button-stop` hidden, `button-send` back). Waiting only for the input to be enabled is not a completion signal — see *Notes*.

---

## Tags *(required)*

`@release` `@regression` `@playground` `@stable`

---

## Step by step *(required)*

**Test 1 — user message must appear instantly in playground before AI responds**
1. Create a blank flow with ChatInput connected to ChatOutput via `setupPlayground`
2. Open the Playground via `playground-btn-flow-io`
3. Confirm that `input-chat-playground` is visible
4. Fill the field with "Hello from regression test" and click `button-send`
5. Confirm that the user message (`chat-message-User-<text>`) appears in the chat within 3 s
6. Wait for the turn to start and finish (`sendAndAwaitPlaygroundTurn`)

**Test 2 — playground must scroll to latest message after sending**
1. Create a blank flow with ChatInput connected to ChatOutput via `setupPlayground`
2. Open the Playground via `playground-btn-flow-io`
3. Send 6 sequential messages, waiting for each turn to start and finish (`sendAndAwaitPlaygroundTurn`) before typing the next one
4. Confirm that the last message ("Message 6.") is visible and within the viewport

**Test 3 — playground input field must be ready after flow responds**
1. Create a blank flow with ChatInput connected to ChatOutput via `setupPlayground`
2. Open the Playground via `playground-btn-flow-io`
3. Send "Hi." and wait for the turn to start and finish (`sendAndAwaitPlaygroundTurn`)
4. Confirm that the input is visible and enabled
5. Confirm that it accepts a follow-up ("Follow-up message.")

---

## Validation criterion *(required)*

- User message appears in the chat with a 3 s timeout after clicking send
- The last message of a sequence is visible and within the viewport after sending
- The `input-chat-playground` field is enabled after the turn has finished and accepts new input — the follow-up is typed only once the turn is over, so the read-back proves the input is ready, not that text typed before the build survived

---

## External dependencies *(required)*

References in the **main Langflow repository** (compatible with Langflow 1.14.x):

- `src/frontend/src/components/core/playgroundComponent/chat-view/chat-input/components/text-area-wrapper.tsx` — defines `data-testid="input-chat-playground"`
- `src/frontend/src/components/core/playgroundComponent/chat-view/chat-input/components/button-send-wrapper.tsx` — defines `data-testid="button-send"`
- `src/frontend/src/components/core/playgroundComponent/chat-view/chat-messages/components/bot-message.tsx` — renders bot messages with `data-testid="div-chat-message"`
- `src/frontend/src/components/core/playgroundComponent/chat-view/chat-messages/components/user-message.tsx` — renders user messages with `data-testid="chat-message-User-<text>"`
- `src/frontend/src/stores/flowStore.ts` — `buildFlow`, which awaits the flow version check before it sets `isBuilding` (see *Notes*)
- `src/frontend/src/hooks/flows/use-check-flow-version.ts` — `checkFlowVersion`, the request that opens the pre-build window and can end the run before it builds
- `src/frontend/src/components/ui/simple-sidebar.tsx` — defines `data-testid="playground-btn-flow-io"`

References in this repository:

- `tests/helpers/flows/setup-playground.ts` — shared helper that sets up the flow and returns the ID for cleanup
- `tests/helpers/ui/playground-turn.ts` — `sendAndAwaitPlaygroundTurn`, the start-then-finish wait every send in this spec goes through

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
- **Why the input being enabled is not a completion signal (#2368).** Since upstream #14903 (multi-user editing safety, in nightlies from `1.13.0.dev27`), `buildFlow` awaits `GET /api/v1/flows/{id}/version-state` before it sets `isBuilding` whenever the open flow carries a `version_token` (every flow this spec creates does), and the textarea is `disabled={isBuilding || noInput}`. So after Send the input is cleared but stays **enabled** until that request returns: measured on `1.14.0.dev8`, `toBeEnabled` passed 9 ms after the click and the input went disabled ~50 ms later, ~350–870 ms later with simulated backend latency. A `toBeEnabled` right after Send therefore passes before the build has started, and the "follow-up" is typed into a turn that has not happened yet — the recurrent VM flake of #2368. Typed text survives that window in every local probe (25 runs, including simulated latency and 8x CPU throttling), so this is a wait-strategy defect, not a product regression. The exact VM end state (empty value and disabled input) was not reproduced locally. The same check can also end the run **without building** when it answers `adopted` (the server's version moved and nobody edited locally) or `conflict`; this spec would then fail loudly on "the Playground turn never started" rather than pass, and that signature is the one to look for if the flake returns.
