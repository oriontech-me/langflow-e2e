# Agent Input Sources — direct field vs ChatInput handle

**Last validated:** Langflow 1.11.x

---

## What this test validates *(required)*

The Agent component accepts its user input (`input_value`) from **two
interchangeable sources**, and both drive the agent's response:

1. **Handle source** — a `ChatInput` component connected to the Agent's
   `input` handle. Input typed in the Playground flows `ChatInput → Agent`.
2. **Direct field source** — text typed directly into the Agent node's own
   `Input` field, with no upstream connection. Running the Agent node uses that
   field verbatim.

Each test sends a **per-run sentinel token** and proves that exact token shaped
the agent's output, so a pass cannot be coincidental and each source is proven
independently. Parameterized by provider/model via `models.json`.

If either test fails, the Agent can no longer be fed input through one of its two
canonical authoring patterns — a core regression for anyone building agent flows.

---

## Tags *(required)*

`@stable` `@components` `@agents` `@playground`

`@stable` is added only after the test runs clean multiple times with
`--retries=0` on the fresh nightly (per `CONTRIBUTING.md`). `@components` — Agent
node input configuration; `@agents` — agent execution; `@playground` — Test 1
drives input through the Playground.

---

## Preconditions *(optional)*

- Langflow running and accessible at `PLAYWRIGHT_BASE_URL`.
- `models.json` / `providers.json` generated via
  `npx playwright test tests/collect-models.spec.ts`.
- At least one active provider API key in `.env` (OpenAI, Anthropic, or Google).
- Run with `--workers=1` (agent specs create named flows that collide in
  parallel). File is serial for the same reason (`SimpleAgentTemplatePage.load()`
  wipes all flows before loading).

---

## Step by step *(required)*

The spec generates **2 tests per active model** via `getTestTargets()` (default:
1 model per active provider; `ALL_MODELS=true` runs all models in `models.json`).
A per-run token `SENTINEL_<Date.now()>` is generated so a match is unambiguous.

---

**Test 1 — input via ChatInput handle**

1. Load the Simple Agent template via `SimpleAgentTemplatePage.load(options)`.
   The template ships `ChatInput → Agent(input) → ChatOutput` already wired.
2. Open the Playground (`playground-btn-flow-io`); wait for
   `input-chat-playground`.
3. Send a distinctive echo prompt:
   `Repeat this token exactly and nothing else: HANDLE-<sentinel>`.
4. Wait for the agent to finish (`waitForAgentToFinish` — Stop button appears
   then hides).
5. **Validation:** the last `div-chat-message` (AI bubble) text **contains**
   `HANDLE-<sentinel>` — proving the token typed in the Playground reached the
   agent through the `ChatInput → input` handle.

---

**Test 2 — input via direct field**

1. Load the Simple Agent template.
2. Delete the `ChatInput` node (click `rf__node-ChatInput*`, press `Backspace`)
   so the Agent's `input_value` is sourced **only** from its own field. Confirm
   the node is gone and the edge count dropped by one.
3. Type the distinctive echo prompt into the Agent's `Input` field
   (`popover-anchor-input-input_value`):
   `Repeat this token exactly and nothing else: FIELD-<sentinel>`.
4. **Wait for the debounced autosave to settle** (`waitForFlowSaveSettled`) —
   `button_run_agent` builds the *persisted* flow, so the model selection, the
   node deletion and the field value must all be saved first (see Notes).
5. Run the Agent node via `button_run_agent`.
6. Wait for build success on the canvas — the `node_duration_agent` badge
   (canonical completion signal; not the transient toast).
7. Open the Agent's output inspector (`output-inspection-response-agent`); read
   the `[role="dialog"]` (scoped `:not([data-testid="assistant-onboarding-tooltip"])`)
   text content.
8. **Validation:** the dialog text **contains** `FIELD-<sentinel>` — proving the
   token typed into the Agent's own field drove the response with no ChatInput
   present.

---

## Validation criterion *(required)*

- **Handle:** with `ChatInput → Agent` connected, a token sent via the Playground
  appears in the agent's AI response bubble.
- **Direct field:** with `ChatInput` deleted, a token typed into the Agent's
  `Input` field appears in the agent's output inspection after a canvas run.
- Both use a fresh per-run sentinel, so neither can pass on stale or coincidental
  text.

---

## What this test does not cover *(optional)*

- Runtime precedence when a handle is connected **and** the field is filled
  (Langflow: the connection wins — out of scope here; each source is proven in
  isolation).
- Non-text input sources (files, structured data) into the Agent.
- Tool-calling behavior (the template's Web Search / URL tools are not exercised;
  the echo prompt is designed not to trigger them).
- Streaming, reasoning steps, duration display — covered by
  `agent-component-regression.spec.ts`.

---

## External dependencies *(required)*

- `src/backend/base/langflow/components/agents/` — Agent execution and the
  `input_value` input; a change to how the field vs. the connected handle is
  resolved breaks this spec.
- `src/frontend/src/CustomNodes/GenericNode/` — renders the Agent's
  `popover-anchor-input-input_value` field, the `button_run_agent` control, and
  the `output-inspection-response-agent` inspector.
- `src/frontend/src/components/core/playgroundComponent/` —
  `input-chat-playground`, `button-send`, `div-chat-message` used by Test 1.
- Simple Agent starter template — must keep shipping `ChatInput → Agent →
  ChatOutput`; a rename/rewire changes the setup.

---

## When to review this test *(optional)*

- If the Simple Agent template is renamed, removed, or rewired.
- If the Agent's `Input` field testid changes from
  `popover-anchor-input-input_value`, or the run/inspection testids change.
- If connecting a handle stops leaving the inline field editable, or the delete
  gesture for a node changes.

---

## Notes *(optional)*

- **Why a sentinel echo:** asserting a *distinctive per-run token* round-trips
  through the agent proves the specific input source drove the output, far
  stronger than a generic "non-empty response" check. `Repeat this token exactly`
  is reliable for capable models; the assertion is a case-sensitive **substring**
  match so minor wrapping by the model still passes.
- **Two sources, one field:** the Agent's `input_value` renders as an editable
  inline field (`popover-anchor-input-input_value`) that stays editable even when
  the handle is connected — but at runtime a connected handle overrides it. Test 2
  therefore deletes `ChatInput` so the field is the sole source; Test 1 keeps the
  connection so the handle is the source.
- **Test 2 reads the node inspector, not the Playground:** `button_run_agent`
  builds the Agent (and upstream) but not the downstream `ChatOutput`, so the
  response is read from `output-inspection-response-agent` rather than a chat
  bubble.
- **Autosave race (root-caused during authoring):** `button_run_agent` builds the
  *persisted* flow, not the live canvas graph. When this test runs after another
  agent test in the same serial file, the OpenAI provider is already configured
  globally, so `SimpleAgentTemplatePage.load()` finishes model selection quickly
  — fast enough that the model-selection autosave `PATCH /api/v1/flows/{id}` can
  still be in flight when `button_run_agent` fires. The build then runs the
  template's default model reference and the backend raises
  `ValueError: __default_language_model__ variable not found`; the agent never
  builds, so `node_duration_agent` never appears and the step times out. Run in
  isolation it passed because the full provider setup (key + enabling every
  model) took long enough for the save to land. `waitForFlowSaveSettled` before
  the run removes the race deterministically — the same guard
  `agent-system-prompt.spec.ts` uses.
