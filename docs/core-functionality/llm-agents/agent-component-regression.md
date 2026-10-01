# Agent Component Regression

**Last validated:** Langflow 1.13.x (nightly `1.13.0.dev28`)

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

`@stable` was removed from "agent interaction suite" and the test was
quarantined with `test.fixme` for #2095 (empty reply on `1.13.0.dev27`/`dev28`).
**Lifted in #2046**: the reply was never empty. The completion wait did not
wait, and the spec read the bot bubble before the model had written to it (see
the note on the completion gate below). Measured on `1.13.0.dev28`: 0/3 with the
old wait, 3/3 with the gate.

---

## Step by step *(required)*

The spec generates **2 tests per active model** via `resolveTestTargets()`. By default (nightly/CI) it runs 1 model per provider; `ALL_MODELS=true` runs all models from `models.json`.

---

**Test 1 — agent interaction suite**

Single `load()` per model — all validations share the same Playground session via `expect.soft` (all run even if one fails).

1. Load the Simple Agent template via `SimpleAgentTemplatePage.load(options)`
2. Open the Playground (`playground-btn-flow-io`) and wait for `input-chat-playground`

*Step: responds without tools connected*
3. Send "What is the capital of France?" through `sendAndAwaitPlaygroundTurn`, which waits for the turn's bot message to mount and then for `button-stop` to clear (see Notes)
4. `expect.soft`: `div-chat-message` visible with non-empty text

*Step: shows reasoning steps*
5. Send "Who was the first astronaut to walk on the Moon?" through `sendAndAwaitPlaygroundTurn`
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
5. Assert the `Build stopped` alert is visible within 10s — raised only by the stop path, so it proves the click aborted the run (see Notes)
6. Confirm that Stop button disappears and `input-chat-playground` becomes visible

---

## Validation criterion *(required)*
- Agent responds with non-empty text even without connected tools
- Reasoning steps ("Finished in Xs") appear when the model uses them (conditional check)
- Stop button halts generation — the frontend reports the aborted build (`Build stopped`) — and the input returns to its normal state
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
- `src/frontend/src/stores/flowStore.ts` — `stopBuilding()` aborts the build controller and raises the `alerts.buildStopped` error alert that Test 2 asserts; a change to that path, or to the string in `src/frontend/src/locales/en.json`, breaks Test 2
- `src/lfx/src/lfx/components/models_and_agents/` — Agent execution logic; changes to streaming or duration field generation affect multiple tests

---

## When to review this test *(optional)*
- If the "Simple Agent" template is renamed or removed from Langflow
- If the default streaming behavior changes (e.g., batch response instead of progressive tokens)
- If the `node_duration_agent` field is renamed or removed from the canvas

---

## Notes *(optional)*
- **Test structure**: 2 tests per model — `agent interaction suite` (5 validations in `test.step` with `expect.soft`) and `agent stop button` (kept separate because it is destructive). Using `expect.soft` ensures all validations run even if one fails, without losing visibility.
- **Model selection**: by default (`ALL_MODELS` omitted), `resolveTestTargets()` returns 1 model per active provider (the first one in `models.json`). To run all models: `ALL_MODELS=true`. To filter by provider: `MODEL_TEST_PROVIDER=openai`. For a specific model: `MODEL_TEST_ID=gpt-4o-mini`.
- **Streaming assertion**: waits for Stop to appear (confirms the model is actively generating), then polls `div-chat-message` text length every 100ms for up to 5s. If text grows during the polling window → streaming confirmed, loop exits early. If Stop never appears → validates final text is non-empty and returns early (step passes, remaining steps continue). If growth is not observed (Stop gone before growth, or model renders faster than the poll interval, or `div-chat-message` testid is applied only after streaming completes) → no assertion; the final-text `expect.soft` is the safety net for truly broken streaming. This replaces the previous fixed 3s sleep + conditional guard that silently passed for fast models.
- **"Finished in Xs" in the Playground**: conditional check — the text appears in `BotMessage` based on the `isBuilding` cycle of `useFlowStore`; not guaranteed in multi-message sessions or with models that respond very quickly. The canonical duration assertion is `node_duration_agent` on the canvas.
- **The stop test asserts the Stop button, it no longer probes for it (#992).** It used to read `isVisible({ timeout: 30000 }).catch(() => false)` and `return` early when the button was absent, on the rationale that a fast model may answer before the button renders. That rationale rested on a false premise: `locator.isVisible()` **never waits** — Playwright marks its `timeout` option `@deprecated: this option is ignored` — so the check fired instantaneously, microseconds after the send click, and any render latency at all turned the whole test into a silent no-op that asserted nothing while reporting green. As a `@stable` test that would blind the daily on this surface. The gate is now `expect(stopButton).toBeVisible({ timeout: 30000 })`, which polls for real. The prompt asks for a long story, so the button is visible for the whole stream on every model target; if some future model does finish before it renders, the failure is the correct signal — investigate then, do not restore the bypass.
- **The completion gate was not benign either (#2046).** The same `isVisible({ timeout })` shape lived on inside this file's `waitForAgentToFinish`, which an earlier version of this note called *"benign and deliberate"* because a real assertion always follows. Nothing follows that can wait for a reply. Measured on `1.13.0.dev28` by sampling the DOM every 10 ms after Send:
  - `button-stop` renders **380–450 ms** after the click, so the probe returned `false` in 3 of 3 runs and skipped the wait.
  - The bot `div-chat-message` mounts **empty** at the same moment and fills in 1–2 s later.
  - The step's `toBeVisible` therefore resolved on the empty bubble, and `innerText()` read `""`.

  That is #2095's signature, `toBeGreaterThan(1)` with received 0. It fails 3/3 on OpenAI, and its Actions rows (09-29 anthropic, 09-30 google) show the step at 503/510 ms against 2427/2472 ms on the passing retries. The steps now send through `tests/helpers/ui/playground-turn.ts` → `sendAndAwaitPlaygroundTurn`, the #569/#354 shape:
  1. Count `div-chat-message` before Send.
  2. Poll until the count rises, or an `error-card-stack` appears.
  3. Wait for `button-stop` to be hidden, then for `button-send` to be visible.

  Measured 3/3 with the step at ~2.3 s. `button-stop` and the role-`Stop` button are **different elements**: the role one lingers ~400 ms after the testid one clears. The gate keys on the testid, as `memory-history-regression` does.
- **The stop test could not detect a Stop that does nothing (#2046).** Force-failing it by removing the Stop click left it green: on `gpt-4o-mini` the story finishes on its own well inside the 30 s `toBeHidden` budget, so "Stop disappeared and the input came back" is also what a run that was never stopped looks like. The test now asserts the `Build stopped` alert after the click. `flowStore.stopBuilding()` raises it (`alerts.buildStopped`) when it aborts the build controller, and nothing else does, so a run that completes naturally never shows it. With the assert, the same mutation fails. The text is English because the suite pins `en-US` and Langflow renders English unless `localStorage.languagePreference` says otherwise.
- `dispatchEvent("click")` on the Stop button bypasses Playwright actionability checks — the button may be transitioning during stream teardown.
- **Credential-settle gate (#751)**: on the 1.11 unified model selector, opening the Agent model dropdown auto-binds the node's `api_key` to the *default* credential (e.g. `ANTHROPIC_API_KEY`); selecting the target provider's model rebinds it to that provider's credential (`OPENAI_API_KEY`, …) **asynchronously**. `SimpleAgentTemplatePage.load()` now blocks until the persisted `Agent.api_key.value` equals the provider's credential (`providerConfigMap[provider].envKeys[0]`) before returning, so a spec that opens the Playground and sends a message cannot race the rebind and run the selected model with the wrong provider's key (which surfaced as `Flow build failed: Incorrect API key provided` and a `div-chat-message` that never rendered — the daily-#744 signature).
- **Flow cleanup**: an `afterEach` deletes the flow each test created via the API (id-scoped, `getAuthToken` bearer). The suite previously relied on the removed `load()`-time global clear (#553) and leaked one Simple Agent flow per run.
