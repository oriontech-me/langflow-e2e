# Memory Chatbot — History and Memory Regression

**Last validated:** Langflow 1.11.0

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

> **Template redesigned upstream (first shipped in 1.11.0.dev34):** the
> Memory Chatbot starter project is now an **Agent + Memory Base** flow —
> the previous `Message History` / `Language Model` / `Prompt Template`
> trio was replaced by a single `Agent` node plus the new `Memory Base`
> component (verified in the container's
> `initial_setup/starter_projects/Memory Chatbot.json`). Structure
> assertions track the shipped template (issue #550).

1. Load the "Memory Chatbot" template from `All Templates`, capturing the created flow's id (no pre-cleanup of existing flows — a wipe kills parallel workers' in-flight flows, #553; duplicate names auto-suffix; each test deletes its own flow by id in `afterEach`)
2. Wait for `canvas_controls_dropdown` to appear; adjust view and update components
3. *Step: canvas has all 5 required nodes* — `expect.soft` for each of the 5 nodes:
   - `title-Chat Input`, `title-Chat Output`, `title-Agent`
   - `title-Memory Base`, `note_node`
4. *Step: canvas has exactly 5 nodes* — count `.react-flow__node` and assert `=== 5`

---

**Test 2 — message history context retention suite**

Requires `OPENAI_API_KEY`. Groups behavior validations in `test.step` with `expect.soft`.

1. Load the Memory Chatbot template and configure OpenAI via `setupLanguageModelOpenAI`:
   - If `model_model` is not visible (providers not configured): click the "Setup Provider" button (no data-testid) → select `provider-item-OpenAI` → fill the API key with `pressSequentially` → click "Save" → wait for the "Replace" button to appear → enable `[data-testid^="llm-toggle"]` toggles → close with Escape → wait for `model_model` to appear
   - Click `model_model` and select a chat model **resiliently**: `MODEL_TEST_ID` (env) if set → first available preferred cheap chat model (`gpt-4o-mini`, then `gpt-5.4-nano`, `gpt-5.4-mini`, …) → first option that is not a non-chat model (image/embedding/audio). This adapts to builds where `gpt-4o-mini` was dropped from the OpenAI bundle (1.11.0 ships `gpt-5.x` instead) and avoids slow/expensive models that would reintroduce the LLM-response timeout
2. Open the Playground (`playground-btn-flow-io`) and wait for `input-chat-playground`
3. *Step: context retention* — Send `"My name is Alice..."`, wait for the response to **complete** (`waitForChatResponse` counts `chat-message-token-usage` badges, which render once per finished response), send `"What is my name?"` and assert the latest `div-chat-message` contains "Alice"
4. *Step: multiple messages* — web-first `expect.poll` on `div-chat-message` count asserting `>= 2` (testid is present only on bot responses). Not an exact count: the classic template is a linear flow (exactly 2 responses), but the agent-based Memory Chatbot template on nightly emits extra intermediate tool/memory-retrieval bubbles, so the bubble count is non-deterministic (`>= 2`). An exact `toHaveCount(2)` false-failed on the agent variant when it settled on 3 (issue #466)
5. *Step: persistence* — close the Playground via `playground-close-button` (wait for `input-chat-playground` to hide), reopen it, and web-first assert `div-chat-message` count is restored to the previous value

---

**Test 3 — session isolation: new session has no context from previous session**

Requires `OPENAI_API_KEY`. Kept separate because it is destructive (creates a new session).

1. Load the template and configure the API key (same flow as Test 2)
2. Open the Playground, send `"My name is Bob..."`
3. Wait for the response to complete (`waitForChatResponse` — counts `chat-message-token-usage`)
4. Click `new-chat` (the "+" button in the sessions sidebar)
5. Web-first assert `div-chat-message` `toHaveCount(0)` — auto-retries until the session reset settles, so a reset slower than a fixed wait cannot false-fail (replaced the old `waitForTimeout(500)` + hard count)
6. *Backend-isolation probe:* send `"What is my name?"` in the NEW session and assert the response does **not** match `/Bob/i` — the UI-reset check alone (step 5) would still pass if the backend leaked memory across sessions; only a model answer proves the new session's context is really empty (inverted mirror of Test 2's positive `/Alice/i` assert). Fail-safe: a leak surfaces "Bob" and fails; a model that answers "I don't know" passes

---

## Validation criterion *(required)*

- Template loads with exactly 5 nodes: Chat Input, Chat Output, Agent, Memory Base, note (README)
- The LLM recalls the name provided in a previous message within the same session ("Alice")
- Bot responses accumulate in the history (`div-chat-message` ≥ 2 after 2 exchanges)
- History persists after closing and reopening the Playground
- A new session starts with 0 messages, with no context inherited from previous sessions

---

## External dependencies *(required)*

- `src/backend/base/langflow/initial_setup/starter_projects/Memory Chatbot.json` — defines the template graph at runtime (overrides the `.py`); changes to nodes or edges break Test 1
- `initial_setup/starter_projects/Memory Chatbot.json` — the shipped template (Agent + Memory Base since 1.11.0.dev34); node renames/additions there break Test 1
- The Agent node's `model_model` field — `setupLanguageModelOpenAI` resolves it on the Agent (the helper predates the redesign; it targets whatever node exposes `model_model`); changes there affect Tests 2 and 3
- `src/frontend/src/components/core/playgroundComponent/` — `input-chat-playground`, `div-chat-message`, `chat-message-token-usage`, `playground-close-button`, `new-chat` — any rename breaks Tests 2 and 3. `chat-message-token-usage` is the completion signal used by `waitForChatResponse`; if a future build stops rendering it (or a provider returns no token usage), the response wait must switch to another per-response completion marker
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
- **`div-chat-message`**: testid present only on bot responses (`bot-message.tsx`), not on user messages. 2 exchanges → count = 2 (not 4). **Its count is unreliable as a "response arrived" signal** — while a response streams in, the bubble mounts, unmounts on a re-render, then settles, so the count flickers. `waitForChatResponse` therefore counts `chat-message-token-usage` (rendered only once a response *completes*) instead. This was the root cause of the flaky history/isolation assertions in issue #354.
- **Model selection is resilient**: `setupLanguageModelOpenAI` no longer hardcodes `gpt-4o-mini`. It resolves `MODEL_TEST_ID` (env) → first available preferred cheap chat model → first non-image/embedding/audio option. Validated on Langflow 1.11.0, where the OpenAI bundle exposes `gpt-5.x` (e.g. `gpt-5.4-nano`) and no longer lists `gpt-4o-mini`.
- **Residual flake**: Tests 2 and 3 make live OpenAI calls, so an occasional response slower than the 120s budget can still time out — this is the inherent external-dependency flake described in issue #354, absorbed by the CI retry budget, not a test-logic bug.
- **`setupLanguageModelOpenAI`**: local function in the spec that configures OpenAI via the "Setup Provider" modal. Uses `pressSequentially` (not `fill`) to ensure keyboard events on React controlled inputs. Waits for the "Replace" button to appear to confirm the save completed.
- **`new-chat`**: the "+" button in the sessions sidebar (`chat-sidebar.tsx`). Functional equivalent of "New Session" in the `session-selector-trigger` dropdown (which may be hidden by animation in certain builds).
- **Test 1 without API key**: pure structure validation — useful in CI without configured keys.
