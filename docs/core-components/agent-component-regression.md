# Agent Component — Canvas Rendering and Provider Field Plumbing

**Last validated:** Langflow 1.12.x

---

## What this test validates *(required)*

Validates four canvas-level behaviors of the Agent component in Langflow — distinct from the execution-level behavior covered by `core-functionality/llm-agents/agent-component-regression.spec.ts`:

1. **Default rendering on canvas** — when the Agent is dragged from the sidebar, the node appears with the title, the three core handles (`tools-left`, `language model-left`, `response-right`), the system prompt field, and the provider/model selectors visible in the default expanded state.
2. **System prompt input and persistence** — typing a system prompt in the Agent node autosaves it; navigating away and reopening the same flow restores the value, proving the field is wired to the flow JSON.
3. **Model dropdown exposes the centralized provider management entry point** — opening the `value-dropdown-model_model` dropdown surfaces the `manage-model-providers` button (the canonical configuration path since Langflow 1.10.x) and lists all models from already-configured providers, each option row carrying its provider's `icon-{ProviderName}` mark.
4. **Selecting a different-provider model updates the canvas provider icon** — switching the selected model from one provider (OpenAI) to another (Anthropic) replaces the `icon-OpenAI` mark inside the `model_model` trigger with `icon-Anthropic`. Proves the canvas reflects the provider associated with the chosen model — the only remaining canvas-visible analog to the issue's "field isolation" intent after the in-component provider dropdown was removed in 1.10.x.

If any of these tests fails, the Agent component is broken at the canvas level: default rendering, autosave/restore, or provider-driven schema updates.

---

## Tags *(required)*

`@stable` `@release` `@regression` `@components` `@agents`

---

## Option testid contract — read before touching Tests 3 and 4 *(required)*

The unified model picker renders **one option per model, keyed by provider AND model**:

```
<div data-testid="${provider}-${model}-option" data-value="${provider}::${model}">
```

so the real testids are `OpenAI-gpt-4o-mini-option` and `Anthropic-claude-opus-5-option` — they start with the **provider display name**, not with the model id. Measured on 1.12.0.dev37 with OpenAI, Anthropic and Google configured: 69 options, of which 44 identify as `OpenAI` (29 of them named `gpt-*`) and 13 as `Anthropic`.

Tests 3 and 4 match on the **provider identity** (`data-value` = `${provider}::${model}`), not on the model-id prefix: "a model from a different provider" is what they are about, and a matcher pinned to `gpt-`/`claude-` would break again the day a vendor renames its family (OpenAI already ships `o1`/`o3`/`o4` models under the same provider).

A matcher anchored on the model id (`[data-testid^="gpt-"]`, `[data-testid^="claude-"]`) matches **zero** options on any instance — that is issue #1568, where it made Test 4 `test.skip()` on every daily measured since 08-19 while both providers were configured, and silently voided Test 3's per-provider assertions, which reported `expected` without ever running.

Tests 3 and 4 resolve an option through a local `providerOptions()` locator that matches `data-value^="${provider}::"`. The model-option helper under `tests/helpers` encodes the same contract with more machinery, and is deliberately **not** reached from here: `scripts/provider-dependent-specs.mjs` decides whether a spec consumes the model-catalog sweep by grepping its source text for that helper directory's name, so importing it — or naming it in a comment — would force the provider sweep on every PR touching any helper this spec imports, re-creating the coupling #1216 removed. This spec reads the DOM and resolves no model id, so it must not carry that marker.

Two further properties of an option row, both measured:

- The provider icon inside the row is **lazy-loaded** — the row paints a `animate-pulse` skeleton first and the `icon-{Provider}` svg lands at ~600 ms. Assert it with a `toBeVisible` budget, never with a bare `count()`.
- The row's text carries a `sr-only` "N of M" position counter since 1.12.0.dev26, so option text is evidence, never an identity matcher.

---

## Step by step *(required)*

**Test 1 — Agent renders on canvas with default fields and handles**
1. `awaitBootstrapTest(page)` and click `blank-flow`
2. Open the "models & agents" disclosure in the sidebar via `disclosure-models & agents`
3. Drag `models_and_agentsAgent` to the canvas via `dragTo` with explicit `targetPosition`
4. Call `adjustScreenView` with at least 2 zoom-outs so the full node body is in viewport
5. Assert exactly one `.react-flow__node` is on the canvas and the title `title-Agent` is visible
6. Assert the three core handles are visible:
   - `handle-agent-shownode-tools-left`
   - `handle-agent-shownode-language model-left`
   - `handle-agent-shownode-response-right`
7. Assert the system prompt field `textarea_str_system_prompt` is visible
8. Assert the model dropdown `value-dropdown-model_model` is visible (the only model-selection surface since 1.10.x — the in-component provider dropdown was removed)

**Test 2 — System prompt persists across flow reload**
1. `awaitBootstrapTest(page)` and click `blank-flow`
2. Drag the Agent component to the canvas (same path as Test 1)
3. Rename the flow to a deterministic unique value (e.g. `agent-prompt-${Date.now()}`) via the flow-name input in the canvas header so the flow can be reliably re-opened by name
4. Type a deterministic unique string (e.g. `system-prompt-test-${Date.now()}`) into the system prompt field
5. Blur the field (click the canvas) to trigger autosave; wait for the autosave to settle via `page.waitForResponse` on a successful `PATCH /api/v1/flows/`
6. Navigate `page.goto("/")` and wait for the flows list to render
7. Click the flow card matching the rename in step 3 (per the documented `feedback_page_goto_flow_id_race` pattern — do NOT use `/flow/{id}` deep-link)
8. Wait for the Agent node to be visible on the canvas again
9. Assert the system prompt field still contains the unique string typed in step 4

**Test 3 — Model dropdown exposes manage-model-providers and lists configured models**
1. `awaitBootstrapTest(page)` + `blank-flow` + drag Agent (same setup as Test 1)
2. Click `value-dropdown-model_model` to open the model dropdown
3. Assert the `manage-model-providers` button is visible inside the dropdown (canonical config entry point since 1.10.x)
4. Assert at least one model option (testid pattern `*-option`) is visible — the option count is environment-dependent (providers configured in the target Langflow), so the assertion is a `>= 1` floor rather than an exact match
5. Skip the per-provider assertions below when no provider has been pre-configured (option count is 0)
6. When OpenAI is pre-configured (any option whose provider identity is `OpenAI`), assert the first such row carries the `icon-OpenAI` mark, scoped to that row
7. When Anthropic is pre-configured (any option whose provider identity is `Anthropic`), assert the first such row carries the `icon-Anthropic` mark, scoped to that row

**Test 4 — Selecting a different-provider model updates the canvas provider icon**
1. **Before opening the browser**, read `GET /api/v1/variables/` with an explicit auth header and record whether `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` exist as Langflow global variables. This is the condition the test's assertions require, and it is the same state `Collect models` establishes on every CI lane.
2. When either credential is absent, `test.skip()` naming **which** one is missing — the only legitimately-absent case (a developer box that has not run `collect-models`).
3. When **both** credentials are configured, the dropdown MUST offer an option from each provider. `awaitBootstrapTest(page)` + `blank-flow` + drag Agent, open `value-dropdown-model_model`, and assert at least one option identifies as `OpenAI` and one as `Anthropic` — a **hard failure** naming the configured-but-missing provider and reporting the per-provider census the picker did return, never a skip (#1568/#1456: a skip here reported SUCCESS for a test that had not run since at least 08-19).
4. Capture the first option of each provider (its `data-testid`) so the re-open in step 6 re-selects deterministically
5. Click the OpenAI option; assert `icon-OpenAI` is visible **inside the `model_model` trigger**
6. Re-open `value-dropdown-model_model` and click the captured Anthropic option
7. Assert `icon-Anthropic` is visible inside the trigger and `icon-OpenAI` has count 0 there

---

## Validation criterion *(required)*

- Agent node visible on canvas with title and all three core handles (`tools-left`, `language model-left`, `response-right`)
- System prompt textarea (`textarea_str_system_prompt`) and model dropdown (`value-dropdown-model_model`) visible in the default rendered state
- System prompt value survives flow autosave + page navigation + flow re-open
- Model dropdown exposes the `manage-model-providers` entry point and at least one option; each configured provider's option rows carry that provider's `icon-{ProviderName}`
- **Test 4 runs — it does not skip — on any instance where `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` are configured as Langflow global variables**, and on such an instance the `model_model` trigger holds exactly `icon-OpenAI` after an OpenAI model is selected and exactly `icon-Anthropic` (with `icon-OpenAI` at count 0) after switching to an Anthropic model. A provider with no option on a fully-credentialed instance fails the test naming that provider; it never skips.

---

## External dependencies *(required)*

- `src/lfx/src/lfx/components/models_and_agents/agent.py` — `AgentComponent` definition; the `system_prompt` input and the per-provider model-list metadata are the schema this spec asserts against. (Was recorded as `components/agents/agent.py`, a directory that does not exist on any current ref — corrected in #1040. `models_and_agents` is a **core** family, not one of the `lfx-bundles` shims, so it does not expire at M4.)
- `src/backend/base/langflow/api/v1/models.py` — `GET /api/v1/models` is what fills the dropdown; a provider appears with `is_configured`/`is_enabled` derived from whether its credential variable exists. Tests 3 and 4 assert on what this endpoint yields.
- `src/backend/base/langflow/api/v1/variable.py` — `GET /api/v1/variables/` is Test 4's precondition probe: the credential names it returns decide run-vs-skip. (The module is `variable.py`, singular; the route prefix is plural.)
- `src/frontend/src/components/core/parameterRenderComponent/` — renders `value-dropdown-model_model`, the `manage-model-providers` button, and the `${provider}-${model}-option` rows; a change to that testid template breaks Tests 3 and 4 (it already did once — #1568)
- `src/frontend/src/CustomNodes/GenericNode/` — renders the handles; the `handle-agent-shownode-{port}-{side}` pattern must remain stable
- Provider icon assets in `src/frontend/src/icons/` — the `icon-OpenAI` and `icon-Anthropic` testids carry Test 4's assertion and break if the icon mapping changes

---

## What this test does not cover *(optional)*

- Agent execution behavior (responses, reasoning, streaming, stop button) — covered by `core-functionality/llm-agents/agent-component-regression.spec.ts`
- Image upload in the Playground — covered by `general-bugs-agent-images-playground.spec.ts`
- Math expression duplication regression — covered by `general-bugs-agent-sum-duplicate-message-playground.spec.ts`
- MCP toolset wiring into the Agent — covered by `mcp/client/mcp-client-agent.spec.ts`
- Provider configuration via the centralized "Manage Model Providers" path — exercised by `SimpleAgentTemplatePage.load()` in the existing agent execution specs
- Field isolation across providers: the Agent no longer surfaces provider-specific fields (e.g. `reasoning_effort`) on the canvas, so Test 4 covers only the provider **icon** as the canvas-visible consequence of the model switch
- Whether the selected model can actually run — Test 4 asserts the canvas reflects the choice, not that the credential has credit

---

## Preconditions *(optional)*

- Langflow running and accessible at `PLAYWRIGHT_BASE_URL`
- Tests 1, 2, and 3 do not require any provider API key — they exercise canvas rendering, autosave/restore, and the dropdown surface (the per-provider option-row assertions in Test 3 self-skip when the provider is not pre-configured)
- Test 4 requires `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` to exist as Langflow **global variables**. Run `npx playwright test tests/collect-models.spec.ts` first locally; every CI lane does this via its `Collect models` step. With both present the test runs and any missing option family is a failure, not a skip
- Tests run in `serial` mode at the file level — each test creates and persists a flow, parallel runs would race on autosave

---

## When to review this test *(optional)*

- If the Agent component's `system_prompt` input is renamed or replaced
- If the option testid template stops being `${provider}-${model}-option` (see the contract section above), or `value-dropdown-model_model`, `manage-model-providers`, `model_model` or the `icon-{ProviderName}` testids are renamed
- If a separate in-component provider dropdown is re-introduced (would warrant adding a fifth test for that surface)
- If the autosave behavior changes (e.g. requires explicit save button instead of blur)
- If Langflow stops deriving `is_configured` from the presence of the credential global variable — Test 4's precondition probe would then be reading the wrong signal

---

## Notes *(optional)*

- This spec deliberately uses the **blank flow + drag** path instead of `SimpleAgentTemplatePage.load()`. The template path deletes all flows, opens the new-project modal, and configures the provider via the centralized panel — none of which is necessary for canvas-level assertions, and all of which is already exercised by the execution spec in `llm-agents/`.
- **Test 4's guard is asymmetric on purpose (#1568).** Until this revision it was a single `test.skip()` covering both "no provider configured" and "the dropdown does not offer what we expect", which made a broken locator indistinguishable from an unconfigured dev box — and the daily reported SUCCESS for a test that had not run on any measured run since 08-19. The credential probe splits the two: an absent credential is a legitimate absence and skips with the missing name; a configured credential whose family does not appear is a defect and fails. The class is #1456.
- **Architectural drift from issue #186.** The issue text proposes Tests 3 and 4 against an older Agent UI that exposed a separate in-component provider dropdown (`value-dropdown-dropdown_str_agent_llm`) and OpenAI-only fields (`reasoning_effort`). Both were removed from the Agent component in Langflow 1.10.x — provider configuration is now centralized via `manage-model-providers` and `reasoning_effort` is no longer surfaced on the canvas. Tests 3 and 4 in this spec are reinterpreted to validate the equivalent canvas-level surfaces in the current architecture: the dropdown's entry-point button and the provider icon that tracks the selected model. The intent of the issue (canvas-level coverage of provider plumbing) is preserved; the specific selectors are not.
- A spec file with the same name exists in `core-functionality/llm-agents/` covering execution behavior. The two specs are distinct in scope (canvas plumbing vs. Playground execution) and intentionally coexist; both spec docs cross-reference each other.
- `general-bugs-agent-images-playground.spec.ts` (in `llm-agents/`) still references the removed `value-dropdown-dropdown_str_agent_llm`/`popover-anchor-input-api_key` testids and is therefore broken since 1.10.x. It is not `@stable` and does not run in the weekly workflow. Fixing it is tracked in a separate follow-up issue outside the scope of this spec.
