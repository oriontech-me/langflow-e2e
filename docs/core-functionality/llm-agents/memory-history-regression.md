# Memory Chatbot — History and Memory Regression

**Last validated:** Langflow 1.10.x

---

## What this test validates *(required)*

Validates the core behavior of the **Memory Chatbot** template: loading the flow structure, context retention between messages within the same Playground session, history persistence after closing and reopening the Playground, and session isolation (distinct sessions have independent histories). If any of these tests fail, the Memory Chatbot is broken for real use.

---

## Tags *(required)*

`@stable` `@release` `@agents` `@playground`

---

## Step by step *(required)*

The spec contains **3 tests** inside `test.describe("Memory Chatbot Regression")`.

---

**Test 1 — memory chatbot template loads with correct node structure**

Does not require an API key. Validates only the canvas structure.

1. Delete existing flows and load the "Memory Chatbot" template from `All Templates`
2. Wait for `canvas_controls_dropdown` to appear; adjust view and update components
3. *Step: canvas has all 6 required nodes* — `expect.soft` for each of the 6 nodes:
   - `title-Chat Input`, `title-Chat Output`, `title-Message History`
   - `title-Language Model`, `title-Prompt Template`, `note_node`
4. *Step: canvas has exactly 6 nodes* — count `.react-flow__node` and assert `=== 6`

---

**Test 2 — message history context retention suite**

Requires `OPENAI_API_KEY`. Groups behavior validations in `test.step` with `expect.soft`.

1. Load the Memory Chatbot template and configure OpenAI via `setupLanguageModelOpenAI`:
   - If `model_model` is not visible (providers not configured): click the "Setup Provider" button (no data-testid) → select `provider-item-OpenAI` → fill the API key with `pressSequentially` → click "Save" → wait for the "Replace" button to appear → enable `[data-testid^="llm-toggle"]` toggles → close with Escape → wait for `model_model` to appear
   - Click `model_model` and select `gpt-4o-mini`
2. Open the Playground (`playground-btn-flow-io`) and wait for `input-chat-playground`
3. *Step: context retention* — Send `"My name is Alice..."`, wait for response, send `"What is my name?"` and assert the response contains "Alice"
4. *Step: multiple messages* — count `div-chat-message` ≥ 2 (testid is present only on bot responses)
5. *Step: persistence* — close the Playground via `playground-close-button`, reopen it, confirm the message count is ≥ the previous value

---

**Test 3 — session isolation: new session has no context from previous session**

Requires `OPENAI_API_KEY`. Kept separate because it is destructive (creates a new session).

1. Load the template and configure the API key (same flow as Test 2)
2. Open the Playground, send `"My name is Bob..."`
3. Wait for the response to appear
4. Click `new-chat` (the "+" button in the sessions sidebar)
5. Wait 500ms for session state reset
6. Assert that `div-chat-message` count is `=== 0` (session starts empty)

---

## Validation criterion *(required)*

- Template loads with exactly 6 nodes: Chat Input, Chat Output, Message History, Language Model, Prompt Template, note (README)
- The LLM recalls the name provided in a previous message within the same session ("Alice")
- Bot responses accumulate in the history (`div-chat-message` ≥ 2 after 2 exchanges)
- History persists after closing and reopening the Playground
- A new session starts with 0 messages, with no context inherited from previous sessions

---

## External dependencies *(required)*

- `src/backend/base/langflow/initial_setup/starter_projects/Memory Chatbot.json` — defines the template graph at runtime (overrides the `.py`); changes to nodes or edges break Test 1
- `src/lfx/src/lfx/components/models_and_agents/memory.py` — `MemoryComponent` (`display_name = "Message History"`); renaming or removing it breaks Tests 1 and 2
- `src/lfx/src/lfx/components/models_and_agents/language_model.py` — `LanguageModelComponent` (`display_name = "Language Model"`); changes to the `model` field or `display_name` affect Tests 1, 2, and 3
- `src/frontend/src/components/core/playgroundComponent/` — `input-chat-playground`, `div-chat-message`, `playground-close-button`, `new-chat` — any rename breaks Tests 2 and 3
- `src/frontend/src/CustomNodes/GenericNode/components/NodeName/index.tsx` — `data-testid="title-{display_name}"` — a change to this testid pattern breaks Test 1
- `src/frontend/src/modals/modelProviderModal/components/ProviderConfigurationForm.tsx` — "Save" button (exact text to save the API key); changing it breaks `setupLanguageModelOpenAI`

---

## What this test does not cover *(optional)*

- Memory Chatbot behavior with other providers (Anthropic, Google) — `setupLanguageModelOpenAI` configures OpenAI only
- Validation of AI response content beyond the name reference ("Alice")
- Verification that, without the `Message History` node connected, context is lost
- History persistence after a Langflow server restart

---

## Preconditions *(optional)*

- Langflow running and accessible at `PLAYWRIGHT_BASE_URL`
- `OPENAI_API_KEY` defined in `.env` for Tests 2 and 3
- Run with `--workers=1` to avoid flow conflicts

---

## When to review this test *(optional)*

- If the "Memory Chatbot" template is removed or renamed in `starter_projects`
- If the `LanguageModelComponent` changes its `display_name` or the default session behavior changes
- If the "Save" button in the provider modal changes its text (breaks `setupLanguageModelOpenAI`)
- If the `new-chat` button in the sessions sidebar is renamed (breaks Test 3)
- If the Playground adds a confirmation modal when creating a new session (Test 3 will need an extra step)

---

## Notes *(optional)*

- **Template structure at runtime**: the template loads from `Memory Chatbot.json` (not the `.py`), with 6 nodes: Chat Input, Chat Output, Prompt Template, Message History, Language Model (not OpenAI directly), note/README.
- **`div-chat-message`**: testid present only on bot responses (`bot-message.tsx`), not on user messages. 2 exchanges → count = 2 (not 4).
- **`setupLanguageModelOpenAI`**: local function in the spec that configures OpenAI via the "Setup Provider" modal. Uses `pressSequentially` (not `fill`) to ensure keyboard events on React controlled inputs. Waits for the "Replace" button to appear to confirm the save completed.
- **`new-chat`**: the "+" button in the sessions sidebar (`chat-sidebar.tsx`). Functional equivalent of "New Session" in the `session-selector-trigger` dropdown (which may be hidden by animation in certain builds).
- **Test 1 without API key**: pure structure validation — useful in CI without configured keys.
