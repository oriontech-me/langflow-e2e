# Agent Component — Canvas Rendering and Provider Field Plumbing

**Last validated:** Langflow 1.11.x

---

## What this test validates *(required)*

Validates four canvas-level behaviors of the Agent component in Langflow — distinct from the execution-level behavior covered by `core-functionality/llm-agents/agent-component-regression.spec.ts`:

1. **Default rendering on canvas** — when the Agent is dragged from the sidebar, the node appears with the title, the three core handles (`tools-left`, `language model-left`, `response-right`), the system prompt field, and the provider/model selectors visible in the default expanded state.
2. **System prompt input and persistence** — typing a system prompt in the Agent node autosaves it; navigating away and reopening the same flow restores the value, proving the field is wired to the flow JSON.
3. **Model dropdown exposes the centralized provider management entry point** — opening the `value-dropdown-model_model` dropdown surfaces the `manage-model-providers` button (the canonical configuration path in Langflow 1.10.x) and lists all models from already-configured providers, each tagged with the appropriate provider `icon-{ProviderName}`.
4. **Selecting a model updates the canvas provider icon** — switching the selected model from one provider (e.g. OpenAI) to another (e.g. Anthropic) causes the `icon-OpenAI` mark on the Agent node to be replaced by `icon-Anthropic`. Proves the canvas reflects the provider associated with the chosen model — the only remaining canvas-visible analog to the issue's "field isolation" intent after the in-component provider dropdown was removed in 1.10.x.

If any of these tests fails, the Agent component is broken at the canvas level: default rendering, autosave/restore, or provider-driven schema updates.

---

## Tags *(required)*

`@stable` `@release` `@regression` `@components` `@agents`

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
8. Assert the model dropdown `value-dropdown-model_model` is visible (the only model-selection surface in 1.10.x — the in-component provider dropdown was removed)

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
3. Assert the `manage-model-providers` button is visible inside the dropdown (canonical config entry point in 1.10.x)
4. Assert at least one model option (testid pattern `*-option`) is visible — the option count is environment-dependent (providers configured in the local Langflow instance), so the assertion is a `>= 1` floor rather than an exact match
5. Skip the per-provider assertions below when no provider has been pre-configured in the local Langflow (option count is 0)
6. When OpenAI is pre-configured (any `gpt-*-option` visible), assert that at least one option carries the `icon-OpenAI` mark in its row
7. When Anthropic is pre-configured (any `claude-*-option` visible), assert that at least one option carries the `icon-Anthropic` mark in its row

**Test 4 — Selecting a different-provider model updates the canvas provider icon**
1. Skip the test unless at least one `gpt-*-option` AND one `claude-*-option` are visible in the model dropdown (both providers must be pre-configured in the local Langflow instance)
2. `awaitBootstrapTest(page)` + `blank-flow` + drag Agent
3. Open `value-dropdown-model_model` and click `gpt-4o-mini-option` (or the first available `gpt-*-option`)
4. Close the dropdown; assert `icon-OpenAI` is visible inside the Agent node body
5. Re-open `value-dropdown-model_model` and click `claude-opus-4-6-option` (or the first available `claude-*-option`)
6. Close the dropdown; assert `icon-Anthropic` is visible inside the Agent node body and `icon-OpenAI` is no longer visible

---

## Validation criterion *(required)*

- Agent node visible on canvas with title and all three core handles (`tools-left`, `language model-left`, `response-right`)
- System prompt textarea (`textarea_str_system_prompt`) and model dropdown (`value-dropdown-model_model`) visible in the default rendered state
- System prompt value survives flow autosave + page navigation + flow re-open
- Model dropdown exposes the `manage-model-providers` entry point and at least one option from each pre-configured provider
- Selecting a different-provider model updates the canvas `icon-{ProviderName}` mark on the Agent node accordingly

---

## External dependencies *(required)*

- `src/lfx/src/lfx/components/models_and_agents/agent.py` — `AgentComponent` definition; the `system_prompt` input and the per-provider model-list metadata are the schema this spec asserts against. (Was recorded as `components/agents/agent.py`, a directory that does not exist on any current ref — corrected in #1040. `models_and_agents` is a **core** family, not one of the `lfx-bundles` shims, so it does not expire at M4.)
- `src/frontend/src/CustomNodes/GenericNode/components/parameterRenderComponent/` — renders `value-dropdown-model_model` and the `manage-model-providers` button inside it; testid renames break Tests 3 and 4
- `src/frontend/src/CustomNodes/GenericNode/` — renders the handles; the `handle-agent-shownode-{port}-{side}` pattern must remain stable
- Provider icon assets in `src/frontend/src/icons/` — the `icon-OpenAI` and `icon-Anthropic` testids on the Agent node carry the assertion in Test 4 and break if the icon mapping changes

---

## What this test does not cover *(optional)*

- Agent execution behavior (responses, reasoning, streaming, stop button) — covered by `core-functionality/llm-agents/agent-component-regression.spec.ts`
- Image upload in the Playground — covered by `general-bugs-agent-images-playground.spec.ts`
- Math expression duplication regression — covered by `general-bugs-agent-sum-duplicate-message-playground.spec.ts`
- MCP toolset wiring into the Agent — covered by `mcp/client/mcp-client-agent.spec.ts`
- Provider configuration via the centralized "Manage Model Providers" path — exercised by `SimpleAgentTemplatePage.load()` in the existing agent execution specs
- Field isolation matrix across all providers and all provider-specific fields — Test 4 covers only the documented OpenAI → Anthropic case with `reasoning_effort`

---

## Preconditions *(optional)*

- Langflow running and accessible at `PLAYWRIGHT_BASE_URL`
- Tests 1, 2, and 3 do not require any provider API key — they exercise canvas rendering, autosave/restore, and the dropdown surface (the per-provider model assertions in Test 3 self-skip when the provider is not pre-configured)
- Test 4 requires both OpenAI and Anthropic to be pre-configured in the local Langflow instance — when only one (or neither) is configured, the test self-skips after inspecting the dropdown
- Tests run in `serial` mode at the file level — each test creates and persists a flow, parallel runs would race on autosave

---

## When to review this test *(optional)*

- If the Agent component's `system_prompt` input is renamed or replaced
- If `value-dropdown-model_model`, `manage-model-providers`, or the `icon-{ProviderName}` testids are renamed
- If a separate in-component provider dropdown is re-introduced (would warrant adding a fifth test for that surface)
- If the autosave behavior changes (e.g. requires explicit save button instead of blur)

---

## Notes *(optional)*

- This spec deliberately uses the **blank flow + drag** path instead of `SimpleAgentTemplatePage.load()`. The template path deletes all flows, opens the new-project modal, and configures the provider via the centralized panel — none of which is necessary for canvas-level assertions, and all of which is already exercised by the execution spec in `llm-agents/`.
- **Architectural drift from issue #186.** The issue text proposes Tests 3 and 4 against an older Agent UI that exposed a separate in-component provider dropdown (`value-dropdown-dropdown_str_agent_llm`) and OpenAI-only fields (`reasoning_effort`). Both have been removed from the Agent component in Langflow 1.10.x — provider configuration is now centralized via `manage-model-providers` and `reasoning_effort` is no longer surfaced on the canvas. Tests 3 and 4 in this spec are reinterpreted to validate the equivalent canvas-level surfaces in the current architecture: the dropdown's entry-point button and the provider icon that tracks the selected model. The intent of the issue (canvas-level coverage of provider plumbing) is preserved; the specific selectors are not.
- A spec file with the same name exists in `core-functionality/llm-agents/` covering execution behavior. The two specs are distinct in scope (canvas plumbing vs. Playground execution) and intentionally coexist; both spec docs cross-reference each other.
- `general-bugs-agent-images-playground.spec.ts` (in `llm-agents/`) still references the removed `value-dropdown-dropdown_str_agent_llm`/`popover-anchor-input-api_key` testids and is therefore broken in 1.10.x. It is not `@stable` and does not run in the weekly workflow. Fixing it is tracked in a separate follow-up issue outside the scope of this spec.
