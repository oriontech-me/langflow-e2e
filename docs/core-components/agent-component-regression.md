# Agent Component — Canvas Rendering and Provider Field Plumbing

**Last validated:** Langflow 1.10.x

---

## What this test validates *(required)*

Validates four canvas-level behaviors of the Agent component in Langflow — distinct from the execution-level behavior covered by `core-functionality/llm-agents/agent-component-regression.spec.ts`:

1. **Default rendering on canvas** — when the Agent is dragged from the sidebar, the node appears with the title, the three core handles (`tools-left`, `language model-left`, `response-right`), the system prompt field, and the provider/model selectors visible in the default expanded state.
2. **System prompt input and persistence** — typing a system prompt in the Agent node autosaves it; navigating away and reopening the same flow restores the value, proving the field is wired to the flow JSON.
3. **In-component provider dropdown populates the model field** — selecting a provider via the in-component dropdown (`value-dropdown-dropdown_str_agent_llm`) and supplying the API key in the same popover causes the model field to populate with that provider's models. This validates the in-component setup path used by `general-bugs-agent-images-playground.spec.ts` — the centralized "Manage Model Providers" path is exercised elsewhere by `SimpleAgentTemplatePage`.
4. **Switching provider clears provider-specific fields** — configuring OpenAI first surfaces OpenAI-only fields (e.g. `reasoning_effort`); switching to Anthropic via the same dropdown removes the OpenAI-only fields from the node and exposes Anthropic-only defaults. Validates the field isolation referenced as a planned spec in `QA-CHECKLIST.md` section 3.5.

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
5. Assert the node header shows the title "Agent" (via `title-Agent` if available, fallback to `.react-flow__node` `getByText('Agent', { exact: true })`)
6. Assert the three core handles are visible:
   - `handle-agent-shownode-tools-left`
   - `handle-agent-shownode-language model-left`
   - `handle-agent-shownode-response-right`
7. Assert the in-component provider dropdown `value-dropdown-dropdown_str_agent_llm` is visible
8. Assert the system prompt field is visible (testid confirmed via DOM-inspection snippet during implementation — fallback: `getByLabel(/system\s*prompt/i)`)

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

**Test 3 — In-component provider dropdown populates the model field**
1. Skip when `OPENAI_API_KEY` is absent in the environment
2. `awaitBootstrapTest(page)` + `blank-flow` + drag Agent (same setup)
3. Open the in-component provider dropdown via `value-dropdown-dropdown_str_agent_llm`
4. Click the "OpenAI" entry in the dropdown (the popover for the API key opens automatically — same flow as `general-bugs-agent-images-playground.spec.ts` lines 24-32)
5. Fill the inline API-key popover (`popover-anchor-input-api_key`) with `OPENAI_API_KEY` (the popover auto-closes when the model dropdown is opened next; no explicit confirm button)
6. Open the model dropdown (`model_model`)
7. Assert at least one OpenAI-known model option is visible (option testid matching `gpt-*-option`, e.g. `gpt-4o-mini-option`)
8. Repeat steps 3-7 for Anthropic when `ANTHROPIC_API_KEY` is present (skipped otherwise); assert at least one Anthropic-known model option is visible (`claude-*-option`, e.g. `claude-sonnet-*-option`)

**Test 4 — Switching provider clears OpenAI-specific fields**
1. Skip when either `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` is absent
2. `awaitBootstrapTest(page)` + `blank-flow` + drag Agent
3. Configure OpenAI via the in-component dropdown (steps 3-6 from Test 3)
4. Assert that the OpenAI-only field is visible on the node — exact field name confirmed via DOM inspection during implementation (`reasoning_effort` is the canonical example per the issue text)
5. Open the in-component provider dropdown again and switch to Anthropic; fill `popover-anchor-input-api_key` with `ANTHROPIC_API_KEY`
6. Assert the OpenAI-only field is no longer visible on the node
7. Assert at least one Anthropic-known field is now visible (e.g. `claude-*` selectable in `model_model`)

---

## Validation criterion *(required)*

- Agent node visible on canvas with title and all three core handles (`tools-left`, `language model-left`, `response-right`)
- Provider dropdown (`value-dropdown-dropdown_str_agent_llm`) and system prompt field visible in the default rendered state
- System prompt value survives flow autosave + page navigation + flow re-open
- Selecting a provider via the in-component dropdown + supplying its API key causes the model dropdown to list at least one option from that provider
- Switching provider removes the previous provider's exclusive fields and exposes the new provider's defaults

---

## External dependencies *(required)*

- `src/lfx/src/lfx/components/agents/agent.py` — `AgentComponent` definition; the `agent_llm`, `system_prompt`, and `reasoning_effort` inputs and the provider-driven `update_build_config` are the schema this spec asserts against
- `src/backend/base/langflow/components/inputs/agent_input.py` (or equivalent provider-mapped inputs) — supplies the provider-specific fields that appear/disappear in Test 4
- `src/frontend/src/CustomNodes/GenericNode/components/parameterRenderComponent/` — renders the in-component provider dropdown and the API-key popover; the `value-dropdown-dropdown_str_agent_llm` and `popover-anchor-input-api_key` testids must remain stable
- `src/frontend/src/CustomNodes/GenericNode/` — renders the handles; the `handle-agent-shownode-{port}-{side}` pattern must remain stable

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
- Tests 1 and 2 do not require any provider API key — they exercise canvas rendering and autosave/restore only
- Test 3 requires `OPENAI_API_KEY`; the Anthropic branch additionally requires `ANTHROPIC_API_KEY`; missing keys cause graceful skip
- Test 4 requires both `OPENAI_API_KEY` and `ANTHROPIC_API_KEY`; missing either causes graceful skip
- Tests run in `serial` mode at the file level — each test creates and persists a flow, parallel runs would race on autosave

---

## When to review this test *(optional)*

- If the Agent component's input schema changes (additions or removals of provider-specific fields like `reasoning_effort`)
- If the `value-dropdown-dropdown_str_agent_llm`, `popover-anchor-input-api_key`, or `model_model` testids are renamed
- If the in-component provider configuration UX is replaced or removed in favor of the centralized "Manage Model Providers" panel
- If the autosave behavior changes (e.g. requires explicit save button instead of blur)

---

## Notes *(optional)*

- This spec deliberately uses the **blank flow + drag** path (lighter, no provider env keys needed for Tests 1-2) instead of `SimpleAgentTemplatePage.load()`. The template path deletes all flows, opens the new-project modal, and configures the provider via the centralized panel — none of which is necessary for canvas-level assertions, and all of which is already exercised by the execution spec in `llm-agents/`.
- Test 3 intentionally uses the in-component dropdown path (`value-dropdown-dropdown_str_agent_llm` + `popover-anchor-input-api_key`) instead of the centralized "Manage Model Providers" panel. The dropdown path is currently only validated as a side effect inside `general-bugs-agent-images-playground.spec.ts`; this spec promotes it to first-class coverage.
- Test 4's `reasoning_effort` field is the canonical OpenAI-only field referenced by issue #186. If the field is renamed or removed upstream, update both the assertion target and the `What this test does not cover` section above; do not expand the test into a full provider × field matrix without a follow-up spec.
- A file at the same name exists in `core-functionality/llm-agents/` covering execution behavior. The two specs are distinct in scope (canvas plumbing vs. Playground execution) and intentionally coexist; both spec docs cross-reference each other.
