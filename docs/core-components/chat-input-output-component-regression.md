# Chat Input / Chat Output Components — Regression

**Last validated:** Langflow 1.13.x (nightly `1.13.0.dev5`)

---

## What this test validates *(required)*

Validates the canvas-side surface of the **Chat Input** and **Chat Output** components — the two endpoints of every Playground flow — without depending on an LLM. ChatInput → ChatOutput is a Message pass-through, so the suite stays deterministic and provider-independent (same approach used by `webhook-component-regression`).

The 6 tests cover:

1. **Chat Input renders on canvas** — title, run button, `Chat Message` output handle, default `Input Text` (`textarea_str_input_value`) field, output-inspection button, and exactly one node on the canvas after adding via the sidebar.
2. **Chat Output renders on canvas** — title, run button, `Inputs` input handle, output-inspection button, and exactly one node on the canvas.
3. **Chat Input → Chat Output connection accepted** — clicking the source handle then the target handle on Message ↔ Message creates exactly one edge; both nodes remain on the canvas.
4. **Input Text propagates from ChatInput to ChatOutput on run** — configure the `Input Text` field with a known string, run from the Chat Output run button, and confirm the value reaches the ChatOutput output-inspection dialog.
5. **Sender name override is reflected in the Playground chat message** — toggle the advanced `sender_name` field, set it to `"QA"`, and verify the user-side message in the Playground renders with `chat-message-QA-{text}` (the testid is built directly from the upstream sender_name).
6. **Default sender_name values are the literal constants** — `Chat Input` defaults to `"User"` and `Chat Output` defaults to `"AI"` when the field is toggled visible. The defaults come from `MESSAGE_SENDER_NAME_USER` / `MESSAGE_SENDER_NAME_AI` in `lfx/utils/constants.py`; there is **no** fallback to the authenticated username.

If any of these tests fails, one of the two endpoints of the Playground is broken — either rendering on the canvas, the Message connection contract, runtime pass-through, or the constants that drive sender labels in the chat UI.

---

## Tags *(required)*

`@stable` `@regression` `@components`

All 6 tests carry `@stable` per the project rule "spec is born 100% @stable; tag is removed per-test only during weekly triage".

Test 1 was the one exception until **#1504**: it was `test.fixme` and untagged, quarantined at the triage of daily #1417 for the swallowed sidebar **click** (the click lands and no node is placed), and its owner #1423 was closed on 2026-08-17 by a PR that lifted a different pair, leaving the test off the daily with nobody watching. The quarantine is now lifted and `@stable` restored, on two independent grounds: the add routes through `addComponentFromSidebar`, which detects a dropped add and re-issues it (#1304), and the product defect underneath was fixed upstream in `langflow#14523` — the affordance is `disabled` while the permission window is open, so the click waits it out instead of being discarded (`docs/upstream-bugs/UPSTREAM-BUG-sidebar-add-permission-gate-dead-window.md` §9). Re-validated on `1.13.0.dev5`: 18/18 at `--retries=0` (6 on a quiet instance, 12 with three workers against one backend), on top of the 16/16 under four concurrent processes already recorded on #1423 at `1.12.0.dev30`. Test 6's `@stable` was auto-removed by the daily workflow for #1468 and restored on `1.12.0.dev30`.

---

## Step by step *(required)*

**Setup helpers**

- `addChatInputComponent(page)` — opens a blank flow, adds Chat Input via the sidebar, focuses the node and clicks `more-options-modal` → `expand-button-modal` so the run button and inspector content become available (ChatInput defaults to `minimized = True`).
- `addChatOutputToCanvas(page)` — drags Chat Output onto an existing flow, then expands it the same way.
- `connectChatInputToChatOutput(page)` — clicks `handle-chatinput-shownode-chat message-right` then `handle-chatoutput-shownode-inputs-left` and asserts exactly one `.react-flow__edge` is present.
- `runFlowAndOpenChatOutputInspection(page)` — clicks `button_run_chat output`, waits for "built successfully", opens `output-inspection-output message-chatoutput`, and returns the dialog text content.

**Test 1 — Chat Input rendering**
1. Run `addChatInputComponent(page)`
2. Assert `title-Chat Input` and `button_run_chat input` are visible
3. Assert the output handle `handle-chatinput-shownode-chat message-right` is visible
4. Assert the `textarea_str_input_value` field is visible (default `Input Text` field)
5. Assert `output-inspection-chat message-chatinput` is visible
6. Assert `.react-flow__node` count is exactly `1`

**Test 2 — Chat Output rendering**
1. Open a blank flow, add Chat Output via the sidebar, expand the node
2. Assert `title-Chat Output` and `button_run_chat output` are visible
3. Assert the input handle `handle-chatoutput-shownode-inputs-left` is visible
4. Assert `output-inspection-output message-chatoutput` is visible
5. Assert `.react-flow__node` count is exactly `1`

**Test 3 — connection accepted**
1. Run `addChatInputComponent` and `addChatOutputToCanvas`
2. Assert two nodes exist on the canvas
3. Run `connectChatInputToChatOutput`
4. Assert two nodes still exist and both titles remain visible

**Test 4 — Input Text propagation**
1. Run `addChatInputComponent`
2. Fill `textarea_str_input_value` with `"regression-chat-passthrough-42"` and assert the field holds that value
3. Run `addChatOutputToCanvas` and `connectChatInputToChatOutput`
4. Run `runFlowAndOpenChatOutputInspection` and assert the returned text contains the input string
5. Press `Escape` to close the dialog

**Test 5 — sender_name override via Playground**
1. Run `addChatInputComponent`
2. `openAdvancedOptions` → click `showsender_name` → `closeAdvancedOptions`
3. Scope a locator to the Chat Input `.react-flow__node` (filtered by `title-Chat Input`), fill its `popover-anchor-input-sender_name` with `"QA"` and assert the value
4. Run `addChatOutputToCanvas` and `connectChatInputToChatOutput`
5. Click `playground-btn-flow-io` and wait for `input-chat-playground` to be visible
6. Fill the playground input with `"sender-override-regression"` and click `button-send`
7. Assert that `chat-message-QA-sender-override-regression` is visible (timeout 30s)

**Test 6 — default sender_name values**
1. Run `addChatInputComponent`
2. Open advanced options, click `showsender_name`, close advanced options
3. Scope a locator to the Chat Input `.react-flow__node` (filtered by `title-Chat Input`) and assert its `popover-anchor-input-sender_name` has value `"User"`
4. Run `addChatOutputToCanvas`, click `title-Chat Output` to focus it
5. Open advanced options, click `showsender_name`, close advanced options
6. Scope each assertion to its own `.react-flow__node` container (filtered by `title-Chat Input` / `title-Chat Output`) and assert `popover-anchor-input-sender_name` is `"User"` on Chat Input and `"AI"` on Chat Output — using node-scoped filters keeps the test resilient to DOM ordering changes

---

## Validation criterion *(required)*

- Both Chat Input and Chat Output add to a blank flow and render with their titles, run buttons, default handles, and inspection buttons.
- Connecting `chat message` (right) → `inputs` (left) succeeds and produces exactly one edge.
- A string set on Chat Input's `Input Text` reaches Chat Output's output inspection after running the flow from `button_run_chat output`.
- Setting Chat Input's `sender_name` to `"QA"` and sending a message in the Playground produces the testid `chat-message-QA-{message}`.
- Default `sender_name` field value is `"User"` for Chat Input and `"AI"` for Chat Output (no authenticated-username fallback).
- **`afterEach`**: every flow the run created (one per test, from `blank-flow`) is deleted **id-scoped** via the shared tracker (`trackCreatedFlows`, #1108), and `GET /api/v1/flows/` shows no leftover `New Flow`. Added in #1220 — until then this spec had **no cleanup at all** and leaked one flow per test on the shared instance (measured: 24 orphans across two full runs plus four force-fail runs of this file and its `chat-input-files` sibling; purged while validating, and the re-run left the flow count unchanged at 1).
- **Assistant onboarding tooltip**: suppressed before the first document load via `seedAssistantDiscovered(page)` in `beforeEach` — the only point at which it can be suppressed, since upstream reads the flag at mount of the canvas-controls bar and then arms a 10 s timer. `expandFocusedNode` asserts the seed ran and fails loudly, naming the fix, if a test added to this file later forgets it (#1220).

---

## External dependencies *(required)*

- `src/lfx/src/lfx/components/input_output/chat.py` — `ChatInput.message_response()`: emits the Message with the configured `sender_name`. Renaming `input_value`, `sender_name`, or the output `name="message"` breaks tests 1, 4, 5, and 6.
- `src/lfx/src/lfx/components/input_output/chat_output.py` — `ChatOutput.message_response()`: receives the Message and re-stamps its own `sender_name`. Renaming `input_value`, the output `name="message"`, or the `Output Message` display name breaks tests 2, 4, and 6.
- `src/lfx/src/lfx/utils/constants.py` — defines `MESSAGE_SENDER_NAME_USER = "User"` and `MESSAGE_SENDER_NAME_AI = "AI"`. Test 6 asserts these literal defaults; changing the constants flips the assertion.
- `src/frontend/src/CustomNodes/GenericNode/` — renders the handles using the `handle-{component}-shownode-{port}-{side}` pattern. The `chat message` and `inputs` port names must remain stable.
- `src/frontend/src/CustomNodes/GenericNode/components/NodeOutputParameter/` — renders the output-inspection buttons (`output-inspection-{display_name.toLowerCase()}-{component_type_lowercase}`). Renaming `Chat Message` or `Output Message` breaks the test 1, 2, and 4 selectors.
- `src/frontend/src/modals/IOModal/components/chatView/chatMessage/chat-message.tsx` — generates the `chat-message-{sender_name}-{text}` testid from the upstream sender_name; test 5 depends on this format.
- `src/frontend/src/components/core/parameterRenderComponent/` — renders `popover-anchor-input-sender_name`, `textarea_str_input_value`, and the `showsender_name` advanced-options toggle.

---

## What this test does not cover *(optional)*

- Chat Input multimodal/file attach via the canvas-side `Files` inspector field — covered by `chat-input-files-field-regression.spec.ts`.
- Chat Input template variables / advanced settings beyond `sender_name`.
- Playground rendering of the AI-side message (already covered by the Playground @stable suite).
- Session ID isolation / context_id propagation (covered by `playground-session-id.spec.ts` and `playground-session-clear.spec.ts`).
- Chat Output `data_template` behavior when receiving a Data object instead of a Message.

---

## Preconditions *(optional)*

- Langflow running and accessible at `PLAYWRIGHT_BASE_URL`.
- No API key required — the spec is fully LLM-free.
- Tests 4 and 5 require the autosave/build pipeline to be functional (the "built successfully" toast, plus the Playground send button) within the configured timeouts.
- Both Chat Input and Chat Output start `minimized = True` in upstream Langflow; the helpers expand them via `more-options-modal` → `expand-button-modal` so the run button and full inspector are reachable. If the expand-button testid changes, all tests break at the helper.

---

## When to review this test *(optional)*

- If `MESSAGE_SENDER_NAME_USER` or `MESSAGE_SENDER_NAME_AI` change in `lfx/utils/constants.py`, test 6 must be updated.
- If the Chat Input output display name moves away from `"Chat Message"`, the `output-inspection-chat message-chatinput` selector and the `handle-chatinput-shownode-chat message-right` selector both break.
- If the Chat Output output display name moves away from `"Output Message"`, the `output-inspection-output message-chatoutput` selector breaks.
- If the chat message testid pattern in `chat-message.tsx` changes (e.g. removes the sender_name prefix), test 5 breaks.
- If Chat Input or Chat Output stop being `minimized = True` by default, the `expandFocusedNode` helper becomes unnecessary — the assertions still pass but the helper can be simplified.

---

## Notes *(optional)*

- Test 5 deliberately validates the override through the **Playground** rather than the canvas-side output-inspection dialog, because the dialog renders a Message as plain text (no metadata fields exposed in `textContent`). The Playground's `chat-message-{sender_name}-{text}` testid is the user-visible surface where the override actually shows up.
- Test 6 validates the defaults at the **inspector level** (the field value) rather than running the flow. The field value is the upstream of any runtime behavior — this avoids the same dialog-rendering limitation as test 5 while still catching a regression in the constants.
- **The sidebar add is guarded on two axes, and both guards exist because a measurement demanded them (#1468).** Every add here goes through `openBlankFlowFromModal` and `fillSidebarSearch` instead of clicking `blank-flow` and filling `sidebar-search-input` inline. Measured on nightly `1.12.0.dev30` with four harnesses driving one backend — **31 failures in 348 adds (8.9 %)**, and **0 in 30** on a quiet instance, which is why none of this reproduces locally. The failures split into two modes with distinct observables:
  - **The templates modal never closes** (9 of 21 tabulated; `role="dialog"` present, absent in all 16 measured successes; `400 POST /api/v1/flows/` in 6 of the 9 — the "flow must be unique" collision, which `mode: "serial"` cannot prevent because it is across the daily's shards, not within this file). The sidebar is then covered and the fill times out. This mode hits the guarded and unguarded fills alike, which is why it — not the remount — is the likeliest cause of test 6's hard failure on the 2026-08-17 daily.
  - **The sidebar remounts and discards the typed term** (12 of 21, **all** of them on a fill issued with no prior wait for the input to be visible, **0** on a guarded fill). An in-page probe sampling every animation frame recorded the input node ABSENT at ~102 ms and a NEW empty one at ~156 ms. Since 1.12 a component row only exists in the DOM under a filter, so `input_output<Display Name>` never appears and the wait ends as `element(s) not found` with no add attempted.
  Neither mode is slowness: re-typing into the remounted input recovered 0 of 4, a reload 4 of 4, and a raised timeout reaches neither. After the two guards: **0 failures in 200 adds** under the same load, including two paired rounds run in the same window as the unguarded harness (0/80 against 3/80). The reload repair inside `fillSidebarSearch` never fired in those 200 — the barrier is what carries the fix, and the repair is a fallback covered by unit tests only.
- The original issue (#184) framed test 6 as "default sender uses authenticated username when `sender_name` is empty"; the actual upstream behavior (verified against `lfx/components/input_output/chat.py` and the upstream integration test `test_chat_input.test_default`) is that the default is the literal string `"User"`, with no username fallback. The test was reframed to match real behavior.
