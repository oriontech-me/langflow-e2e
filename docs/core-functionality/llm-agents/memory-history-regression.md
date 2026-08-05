# Memory Chatbot — History and Memory Regression

**Last validated:** Langflow 1.12.x (1.12.0.dev17)

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
2. `loadTemplateByName` waits for `canvas_controls_dropdown`, then update components (`update-all-button`) and adjust the view **once** — a single `adjustScreenView` after the update, not the usual before-and-after sandwich (see the canvas-render-race note below, #569)
3. *Step: canvas has all 5 required nodes* — `expect.soft` for each of the 5 nodes:
   - `title-Chat Input`, `title-Chat Output`, `title-Agent`
   - `title-Memory Base`, `note_node`
4. *Step: canvas has exactly 5 nodes* — count `.react-flow__node` and assert `=== 5`

---

**Test 2 — message history context retention suite**

Requires OpenAI usable — `OPENAI_API_KEY` set **and** the provider recorded `active` in `providers.json` (`providerSkipGate("openai")`, #1029). Groups behavior validations in `test.step` with `expect.soft`.

1. Load the Memory Chatbot template and configure OpenAI via `setupLanguageModelOpenAI`:
   - If `model_model` is not visible (providers not configured): click the "Setup Provider" button (no data-testid) → select `provider-item-OpenAI` → fill the API key with `pressSequentially` → click "Save" → wait for the "Replace" button to appear → enable a **single** preferred model toggle (`llm-toggle-{model}`, with `scrollIntoViewIfNeeded`) → close with Escape → wait for `model_model` to appear. Enabling only one model (not every toggle) is deliberate: the OpenAI bundle now lists 45+ models and the trailing toggles render off the scroll viewport, so clicking each one timed out on a non-visible element (issue #569); one enabled model is all the dropdown needs
   - Click `model_model` and select a chat model **resiliently**: `MODEL_TEST_ID` (env) if set → first available preferred cheap chat model (`gpt-4o-mini`, then `gpt-5.4-nano`, `gpt-5.4-mini`, …) → first option that is neither a non-chat model (image/embedding/audio) **nor an avoided slow/expensive one** (`-pro` reasoning tiers, the `o1`/`o3`/`o4` series, `codex`, `deep-research`, `search-preview`). The dropdown lists `gpt-5.5-pro` first, so this guard keeps a slow reasoning model from being picked. After selecting, the helper asserts `model_model` actually shows the chosen model — a silently-intercepted click (the `api_key` popover can steal it) would otherwise leave the node on its `gpt-5.5-pro` default and mask assertions downstream
2. **Pin the Agent's executable model to a non-reasoning chat model via API** (`setAgentModelViaApi`): the Agent template defaults `model` to `gpt-5.5-pro` — a restricted (keys without access get *"Project does not have access to model gpt-5.5-pro"*), expensive reasoning model — and the in-canvas model widget does **not** persist a UI selection to the executed graph, so a plain UI click leaves the flow running gpt-5.5-pro. The helper GETs the flow and pins a cheap **non-reasoning** OpenAI chat model, then PATCHes `model.value`; the test then `page.reload()`s so the Playground build uses the pinned model. **The model must be non-reasoning** (see the reasoning-model note below): the current nightly bundle classifies the whole `gpt-5.x` nano/mini tier as *reasoning*, and the Agent's `model.options` frequently shows only that reasoning-only curated set at pin time, so the old "first preferred name" resolution pinned `gpt-5.4-nano` — a reasoning model whose latency variance intermittently blew the 120s response budget (the reopened #569 flake). The helper now selects by the backend's own `metadata.reasoning_models` tag and, when the options list carries no non-reasoning OpenAI model, synthesizes `gpt-4o-mini` by name (the backend executes `model.value[0].name` directly, so the name is authoritative regardless of the stale options list)
4. Open the Playground (`playground-btn-flow-io`) and wait for `input-chat-playground`
5. *Step: context retention* — Send `"My name is Alice..."`, wait for the response to **complete** (`waitForChatResponse`: `div-chat-message` reaches the expected count so the new turn has started, then the generating indicator clears — `button-stop` hidden and `button-send` back), send `"What is my name?"` and assert the latest `div-chat-message` contains "Alice"
6. *Step: multiple messages* — web-first `expect.poll` on `div-chat-message` count asserting `>= 2` (testid is present only on bot responses). Not an exact count: the classic template is a linear flow (exactly 2 responses), but the agent-based Memory Chatbot template on nightly emits extra intermediate tool/memory-retrieval bubbles, so the bubble count is non-deterministic (`>= 2`). An exact `toHaveCount(2)` false-failed on the agent variant when it settled on 3 (issue #466)
7. *Step: persistence* — close the Playground via `playground-close-button` (wait for `input-chat-playground` to hide), reopen it, and web-first assert `div-chat-message` count is restored to the previous value

---

**Test 3 — session isolation: new session has no context from previous session**

Declares `tier: "any-completion"` and resolves its target through `resolveTestTargets()`, so a lane that sets `ANY_COMPLETION_PROVIDER` routes it to a keyless local model (#1187/#1251). It is therefore parametrized (one describe per resolved target) and gated on **that** target — `test.skip(!!skipReason)` plus `hasProviderEnvKeys(provider)` — never on a hosted provider's health. `providerSkipGate("openai")` would defeat the routing: on a routed run it asks whether a hosted key is alive, and a drained account then skips a test that needs no key at all, which is the silent coverage loss #976 recorded. Tests 1 and 2 stay hosted and keep their own gates. Kept separate from Test 2 because it is destructive (creates a new session).

**Why this declaration qualifies as `any-completion`, and Test 2 does not.** The criterion #1187 settled on is **dependence**: no assertion may depend on the model *choosing or managing* to do something, timing included. Here every assertion is either structural (`div-chat-message` `toHaveCount(0)` after the session reset) or a **negative** about content (`not.toMatch(/Bob/i)`), guarded by a non-vacuous "answered at all" check (`length > 0`). Nothing requires the model to succeed at a task — which is exactly why Test 2 cannot follow: its `expect.soft(/Alice/i)` requires the model to recall and restate a name. The completion wait is also safe by the same test that rejected `settings-message-history`: `waitForChatResponse` gates on `button-stop` **hidden**, never on catching it visible, so a fast local model cannot close a transient window on it.

1. Load the template and configure the resolved target via `providerSetupMap[provider](page, options.model)`. **The API model pin (`setAgentModelViaApi`) applies to the hosted OpenAI path only** — it exists because the Agent template defaults `model` to `gpt-5.5-pro` and the in-canvas widget does not persist a UI selection into the executed graph. Measured on 1.12.0.dev17, the Ollama path does not need it: after `setupOllama` the persisted node carries `model.value=[{name:"qwen2.5:0.5b", provider:"Ollama"}]`. The routed path asserts that persisted name instead of pinning it, so a selection that silently dropped to the workspace default fails loudly rather than running an unrequested model (#596/#491 class)
2. Open the Playground, send `"My name is Bob..."`
3. Wait for the response to complete (`waitForChatResponse` — new bubble mounted, then generating indicator cleared)
4. Click `new-chat` (the "+" button in the sessions sidebar)
5. Web-first assert `div-chat-message` `toHaveCount(0)` — auto-retries until the session reset settles, so a reset slower than a fixed wait cannot false-fail (replaced the old `waitForTimeout(500)` + hard count)
6. *Backend-isolation probe:* send `"What is my name?"` in the NEW session, assert the response is **non-empty** and then that it does **not** match `/Bob/i` — the UI-reset check alone (step 5) would still pass if the backend leaked memory across sessions; only a model answer proves the new session's context is really empty (inverted mirror of Test 2's positive `/Alice/i` assert). The non-empty gate closes the vacuous pass: an empty/errored response (e.g. a reasoning model returning no content) would otherwise satisfy `not.toMatch(/Bob/)` and mask a broken run. Fail-safe: a leak surfaces "Bob" and fails; a model that answers "I don't know" passes

---

## Validation criterion *(required)*

- Template loads with exactly 5 nodes: Chat Input, Chat Output, Agent, Memory Base, note (README)
- The LLM recalls the name provided in a previous message within the same session ("Alice")
- Bot responses accumulate in the history (`div-chat-message` ≥ 2 after 2 exchanges)
- History persists after closing and reopening the Playground
- A new session starts with 0 messages, with no context inherited from previous sessions
- Test 3 reaches that verdict on **any** completion model, hosted or keyless: on a routed lane it must run (not skip) with no provider key present, and the model it runs must be the one the target resolved

---

## External dependencies *(required)*

- `src/backend/base/langflow/initial_setup/starter_projects/Memory Chatbot.json` — defines the template graph at runtime (overrides the `.py`); changes to nodes or edges break Test 1
- `initial_setup/starter_projects/Memory Chatbot.json` — the shipped template (Agent + Memory Base since 1.11.0.dev34); node renames/additions there break Test 1
- The Agent node's `model_model` field — `setupLanguageModelOpenAI` resolves it on the Agent (the helper predates the redesign; it targets whatever node exposes `model_model`); changes there affect Tests 2 and 3
- `src/frontend/src/components/core/playgroundComponent/` — `input-chat-playground`, `div-chat-message`, `button-send`, `button-stop`, `playground-close-button`, `new-chat` — any rename breaks Tests 2 and 3. `button-stop`/`button-send` are the completion signal used by `waitForChatResponse` (present-while-generating / present-when-idle); if those testids change, the response wait must switch to another per-response completion marker
- `src/frontend/src/CustomNodes/GenericNode/components/NodeName/index.tsx` — `data-testid="title-{display_name}"` — a change to this testid pattern breaks Test 1
- `src/frontend/src/modals/modelProviderModal/components/ProviderConfigurationForm.tsx` — "Save" button (exact text to save the API key); changing it breaks `setupLanguageModelOpenAI`
- `tests/helpers/provider-setup/test-targets.ts` — the shared resolver Test 3 takes its target from; the `ANY_COMPLETION_PROVIDER` override lives there and decides whether that test runs hosted or keyless
- `tests/helpers/provider-setup/setup-ollama.ts` — drives the keyless path. It reaches the provider panel through `model_model` / "Setup Provider" / `manage-model-providers`, the same unified `ModelInput` surface the hosted helpers use, which is why no separate keyless helper is needed for this template (measured on 1.12.0.dev17, #1251)
- `src/lfx/src/lfx/base/models/model_input_constants.py` — `MODEL_PROVIDERS_LIST`; Ollama leaving it removes the keyless option from the dropdown and Test 3 can no longer be routed

---

## What this test does not cover *(optional)*

- Memory Chatbot behavior with other providers for **Tests 1 and 2** — `setupLanguageModelOpenAI` configures OpenAI only. Test 3 is parametrized and does cover whatever targets the lane resolves
- Whether the *retention* half (Test 2) holds on a small local model — it asserts recall, so it stays hosted by design, not by omission
- Validation of AI response content beyond the name reference ("Alice")
- Verification that, without the `Memory Base` component connected to the Agent, context is lost
- History persistence after a Langflow server restart

---

## Preconditions *(optional)*

- Langflow running and accessible at `PLAYWRIGHT_BASE_URL`
- `OPENAI_API_KEY` defined in `.env` **and** OpenAI recorded `active` by `collect-models`, for Test 2 (#1029)
- Test 3 needs whatever its resolved target needs: a hosted key on a normal run, or — with `ANY_COMPLETION_PROVIDER=ollama` — a reachable local instance (`OLLAMA_BASE_URL`, `OLLAMA_BASE_URL_FROM_LANGFLOW`, `OLLAMA_TEST_MODEL`) and a Langflow started with `LANGFLOW_SSRF_ALLOWED_HOSTS` covering it
- Run with `--workers=1` to avoid flow conflicts

---

## When to review this test *(optional)*

- If the "Memory Chatbot" template is removed or renamed in `starter_projects`
- If the `Agent` / `Memory Base` component changes its `display_name` or the default session behavior changes
- If the "Save" button in the provider modal changes its text (breaks `setupLanguageModelOpenAI`)
- If the `new-chat` button in the sessions sidebar is renamed (breaks Test 3)
- If the Playground adds a confirmation modal when creating a new session (Test 3 will need an extra step)

---

## Notes *(optional)*

- **Template structure at runtime**: the template loads from `Memory Chatbot.json` (not the `.py`), which since 1.11.0.dev34 is an **Agent-based** flow with 5 nodes: Chat Input → Agent → Chat Output, plus the `Memory Base` component and a note/README (issue #550).
- **Agent model default is `gpt-5.5-pro`**: the Agent node's `model` field defaults to `gpt-5.5-pro` (a restricted, expensive reasoning model). The in-canvas model widget (`model_model`) does **not** persist a UI selection into the executed graph — the `model.value` on the node stays at the default — so Tests 2/3 pin it via the flows API (`setAgentModelViaApi`), then reload so the Playground build uses it. Running gpt-5.5-pro caused both the hard failure (*"Project does not have access to model gpt-5.5-pro"* on restricted keys) and the original flake (slow reasoning replies, inconsistent token-usage badge).
- **Reasoning models are the reopened-#569 flake (avoid them)**: after the original pin fix landed, the flake recurred as a live-LLM **response hang** — the Playground `button-stop` never cleared and `waitForChatResponse` timed out at 120s. Root cause: the current nightly OpenAI bundle classifies the entire `gpt-5.x` nano/mini/base tier as **reasoning** models (the backend self-lists each in `metadata.reasoning_models`), and the Agent's `model.options` at pin time is usually the *curated default* list where **every** OpenAI option is reasoning — so the previous "first preferred name" resolution (`gpt-4o-mini` → `gpt-5.4-nano` → …) pinned `gpt-5.4-nano`. That model answers in ~13s most of the time but occasionally reasons past the 120s budget → the ~7% intermittent hang. `setAgentModelViaApi` now (a) detects reasoning models via `metadata.reasoning_models` rather than a hardcoded name list (which drifts with the bundle), (b) prefers a cheap non-reasoning OpenAI chat model (`gpt-4o-mini`, `gpt-4.1-mini`, `*-chat-latest`, …) from the live options, and (c) when the options list carries only reasoning OpenAI models, **synthesizes `gpt-4o-mini` by name** from an OpenAI option's shape (metadata is provider-level) with the reasoning tag stripped — the backend runs `model.value[0].name` directly, so this executes a real non-reasoning model regardless of the stale options. Validated: with the reasoning model, ~1 hang in ~14 runs; with the pinned non-reasoning model, 15/15 first-attempt green (`CHOSEN=gpt-4o-mini`, `IS_REASONING=false`) at ~11–14s each. Diagnostic aside: the backend logs `ValueError: No Memory Base is selected.` (~8×/run) even on green runs — it is benign build-order noise, not the hang cause.
- **Completion signal (`waitForChatResponse`)**: waits in two gates — first `div-chat-message` reaches the expected count (the bot bubble mounts when the turn starts, guarding against checking completion before generation began — the #354 start-race), then the generating indicator clears (`button-stop` hidden, `button-send` visible). The previous signal counted `chat-message-token-usage` badges, but not every model/response emits that badge, so the count could sit below the expected value for the full 120s even though the response had rendered — the **root cause of the #569 flake**. `button-stop`/`button-send` are model-agnostic. `div-chat-message` alone is unreliable (its count flickers while streaming — mount/unmount/settle), which is why it is only the *turn-started* gate, never the completion gate.
- **Model selection is resilient**: `setupLanguageModelOpenAI` no longer hardcodes `gpt-4o-mini`. It resolves `MODEL_TEST_ID` (env) → first available preferred cheap chat model → first option that is neither non-chat nor an avoided slow/expensive model (`-pro`/`o1`/`o3`/`o4`/`codex`/`deep-research`/`search-preview`), enables that single model's toggle (not all 45+ — issue #569), and verifies `model_model` reflects the choice after selecting. The last two guards matter because the dropdown lists `gpt-5.5-pro` first: without them a silently-failed selection would leave the node on that pro tier, whose slow/empty reasoning replies reintroduce timeouts and mask assertions. Validated on Langflow 1.11.x, where the OpenAI bundle exposes `gpt-5.x` (e.g. `gpt-5.4-nano`) alongside `gpt-4o-mini`.
- **Canvas-render race on load (#569 recurrence)**: after the original #569 fix (model pin + model-agnostic completion signal) landed, the flake recurred on the daily with a **different** signature — `page.waitForSelector: Timeout 30000ms exceeded — waiting for [data-testid="canvas_controls_dropdown"]` — during template load, not in the Playground. This is a suite-wide canvas-render race that surfaces under CI parallel contention (the recurrence day carried 7 diverse, unrelated flakes + 4 hard fails; locally, idle, this test is 5/5 first-attempt green in ~13s). To keep this heavy test's exposure minimal, `loadMemoryChatbot` no longer runs the redundant pre-update `adjustScreenView`: `loadTemplateByName` already confirmed the canvas rendered, and `updateOldComponents` only clicks the global `update-all-button` (it touches no node, so it needs no fitted view — unlike the sandwich pattern in specs that edit a node between the two fits). One `adjustScreenView` remains after the update because it is functionally required to bring the Agent node into the viewport for `setupLanguageModelOpenAI`. The durable, suite-wide hardening of `loadTemplateByName`/`adjustScreenView` against this race is tracked separately (it is shared infrastructure, not memory-history-specific).
- **Live OpenAI calls**: Tests 2 and 3 make real OpenAI calls, so an occasional response slower than the 120s budget can still time out — an inherent external-dependency limit, absorbed by the CI retry budget, not a test-logic bug. With the #569 completion-signal fix a full 3-test run settles in ~31s (previously it could hang at the 120s token-usage timeout).
- **Teardown**: `afterEach` navigates home (`page.goto("/")`) before deleting the flow by id, so the open playground stops polling the flow's `/events` endpoint and the delete no longer races those requests into 404 ("Flow not found") teardown noise.
- **`setupLanguageModelOpenAI`**: local function in the spec that configures OpenAI via the "Setup Provider" modal. Uses `pressSequentially` (not `fill`) to ensure keyboard events on React controlled inputs. Waits for the "Replace" button to appear to confirm the save completed.
- **`new-chat`**: the "+" button in the sessions sidebar (`chat-sidebar.tsx`). Functional equivalent of "New Session" in the `session-selector-trigger` dropdown (which may be hidden by animation in certain builds).
- **Test 1 without API key**: pure structure validation — useful in CI without configured keys.
- **Routed measurement (#1251), all on 1.12.0.dev17.** Test 3 routed to `ollama / qwen2.5:0.5b`: **6/6** with `retries=0`. Hosted, pinned `google / gemini-3.5-flash-lite`: **1/1** — which also exercises the non-OpenAI branch that asserts the persisted model instead of pinning it. A target the running build does not offer (`gemini-omni-flash-preview`) now **skips**; before this change the same case surfaced as a failure, and resolving google's whole catalog produced 23 of them. Whole file on the routed lane, in one run: structure **passes**, retention **skips** (hosted gate, OpenAI key drained), isolation **runs** — which is the coverage this routing buys, since before it the isolation test shared the retention test's hosted gate and skipped with it. Force-fail 2/2: a wrong persisted model fails with the #596/#491 message, and inverting the isolation assert fails on a real reply (*"I don't have access to your personal information or memories…"*), so the negative assertion is not vacuous.
- **Durations are not a ceiling.** The routed runs measured 14.7 s, 15.3 s, 16.8 s, 23.3 s, 39.3 s, 93.9 s and 116.9 s — tracking the host's load average (63 at the peak) while Ollama answered a direct call in under 1.5 s the whole time. Two Langflow containers on a 3.8 GB Docker VM were `SIGKILL`ed (exit 137) mid-measurement. A wall-clock ceiling for this declaration has to be measured on the daily, not locally — the same conclusion #1187 reached for its own pilot.
