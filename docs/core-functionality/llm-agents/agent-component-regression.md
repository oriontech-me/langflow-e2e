# Agent Component Regression

**Last validated:** Langflow 1.12.x

---

## What this test validates *(required)*
Validates the core behavior of the Agent component in Langflow: response without tools, reasoning steps display, progressive streaming, duration indicator, and multiple consecutive messages. Covers regression ID 147 (agent failed when no tool was connected) and ensures that the fundamental Agent execution behaviors remain stable across each release cycle. Parameterized by provider/model via `models.json`, automatically covering OpenAI, Anthropic, and Google.

If any of these tests fail, the LLM Agent is broken for Playground use.

---

## Tags *(required)*
`@stable` `@release` `@components` `@agents` `@playground`

`@stable` was removed from "agent stop button must halt execution mid-run" by
the weekly triage for #355 (deterministic hard failure, 120s `waitForSelector`
on the stop button, two consecutive runs) and **restored in #992**: on
1.12.0.dev7 the test finishes in ~10s and the failure no longer reproduces —
no code change was needed, only the verification.

---

## Step by step *(required)*

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
7. Send a long prompt (5-paragraph AI summary) and wait for `div-chat-message` to be visible
8. Wait for Stop button to appear (confirms model is actively generating); if Stop never appears → validate final text is non-empty and `return` (step succeeds, remaining steps continue)
9. Poll every 100ms while Stop is visible (max 5s): if text length grows → `streamingObserved = true`; loop exits on growth or when Stop disappears
10. Wait for Stop to disappear; `expect.soft` final response is non-empty
11. If text growth was detected during polling → streaming confirmed (loop exited early); if not → no assertion (model renders faster than poll interval, or `div-chat-message` testid is applied after streaming completes)
12. Conditionally check (soft) if "Finished in Xs" appears

*Step: handles multiple consecutive messages*
13. `expect.soft`: count of `div-chat-message` ≥ 2

*Step: response time visible on canvas after closing playground*
14. Click `playground-close-button`
15. `expect.soft`: `node_duration_agent` visible on the canvas

---

**Test 2 — agent stop button must halt execution mid-run**

Kept separate from the suite because it interrupts the execution state.

1. Load the Simple Agent template (new independent `load()`)
2. Open the Playground and send a long prompt (18th century explorer story)
3. Assert the Stop button becomes visible within 30s — it is the subject of this test, so its absence is a failure, not a reason to skip (#992)
4. Click the Stop button via `dispatchEvent("click")`
5. Confirm that Stop button disappears and `input-chat-playground` becomes visible

---

## Validation criterion *(required)*
- Agent responds with non-empty text even without connected tools
- Reasoning steps ("Finished in Xs") appear when the model uses them (conditional check)
- Stop button halts generation and the input returns to its normal state
- `node_duration_agent` visible on canvas after closing the Playground (canonical duration assertion — comes from the backend)
- Playground text grows while Stop is visible during long generation (streaming confirmed via polling — not a fixed sleep)
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

## When to review this test *(optional)*
- If the "Simple Agent" template is renamed or removed from Langflow
- If the default streaming behavior changes (e.g., batch response instead of progressive tokens)
- If the `node_duration_agent` field is renamed or removed from the canvas

---

## Notes *(optional)*
- **Test structure**: 2 tests per model — `agent interaction suite` (5 validations in `test.step` with `expect.soft`) and `agent stop button` (kept separate because it is destructive). Using `expect.soft` ensures all validations run even if one fails, without losing visibility.
- **Model selection**: by default (`ALL_MODELS` omitted), `getTestTargets()` returns 1 model per active provider (the first one in `models.json`). To run all models: `ALL_MODELS=true`. To filter by provider: `MODEL_TEST_PROVIDER=openai`. For a specific model: `MODEL_TEST_ID=gpt-4o-mini`.
- **Streaming assertion**: waits for Stop to appear (confirms the model is actively generating), then polls `div-chat-message` text length every 100ms for up to 5s. If text grows during the polling window → streaming confirmed, loop exits early. If Stop never appears → validates final text is non-empty and returns early (step passes, remaining steps continue). If growth is not observed (Stop gone before growth, or model renders faster than the poll interval, or `div-chat-message` testid is applied only after streaming completes) → no assertion; the final-text `expect.soft` is the safety net for truly broken streaming. This replaces the previous fixed 3s sleep + conditional guard that silently passed for fast models.
- **"Finished in Xs" in the Playground**: conditional check — the text appears in `BotMessage` based on the `isBuilding` cycle of `useFlowStore`; not guaranteed in multi-message sessions or with models that respond very quickly. The canonical duration assertion is `node_duration_agent` on the canvas.
- **The stop test asserts the Stop button, it no longer probes for it (#992).** It used to read `isVisible({ timeout: 30000 }).catch(() => false)` and `return` early when the button was absent, on the rationale that a fast model may answer before the button renders. That rationale rested on a false premise: `locator.isVisible()` **never waits** — Playwright marks its `timeout` option `@deprecated: this option is ignored` — so the check fired instantaneously, microseconds after the send click, and any render latency at all turned the whole test into a silent no-op that asserted nothing while reporting green. As a `@stable` test that would blind the daily on this surface. The gate is now `expect(stopButton).toBeVisible({ timeout: 30000 })`, which polls for real. The prompt asks for a long story, so the button is visible for the whole stream on every model target; if some future model does finish before it renders, the failure is the correct signal — investigate then, do not restore the bypass.
- The same `isVisible({ timeout })` shape survives inside `waitForAgentToFinish` and its siblings across the agent specs. That usage is benign and deliberate: there the button is a *completion probe* ("already gone ⇒ the run finished"), not the observable under test, and a real assertion always follows.
- `dispatchEvent("click")` on the Stop button bypasses Playwright actionability checks — the button may be transitioning during stream teardown.
- **Credential-settle gate (#751)**: on the 1.11 unified model selector, opening the Agent model dropdown auto-binds the node's `api_key` to the *default* credential (e.g. `ANTHROPIC_API_KEY`); selecting the target provider's model rebinds it to that provider's credential (`OPENAI_API_KEY`, …) **asynchronously**. `SimpleAgentTemplatePage.load()` now blocks until the persisted `Agent.api_key.value` equals the provider's credential (`providerConfigMap[provider].envKeys[0]`) before returning, so a spec that opens the Playground and sends a message cannot race the rebind and run the selected model with the wrong provider's key (which surfaced as `Flow build failed: Incorrect API key provided` and a `div-chat-message` that never rendered — the daily-#744 signature).
- **Flow cleanup**: an `afterEach` deletes the flow each test created via the API (id-scoped, `getAuthToken` bearer). The suite previously relied on the removed `load()`-time global clear (#553) and leaked one Simple Agent flow per run.
