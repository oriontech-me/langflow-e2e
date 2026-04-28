# Agent Component Regression

**Last validated:** Langflow 1.10.x

---

## What this test validates *(required)*
Validates the core behavior of the Agent component in Langflow: response without tools, reasoning steps display, progressive streaming, duration indicator, and multiple consecutive messages. Covers regression ID 147 (agent failed when no tool was connected) and ensures that the fundamental Agent execution behaviors remain stable across each release cycle. Parameterized by provider/model via `models.json`, automatically covering OpenAI, Anthropic, and Google.

If any of these tests fail, the LLM Agent is broken for Playground use.

---

## Tags *(required)*
`@stable` `@release` `@components` `@agents` `@playground`

---

## Step-by-step *(required)*

The spec generates **2 tests per active model** via `getTestTargets()`. By default (nightly/CI) it runs 1 model per provider; `ALL_MODELS=true` runs all models from `models.json`.

---

**Test 1 — agent interaction suite**

Single `load()` per model — all validations share the same Playground session via `expect.soft` (all run even if one fails).

1. Load the Simple Agent template via `SimpleAgentTemplatePage.load(options)`
2. Open the Playground (`playground-btn-flow-io`) and wait for `input-chat-playground`

*Step: responds without tools connected*
3. Send "What is the capital of France?" and wait for `waitForAgentToFinish`
4. `expect.soft`: `div-chat-message` visible with non-empty text

*Step: shows reasoning steps*
5. Send "Who was the first astronaut to walk on the Moon?" and wait for response
6. `expect.soft`: `div-chat-message` visible; conditionally check (soft) if "Finished in" appears

*Step: streams response progressively and displays duration*
7. Send a long prompt (5-paragraph AI summary) and wait for the first message
8. Capture initial text; wait 3s; if Stop is still visible: `expect.soft` that text grew
9. Wait for Stop to disappear; `expect.soft` final response is non-empty
10. Conditionally check (soft) if "Finished in Xs" appears

*Step: handles multiple consecutive messages*
11. `expect.soft`: count of `div-chat-message` ≥ 2

*Step: response time visible on canvas after closing playground*
12. Click `playground-close-button`
13. `expect.soft`: `node_duration_agent` visible on the canvas

---

**Test 2 — agent stop button must halt execution mid-run**

Kept separate from the suite because it interrupts the execution state.

1. Load the Simple Agent template (new independent `load()`)
2. Open the Playground and send a long prompt (18th century explorer story)
3. If Stop button does not appear within 30s: test passes (model responded early — valid behavior)
4. Click the Stop button via `dispatchEvent("click")`
5. Confirm that Stop button disappears and `input-chat-playground` becomes visible

---

## Validation criteria *(required)*
- Agent responds with non-empty text even without connected tools
- Reasoning steps ("Finished in Xs") appear when the model uses them (conditional check)
- Stop button halts generation and the input returns to its normal state
- `node_duration_agent` visible on canvas after closing the Playground (canonical duration assertion — comes from the backend)
- Playground text grows during long generation (streaming confirmed)
- Multiple consecutive messages accumulate in the Playground history

---

## What this test does not cover *(optional)*
- Configuration of external tools (Composio, MCP) in the Agent
- Tool calling validation with real tools
- Memory/context behavior across distinct sessions
- Structured output (JSON schema)

---

## Preconditions *(optional)*
- Langflow running and accessible at `PLAYWRIGHT_BASE_URL`
- `models.json` and `providers.json` generated via `npx playwright test tests/collect-models.spec.ts`
- At least one active API key in `.env` (OpenAI, Anthropic, or Google)
- Run with `--workers=1` to avoid flow conflicts in Langflow

---

## External dependencies *(required)*

- `src/frontend/src/components/core/playgroundComponent/` — main Playground component; changes to `input-chat-playground`, `button-send`, `div-chat-message`, or `playground-close-button` break this spec
- `src/frontend/src/components/core/flowToolbarComponent/` — `playground-btn-flow-io` button that opens the Playground from the editor
- `src/frontend/src/CustomNodes/GenericNode/components/NodeStatus/index.tsx` — renders `node_duration_agent` on the canvas after execution
- `src/backend/base/langflow/components/agents/` — Agent execution logic; changes to streaming or duration field generation affect multiple tests

---

## When to revisit this test *(optional)*
- If the "Simple Agent" template is renamed or removed from Langflow
- If the default streaming behavior changes (e.g., batch response instead of progressive tokens)
- If the `node_duration_agent` field is renamed or removed from the canvas

---

## Notes *(optional)*
- **Test structure**: 2 tests per model — `agent interaction suite` (5 validations in `test.step` with `expect.soft`) and `agent stop button` (kept separate because it is destructive). Using `expect.soft` ensures all validations run even if one fails, without losing visibility.
- **Model selection**: by default (`ALL_MODELS` omitted), `getTestTargets()` returns 1 model per active provider (the first one in `models.json`). To run all models: `ALL_MODELS=true`. To filter by provider: `MODEL_TEST_PROVIDER=openai`. For a specific model: `MODEL_TEST_ID=gpt-4o-mini`.
- **"Finished in Xs" in the Playground**: conditional check — the text appears in `BotMessage` based on the `isBuilding` cycle of `useFlowStore`; not guaranteed in multi-message sessions or with models that respond very quickly. The canonical duration assertion is `node_duration_agent` on the canvas.
- The Stop button is checked with `isVisible({ timeout: 30000 }).catch(() => false)` — fast models may respond before the button appears, and that is valid behavior.
- `dispatchEvent("click")` on the Stop button bypasses Playwright actionability checks — the button may be transitioning during stream teardown.
