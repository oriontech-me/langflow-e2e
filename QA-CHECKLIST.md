# Langflow — Regression Test Checklist

> **Repository:** `C:/QAx/langflow-playwright/langflow-e2e`
> **Tests:** `tests/tests-automations/regression/`
> **Config:** `playwright.config.ts`
> **Last updated:** 2026-07-21

---

## How to use this checklist

- `[x]` → automated and **validated** — only assigned when the underlying Playwright test carries the `@stable` tag
- `[-]` → automated, **needs validation** (test exists but is not yet `@stable`, or the entry refers to a Page/Helper rather than a test)
- `[ ]` (empty) → **needs automation**
- `[~]` → **partially** covered
- `[!]` → covered but **flaky / unstable**

---

---

# PART I — PAGES & HELPERS

---

## Pages

- [-] `SimpleAgentTemplatePage` — loads Simple Agent template with configurable provider and model → `pages/SimpleAgentTemplatePage.ts`
- [-] `SettingsPage` — navigation to the settings page via user menu → `pages/SettingsPage.ts`
- [ ] Component sidebar — component navigation bar with searchable parameter support
- [ ] Model Provider — navigation to the model provider management tab
- [ ] API Keys — navigation to the API keys / global variables tab
- [ ] Templates — navigation to the template selection tab (Starter Projects)
- [ ] Import Flow — navigation to import a flow via JSON
- [ ] Delete Flow — navigation to delete a flow
- [ ] MCP Config — navigation to configure MCP Server

---

## Helpers

### Provider Setup

- [-] OpenAI Provider Setup → `helpers/provider-setup/setup-openai.ts`
- [-] Anthropic Provider Setup → `helpers/provider-setup/setup-anthropic.ts`
- [-] Google Generative AI Provider Setup → `helpers/provider-setup/setup-google.ts`
- [-] Provider Map (`providerSetupMap`) — central registration point → `helpers/provider-setup/index.ts`
- [-] Provider validation via API (credit, valid key) → `helpers/provider-setup/collect-models.ts`
- [-] Collection of available models via UI (Settings → Model Providers) → `helpers/provider-setup/collect-models.ts`
- [-] `providers.json` — status of each provider (active/inactive + reason) → `data/providers.json`
- [-] `models.json` — list of models per provider → `data/models.json`

### Flows

- [-] Load Simple Agent with variable provider and model → `pages/SimpleAgentTemplatePage.ts`
- [-] Load Simple Agent with OpenAI (wrapper) → `helpers/flows/load-simple-agent-with-openai.ts`

### To implement

- [-] Configure an MCP → `helpers/mcp/configure-mcp-server.ts`
- [-] Configure a Custom Component → `helpers/flows/configure-custom-component.ts`
- [x] Delete a component → `helpers/flows/delete-component.ts`
- [x] Run a flow → `helpers/flows/run-flow.ts`
- [-] Pause a flow → `flow-functionality/stop-building.spec.ts`
- [x] Send a chat input → `flow-functionality/flow-execution-canvas.spec.ts`
- [x] Verify the chat output → `flow-functionality/flow-execution-canvas.spec.ts`

---

---

# PART II — TEST AUTOMATION COVERAGE

> Organized according to `tests/tests-automations/regression/`

---

## api/ — REST API

### api/flows/ — REST API

#### 1.1 Health Check
- [x] GET `/health_check` → status 200, db ok → `api-health-check.spec.ts`
- [x] GET `/api/v1/version` → returns version, main_version, package → `api-version.spec.ts`

#### 1.2 Flow CRUD via API
- [x] POST `/api/v1/flows/` → creates flow, returns ID → `api/flows/api-flows-crud.spec.ts`
- [x] GET `/api/v1/flows/` → lists user flows → `api/flows/api-flows-crud.spec.ts`
- [x] GET `/api/v1/flows/{id}` → returns flow by ID → `api/flows/api-flows-crud.spec.ts`
- [x] PATCH `/api/v1/flows/{id}` → updates name/description → `api/flows/api-flows-crud.spec.ts`
- [x] DELETE `/api/v1/flows/{id}` → removes flow, returns 200 → `api/flows/api-flows-crud.spec.ts`
- [x] GET `/api/v1/flows/{id}` after DELETE → should return 404 → `api/flows/api-flows-crud.spec.ts`

#### 1.3 Flow Execution via API
- [x] POST `/api/v1/run/{flow_id}` with `input_value` → returns response → `api/flows/api-run-flow.spec.ts`
- [x] POST with `tweaks` → parameters override flow configuration → `api/flows/api-run-with-tweaks.spec.ts`
- [x] POST with custom `session_id` → `api/flows/api-run-flow.spec.ts`
- [x] POST with custom `session_id` persists messages retrievable via `GET /api/v1/monitor/messages?session_id` → `api/flows/api-run-flow.spec.ts`
- [x] POST with `input_type: "chat"` and `output_type: "chat"` → `api/flows/api-run-flow.spec.ts`
- [x] POST with invalid API key → returns 401/403 → `api-invalid-key.spec.ts`
- [x] POST to non-existent flow → returns 404 → `api/flows/api-run-flow.spec.ts`

#### 1.4 Components via API
- [x] GET `/api/v1/all` → lists all available components → `api/flows/api-custom-component-creation.spec.ts`
- [x] POST `/api/v1/custom_component` → creates custom component → `api/flows/api-custom-component-creation.spec.ts`

#### 1.5 Messages and Monitoring via API
- [x] GET `/api/v1/monitor/messages` → returns 200 with array → `api/flows/api-monitor-messages.spec.ts`
- [x] GET with session_id filter returns only messages from that session → `api/flows/api-monitor-messages.spec.ts`

#### 1.6 Integration Code Generation
- [x] Generate curl for API execution → `flow-functionality/curlApiGeneration.spec.ts`
- [x] Generate Python code for integration → `flow-functionality/pythonApiGeneration.spec.ts`
- [x] API access modal → `flow-functionality/api-access-modal-regression.spec.ts`

#### 1.7 API Key Serialization & Expiry (PR #13471)
- [x] GET `/api/v1/api_key/` serializes `created_at`/`expires_at` as UTC ISO with `+00:00` offset and no microseconds; null `expires_at`/`last_used_at` stay null → `ui-ux/api-keys-timezone-display.spec.ts`
- [x] Expired API key is rejected on `POST /api/v1/run/{id}` with 403; valid key accepted with 200 → `api/flows/api-key-expiry-enforcement.spec.ts`
- [x] Expiry boundary is evaluated in UTC, not shifted by viewer offset (±30 min UTC keys resolve correctly) → `api/flows/api-key-expiry-enforcement.spec.ts`

---

## core-components/ — Component Configuration + Core Components

### 2. Component Configuration

#### 2.1 Parameters Panel
- [-] Open component advanced options
- [x] Edit text field (input) → `core-components/parameters-panel-field-types.spec.ts`
- [x] Edit dropdown → `core-components/parameters-panel-field-types.spec.ts`
- [x] Edit text area (textarea) → `core-components/parameters-panel-field-types.spec.ts`
- [x] Edit code field → `core-components/parameters-panel-field-types.spec.ts`
- [x] Edit float field → `core-components/parameters-panel-field-types.spec.ts`
- [x] Edit int field → `core-components/parameters-panel-field-types.spec.ts`
- [x] Edit toggle field → `core-components/parameters-panel-field-types.spec.ts`
- [x] Edit key-pair list → `core-components/parameters-panel-field-types.spec.ts`
- [-] Edit input list
- [x] Edit table input → `core-components/parameters-panel-field-types.spec.ts`
- [x] Edit slider → `core-components/parameters-panel-field-types.spec.ts`
- [x] Edit tab component → `core-components/parameters-panel-field-types.spec.ts`

#### 2.2 Tool Mode
- [x] Enable Tool Mode on a component
- [x] Group components in Tool Mode → `core-components/tool-mode-group.spec.ts`
- [x] Edit tools (slug, description, requires-approval persistence) → core-components/edit-tools.spec.ts

#### 2.3 Component Updates
- [x] Outdated component notification → `core-components/outdated-component-notification.spec.ts`
- [x] Update component action → `core-components/update-component-action.spec.ts`
- [x] Update with breaking change — should alert user → `core-components/component-breaking-change-alert.spec.ts`
- [x] Legacy component visible via configuration → `core-components/legacy-components-toggle-regression.spec.ts`
- [x] Beta component visible via configuration → `core-components/beta-components-toggle-regression.spec.ts`
- [x] Re-saving code removes handles from previously-toggled advanced fields → `core-components/general-bugs-delete-handle-advanced-input.spec.ts`

#### 2.4 Code Editing
- [x] Edit Python code of custom component — Check & Save clears the pulse-pink indicator → `core-components/customComponentAdd.spec.ts`
- [x] Full custom component → `core-components/full-custom-component.spec.ts`

---

### 3. Core Components

#### 3.1 Chat Input / Output
- [x] ChatInput renders on canvas with Message output handle and Input Text field → `core-components/chat-input-output-component-regression.spec.ts`
- [x] ChatOutput renders on canvas with Inputs handle and run button → `core-components/chat-input-output-component-regression.spec.ts`
- [x] ChatInput → ChatOutput connection accepted (Message ↔ Message) → `core-components/chat-input-output-component-regression.spec.ts`
- [x] Input Text propagates from ChatInput to ChatOutput on run → `core-components/chat-input-output-component-regression.spec.ts`
- [x] Sender name override is reflected in the Playground chat message → `core-components/chat-input-output-component-regression.spec.ts`
- [x] Default sender_name is "User" on input and "AI" on output → `core-components/chat-input-output-component-regression.spec.ts`
- [x] Toggling `showfiles` exposes the Files inspector field on Chat Input → `core-components/chat-input-files-field-regression.spec.ts`
- [x] Uploading a file via the Chat Input inspector populates the Files field → `core-components/chat-input-files-field-regression.spec.ts`
- [x] Inspector-attached file is rendered in the Playground after running ChatInput → ChatOutput → `core-components/chat-input-files-field-regression.spec.ts`
- [x] Dismiss button on the Files field clears the value → `core-components/chat-input-files-field-regression.spec.ts`
- [x] Chat Input is a singleton — adding one removes both the Chat Input and Webhook `+` buttons from the sidebar (mutual exclusion) → `core-components/singleton-components.spec.ts`
- [x] Chat Input cannot be duplicated (`Cmd/Ctrl+D`) or copy/pasted (`Cmd/Ctrl+C`+`V`) — blocked with the "components were not pasted" toast → `core-components/singleton-components.spec.ts`

#### 3.2 Prompt Template
- [x] Prompt Template renders on canvas with output handle → `core-components/prompt-template-component-regression.spec.ts`
- [x] Variables in curly braces generate dynamic input handles → `core-components/prompt-template-component-regression.spec.ts`
- [x] Removing a variable removes its input handle → `core-components/prompt-template-component-regression.spec.ts`
- [x] Replacing a variable updates handles accordingly → `core-components/prompt-template-component-regression.spec.ts`
- [x] Clearing the template removes all dynamic handles → `core-components/prompt-template-component-regression.spec.ts`
- [x] Modal edits persist in UI and in saved flow → `core-components/prompt-template-component-regression.spec.ts`
- [x] `use_double_brackets` toggle is exposed in the InspectionPanel with its upstream display name → `core-components/prompt-template-double-brackets-regression.spec.ts`
- [x] Default toggle state is OFF; f-string mode extracts `{var}` and treats `{{var}}` as literal → `core-components/prompt-template-double-brackets-regression.spec.ts`
- [x] Enabling toggle switches parser to mustache mode; `{{var}}` creates handle and `{var}` is ignored → `core-components/prompt-template-double-brackets-regression.spec.ts`
- [x] Disabling toggle reverts to f-string mode and variables are re-extracted under the new parser → `core-components/prompt-template-double-brackets-regression.spec.ts`
- [x] `use_double_brackets` value persists in the autosaved flow → `core-components/prompt-template-double-brackets-regression.spec.ts`
- [x] f-string parser rejects `{var.attr}` (dot notation) with an error toast and creates no handle → `core-components/prompt-template-invalid-patterns-regression.spec.ts`
- [x] f-string parser rejects `{var name}` (space inside identifier) with an error toast and creates no handle → `core-components/prompt-template-invalid-patterns-regression.spec.ts`
- [x] f-string parser rejects `{var,name}` (comma inside identifier) with an error toast and creates no handle → `core-components/prompt-template-invalid-patterns-regression.spec.ts`
- [x] f-string parser rejects `{1var}` (leading digit) with an error toast and creates no handle → `core-components/prompt-template-invalid-patterns-regression.spec.ts`
- [x] f-string parser accepts `{}` (empty braces) silently — no error, no handle → `core-components/prompt-template-invalid-patterns-regression.spec.ts`
- [x] f-string parser deduplicates repeated variables — `{name} and {name}` yields exactly one handle → `core-components/prompt-template-invalid-patterns-regression.spec.ts`
- [x] mustache parser rejects `{{ var }}` (spaces inside braces) with an error toast and creates no handle → `core-components/prompt-template-invalid-mustache-patterns-regression.spec.ts`
- [x] mustache parser rejects `{{var.attr}}` (dot notation) with an error toast and creates no handle → `core-components/prompt-template-invalid-mustache-patterns-regression.spec.ts`
- [x] mustache parser rejects `{{#section}}{{/section}}` with the complex-syntax message and creates no handle → `core-components/prompt-template-invalid-mustache-patterns-regression.spec.ts`
- [x] mustache parser rejects `{{{var}}}` (triple braces) with the complex-syntax message and creates no handle → `core-components/prompt-template-invalid-mustache-patterns-regression.spec.ts`

#### 3.3 API Request (HTTP)
- [x] Renders on canvas with URL and API Response handles → `core-components/api-request-component-regression.spec.ts`
- [x] Inspector fields accept URL and HTTP method values → `core-components/api-request-component-regression.spec.ts`
- [x] Execute GET request and verify 200 status and output structure → `core-components/api-request-component-regression.spec.ts`
- [x] Execute POST request and verify POST verb is sent (status 200) → `core-components/api-request-component-regression.spec.ts`
- [x] Execute PUT request and verify PUT verb is sent (status 200) → `core-components/api-request-component-regression.spec.ts`
- [x] Execute PATCH request and verify PATCH verb is sent (status 200) → `core-components/api-request-component-regression.spec.ts`
- [x] Execute DELETE request and verify DELETE verb is sent (status 200) → `core-components/api-request-component-regression.spec.ts`
- [x] Non-2xx HTTP response (404) propagated as status_code without crash → `core-components/api-request-component-regression.spec.ts`
- [x] Query parameters embedded in URL are sent and echoed in response → `core-components/api-request-component-regression.spec.ts`
- [x] Invalid URL error shows notification with descriptive error message → `core-components/api-request-component-regression.spec.ts`
- [x] Headers table accepts key + value cell entries via inspector → `core-components/api-request-component-regression.spec.ts`
- [x] cURL tab switches mode and exposes the cURL input field → `core-components/api-request-component-regression.spec.ts`
- [x] cURL parser auto-fills URL field and executes the GET, returning 200 → `core-components/api-request-component-regression.spec.ts`
- [x] Body table accepts key + value cell entries when method is POST (body field is `advanced=True` and hidden by inspector while method is GET) → `core-components/api-request-component-regression.spec.ts`
- [x] Flow state (URL, method, headers row) persists in database after autosave and rehydrates on reload → `core-components/api-request-component-regression.spec.ts`

#### 3.4 Webhook
- [x] POST aceita JSON e text/plain retornando 202 com `status: "in progress"` → `core-components/webhook-component-regression.spec.ts`
- [!] Flow salvo no banco contém o nó Webhook com endpoint="BACKEND_URL" → `core-components/webhook-component-regression.spec.ts` (fixme — upstream Accept-Language TypeError, see #165 item 2)
- [x] Campo cURL no inspector mostra URL válida com flow ID e flags corretas (`-X POST`, `Content-Type`, `-d`) → `core-components/webhook-component-regression.spec.ts`
- [x] Data field vazia retorna objeto Data vazio `{}` ao executar → `core-components/webhook-component-regression.spec.ts`
- [x] Campo endpoint (`str_endpoint`) renderiza a URL real do webhook → `core-components/webhook-component-regression.spec.ts`
- [x] Botão de cópia copia a URL correta para o clipboard e exibe toast "Endpoint URL copied" → `core-components/webhook-component-regression.spec.ts`
- [x] POST para flow inexistente retorna 404 → `core-components/webhook-component-regression.spec.ts`
- [x] GET `/api/v1/monitor/messages` retorna 200 com array → `core-components/webhook-component-regression.spec.ts`
- [x] Payload JSON recebido é propagado corretamente como saída Data do componente → `core-components/webhook-component-regression.spec.ts`
- [x] Payload inválido (não-JSON) é encapsulado em `{"payload": "..."}` na saída → `core-components/webhook-component-regression.spec.ts`
- [x] Webhook is a singleton — adding one removes both the Webhook and Chat Input `+` buttons from the sidebar (mutual exclusion) → `core-components/singleton-components.spec.ts`
- [x] Webhook cannot be duplicated (`Cmd/Ctrl+D`) or copy/pasted (`Cmd/Ctrl+C`+`V`) — blocked with the "components were not pasted" toast → `core-components/singleton-components.spec.ts`

#### 3.5 Agent (Component)
- [x] Agent component renders on canvas with title, handles and default fields → `core-components/agent-component-regression.spec.ts`
- [x] System prompt accepts input and persists across flow reload → `core-components/agent-component-regression.spec.ts`
- [x] Model dropdown exposes manage-model-providers and lists configured models → `core-components/agent-component-regression.spec.ts`
- [x] Selecting a different-provider model swaps the canvas provider icon → `core-components/agent-component-regression.spec.ts`

#### 3.6 Loop Component
- [x] Loop component renders on canvas with title and run button → `core-components/loop-component-regression.spec.ts`
- [x] Correct handles: inputs-left, item-left, item-right, done-right → `core-components/loop-component-regression.spec.ts`
- [x] Output inspection buttons present for item and done → `core-components/loop-component-regression.spec.ts`
- [x] Run without connections shows "Flow build failed" notification without crash → `core-components/loop-component-regression.spec.ts`
- [x] Loop iterates over 2 ArXiv articles (Research Translation Loop template) and aggregates response in Playground → `core-components/loop-component-regression.spec.ts`
- [x] Loop stops when exit condition is met → `core-components/loop-component-regression.spec.ts`

#### 3.7 Nested / Grouping
- [x] Nested component → `core-components/nested-grouping-regression.spec.ts`
- [x] Enter and exit grouped component → `core-components/nested-grouping-regression.spec.ts`

#### 3.8 If-Else Component
- [x] `operator=equals`: matching input routes through True branch (False branch stays inactive) → `core-components/if-else-component-regression.spec.ts`
- [x] `operator=equals`: non-matching input routes through False branch (True branch stays inactive) → `core-components/if-else-component-regression.spec.ts`
- [x] `operator=contains` substring routing → `core-components/if-else-component-regression.spec.ts`
- [x] `operator=regex` valid pattern routing → `core-components/if-else-component-regression.spec.ts`
- [x] `operator=regex` hides `case_sensitive` field via `update_build_config` → `core-components/if-else-component-regression.spec.ts`
- [x] `case_sensitive` ON (default) treats mixed case as no-match → `core-components/if-else-component-regression.spec.ts`
- [x] `case_sensitive` OFF treats mixed case as a match → `core-components/if-else-component-regression.spec.ts`
- [x] `operator=greater than` numeric routing → `core-components/if-else-component-regression.spec.ts`
- [ ] Other numeric operators (`less than`, `less than or equal`, `greater than or equal`) — share the same `float(...)` cast as `greater than`, not separately covered
- [ ] `max_iterations` + `default_route` cycle break

---

## core-functionality/ — Core and Operational Logic

### core-functionality/auth/ — Authentication and User Management

#### 4.1 Login / Logout
- [-] Login with valid credentials
- [-] Login with invalid credentials — should display error message
- [x] Logout — should redirect to login screen
- [-] Auto-login enabled — should skip login screen
- [-] Auto-login disabled — should display login screen
- [-] Expired session — should redirect to login
- [x] Session cleanup after logout

#### 4.2 User Management (Admin)
- [-] Admin creates new user
- [-] Admin deactivates user
- [-] Admin activates inactive user
- [-] Admin renames user
- [-] Admin changes user password
- [-] Admin changes password — old password does not work after change
- [-] Isolation flow: user A cannot see user B's flows

#### 4.3 Global Variables (API Keys)
- [x] Create global variable
- [-] Use global variable in component (API key) → `ui-ux/use-global-variable-in-component.spec.ts`
- [x] Edit existing global variable → `ui-ux/global-variable-edit.spec.ts`
- [x] Delete global variable
- [x] Create global variable of type "Generic"
- [x] Credential variable value is hidden from the variable list
- [x] Create global variable from Settings page → `ui-ux/global-variable-edit.spec.ts`

---

### core-functionality/knowledge-ingestion-management/ — Upload, Processing and Vectors

#### 5.1 File Upload
- [x] Upload file via component → `core-functionality/knowledge-ingestion-management/upload-via-component.spec.ts`
- [x] Upload files of different types (txt, pdf, json, py, wav) → `core-functionality/knowledge-ingestion-management/file-types-upload.spec.ts`
- [x] File size limit → `core-functionality/knowledge-ingestion-management/limit-file-size-upload.spec.ts`
- [x] File management page → `core-functionality/knowledge-ingestion-management/files-page.spec.ts`

#### 5.2 Processing and Vectorization
- [x] Split Text chunking of an ingested document → `core-functionality/knowledge-ingestion-management/split-text-chunking.spec.ts`
- [x] Indexing in Vector Store — document available for query → `core-functionality/knowledge-ingestion-management/vector-store-index-query.spec.ts`
- [x] Vector Store query returns relevant chunks for the prompt → `core-functionality/knowledge-ingestion-management/vector-store-index-query.spec.ts`
- [x] Complete RAG pipeline (ingest → embed → store → retrieve → answer) → `core-functionality/knowledge-ingestion-management/rag-pipeline.spec.ts`

---

### core-functionality/llm-agents/ — Agents and LLM Execution

> ⚠️ Tests in this section use `SimpleAgentTemplatePage` and are parameterized by model via `models.json`.
> Run `npx playwright test tests/collect-models.spec.ts` before executing these tests.
> See `CLAUDE.md` in this folder for the complete guide.

#### 6.1 agent-component-regression.spec.ts — Agent Behavior Regression `@stable`
- [x] Agent responds without connected tools
- [x] Agent displays valid response and optionally reasoning steps
- [x] Stop button interrupts agent execution
- [x] Execution duration displayed after successful run
- [x] Response displayed progressively in the Playground (streaming)
- [x] Duration indicator displayed on canvas (`node_duration_agent`) after closing the playground
- [x] Agent responds to multiple consecutive messages in the same session

#### 6.2 Other execution tests
- [-] Agent displays reasoning steps in Playground → `agent-reasoning-steps.spec.ts`
- [-] Composio (tool integration for Agent) → `composio.spec.ts`
- [x] Playground shows error when LLM run endpoint returns 500 (mocked invalid API key) → `llm-agents/llm-invalid-api-key-ui.spec.ts`
- [x] Playground input remains usable after API error (mocked) → `llm-agents/llm-invalid-api-key-ui.spec.ts`
- [ ] Agent stops when configured stop condition is reached
- [x] Agent stops when maximum number of iterations is reached → `core-functionality/llm-agents/agent-max-iterations.spec.ts`
- [x] Agent with multiple configured tools executes correctly → `agent-multi-tool-selection.spec.ts`
- [ ] Agent with configured timeout respects the limit
- [x] Connecting an external model in Agent drops the prior model selection (connection-mode isolation, prevents stale provider config) → `llm-agents/agent-model-connection-isolation.spec.ts`
- [x] Flow with Agent saved and reopened → settings preserved → `core-functionality/llm-agents/agent-config-persistence.spec.ts`
- [x] max_tokens truncates response as configured → `llm-agents/agent-max-tokens.spec.ts` (validated at token level via the Playground token-usage tooltip)

#### 6.3 Memory and Context
- [x] Memory Chatbot template loads with correct node and edge structure → `llm-agents/memory-history-regression.spec.ts`
- [x] Message History retains context between messages in the same Playground session → `llm-agents/memory-history-regression.spec.ts`
- [x] Session isolation: distinct session IDs have independent histories → `llm-agents/memory-history-regression.spec.ts`
- [x] Without Message History, LLM does not retain context between messages → `llm-agents/memory-history-regression.spec.ts`
- [x] n_messages parameter limits the number of retained messages → `llm-agents/agent-n-messages-limit.spec.ts` (bug reported fixed on 1.11.0.dev33 — parameter now respected; validated by deterministic message count)
- [x] Agent uses custom `context_id` — continuity between session messages → `agent-context-id-continuity.spec.ts`
- [x] Switching `context_id` isolates history between distinct sessions → `agent-context-id-isolation.spec.ts`

#### 6.4 Tools and Integrations
- [ ] Agent with integrated external MCP tool executes action and returns result
- [ ] Agent executes multiple tools in sequence
- [x] Tool returns error — agent handles it and continues execution → `core-functionality/llm-agents/agent-tool-error-handling.spec.ts`
- [x] Multiple connected tools — agent selects the correct one for each prompt → `agent-multi-tool-selection.spec.ts`
- [x] Tool with invalid name — validation prevents execution with clear message → `core-functionality/llm-agents/agent-tool-name-validation.spec.ts`

#### 6.5 Output and Reasoning
- [ ] Inspect tools used by Agent in Playground
- [x] Agent returns output in structured JSON format (output_schema) → `agent-structured-output.spec.ts`
- [-] Agent returns output in correctly rendered Markdown → `llm-agents/agent-markdown-output.spec.ts`
- [x] Agent Instructions (system prompt) is respected in the model response → `agent-system-prompt.spec.ts`
- [x] Input via direct field vs handle (ChatInput) — both work → `core-functionality/llm-agents/agent-input-sources.spec.ts`
- [x] Empty response or model refusal — component does not crash → `core-functionality/llm-agents/agent-empty-refusal-response.spec.ts`
- [x] Toggle add_current_date_tool works (enables/disables date tool) → `agent-current-date-tool.spec.ts`
- [~] handle_parsing_errors=False fails explicitly vs True auto-corrects → `agent-parse-error-behavior.spec.ts` (**partially covered on 1.11**: the field is present and togglable, but True/False are behaviorally identical — the field now only toggles `ToolRetryMiddleware`, and component-tool failures are converted to content by the hardcoded `handle_tool_error=True` before the middleware can observe them; the only live trigger (LLM-emitted malformed args) is non-deterministic, so the semantic difference is not deterministically testable — re-scope tracked in #496)
- [x] Image passed via input handle is processed correctly → `core-functionality/llm-agents/agent-multimodal-image-input.spec.ts`

---

### core-functionality/model-provider/ — Provider Management

> ⚠️ Provider configuration tests via Settings use `SettingsPage`.
> See `helpers/provider-setup/` for the setup helpers of each provider.

#### 7.1 Provider Collection and Validation
- [x] Validate API keys of all providers via real call → `collect-models.spec.ts`
- [x] Collect available models per provider via UI → `collect-models.spec.ts`
- [x] Inactive providers appear as skipped in tests with reason → `agent-component-regression.spec.ts`
- [x] Configure provider API key via Save Configuration (first setup) → `collect-models.spec.ts`
- [x] Replace provider API key via Replace Configuration (existing key) → `collect-models.spec.ts`

#### 7.2 OpenAI
- [x] Configure OpenAI API key in Settings → Model Providers → `core-functionality/model-provider/openai-provider.spec.ts`
- [x] Select GPT model in agent → `core-functionality/model-provider/openai-provider.spec.ts`
- [x] Execute flow with OpenAI → `core-functionality/model-provider/openai-provider.spec.ts`
- [x] Invalid API key error — display error message → `core-functionality/llm-agents/provider-invalid-auth-error.spec.ts`

#### 7.3 Anthropic
- [x] Configure Anthropic API key in Settings → Model Providers → `core-functionality/model-provider/anthropic-provider.spec.ts`
- [x] Select Claude model in agent → `core-functionality/model-provider/anthropic-provider.spec.ts`
- [x] Switch between Claude models (Sonnet, Haiku, Opus) → `core-functionality/model-provider/anthropic-provider.spec.ts`
- [x] Invalid Anthropic API key error → `core-functionality/llm-agents/provider-invalid-auth-error.spec.ts`

#### 7.4 Google Generative AI
- [x] Configure Google API key in Settings → Model Providers → `core-functionality/model-provider/google-provider.spec.ts`
- [x] Select Gemini model in agent → `core-functionality/model-provider/google-provider.spec.ts`
- [x] Invalid Google API key error → `core-functionality/llm-agents/provider-invalid-auth-error.spec.ts`

#### 7.5 Provider Management
- [x] "Manage Model Providers" modal → `llm-agents/modelProviderModal.spec.ts` + `llm-agents/model-provider-modal-actions.spec.ts`
- [x] Available provider count → `llm-agents/model-provider-modal-actions.spec.ts`
- [x] Language Model component — configuration → `llm-agents/language-model-regression.spec.ts`
- [x] Model Input component → `llm-agents/modelInputComponent.spec.ts`
- [x] Add new provider via modal → `llm-agents/model-provider-api-key.spec.ts` (positive add validated via invalid-key rejection + Replace edit surface — a real re-add poisons a backend credential cache, see #505)
- [x] Remove API key from existing provider → `llm-agents/remove-provider-api-key.spec.ts`
- [x] Per-model enable/disable toggle changes immediately and persists across reopen → `llm-agents/model-provider-model-toggle.spec.ts`
- [x] Disabling a model in Settings removes it from a component model dropdown; re-enabling restores it → `llm-agents/model-provider-model-toggle.spec.ts`

#### 7.6 Open-Source Providers
- [x] Configure and execute flow with Ollama (local model) → `model-provider/ollama-provider.spec.ts`
- [x] Configure and execute flow with Groq → `model-provider/groq-provider.spec.ts`
- [x] Configure and execute flow with Mistral → `model-provider/mistral-provider.spec.ts`

#### 7.7 Model Parameters (Agent)
- [x] Maximum token count — response truncated as configured → `llm-agents/agent-max-tokens.spec.ts`
- [x] Maximum agent iterations → `core-functionality/llm-agents/agent-max-iterations.spec.ts`
- [x] Use of custom `context_id` for memory isolation → `agent-context-id-isolation.spec.ts`
- [x] Output formatting (JSON via output_schema, Markdown, plain text) → `agent-structured-output.spec.ts`

---

### core-functionality/observability-monitoring/ — Tracing, Logs and Metrics

#### 8.1 Traces
- [x] View execution traces
- [x] Trace API returns paginated transactions
- [x] Trace displays latency of each component
- [x] Trace displays tokens consumed
- [x] Single-trace API returns 404 for an unknown trace_id → `traces-detail-single.spec.ts`
- [x] Single-trace API returns the full TraceRead contract with a non-empty span tree → `traces-detail-single.spec.ts`
- [x] Single-trace API returns populated tokenUsage + modelName on the LLM span (OpenAI) → `traces-detail-llm-span-populated.spec.ts`
- [x] Bulk delete traces API returns 404 for an unknown flow_id → `traces-delete.spec.ts`
- [x] Bulk delete traces API clears all traces for the flow (204 + empty list) → `traces-delete.spec.ts`
- [x] Bulk delete of a trace with a populated span tree cascades (204, no FK violation) — regression #13955 → `traces-delete-cascade.spec.ts`
- [x] Trace list filter `?status=error` returns only the failing trace; `?status=<unknown>` returns 422 → `traces-list-filters.spec.ts`
- [x] Trace list filter `?status=ok` returns only the successful trace → `traces-list-filters.spec.ts`
- [x] Trace list filter `?start_time` pins the >= lower bound (past hits, future misses) → `traces-list-filters.spec.ts`
- [x] Trace list filter `?query=<substring>` filters by trace name, incl. 50-char sanitize cap → `traces-list-filters.spec.ts`
- [x] Trace list filter `?session_id` filters by the session passed at run time → `traces-list-filters.spec.ts`

#### 8.2 Notifications
- [x] System notifications — build-success entry shows in the notifications tab → `notifications.spec.ts`
- [x] Execution error notification → `ui-ux/execution-error-notification.spec.ts`
- [x] Outdated component notification → `core-components/outdated-component-notification.spec.ts`

#### 8.3 User State
- [x] Track user progress → `core-functionality/project-management/user-progress-track.spec.ts`
- [x] User flow state cleanup → `flow-functionality/user-flow-state-cleanup.spec.ts`

#### 8.4 Error Handling and Edge Cases
- [x] Component that raises Python error → `core-components/validate-raise-errors-components.spec.ts`
- [x] Flow with error displays appropriate message → `core-functionality/observability-monitoring/flow-error-message.spec.ts`
- [x] Network error during execution → ui-ux/execution-error-notification.spec.ts
- [x] Execution timeout — clear message to user → `ui-ux/execution-error-notification.spec.ts` (transport-timeout path: `route.abort("timedout")` → "Workflow run failed" / "Failed to fetch"; the distinct deployed-flow "Run timed out. Please try again." is out of scope — see #694)

---

### core-functionality/playground/ — Chat, Rendering and Output Tests

#### 9.1 Chat Interactions
- [x] Open Playground → exercised by every `@stable` playground spec via `playground-btn-flow-io`
- [x] Send text message → exercised by `playground-ux.spec.ts`, `playground-message-edit.spec.ts`, `playground-session-nav.spec.ts` and others
- [x] Receive LLM response → exercised by all specs that send a message via ChatInput → ChatOutput echo flow
- [x] Response streaming (SSE) → `core-functionality/playground/playground-response-streaming-sse.spec.ts`
- [x] Response polling → api/flows/api-build-polling-response.spec.ts
- [x] Direct response → `api/flows/api-build-direct-response.spec.ts`
- [x] Playground UX (playground-ux) → `playground/playground-ux.spec.ts`
- [x] Send empty message — send button stays enabled by design (only disabled while a file upload is in progress) → `playground/playground-empty-message-send.spec.ts`
- [-] Send message while response is in progress — should wait or queue → `playground/playground-send-while-in-progress.spec.ts`
- [x] Attach image in chat — compact preview appears in input before sending → `core-functionality/playground/playground-output-image.spec.ts`
- [x] Image rendered in user message bubble after sending → `core-functionality/playground/playground-output-image.spec.ts`
- [x] Attach non-image file (.txt) in chat — preview tile renders (delete button visible, no `<img>`) → `core-functionality/playground/playground-non-image-attachment.spec.ts`
- [x] Non-image file rendered in user message after sending — truncated filename appears, no image emitted → `core-functionality/playground/playground-non-image-attachment.spec.ts`
- [x] Attach multiple images — one compact preview per file is shown in the input → `core-functionality/playground/playground-attachments-management.spec.ts`
- [x] Remove one of two attachments — the remaining preview stays intact → `core-functionality/playground/playground-attachments-management.spec.ts`
- [x] Send with multiple attachments — all images render in the user message → `core-functionality/playground/playground-attachments-management.spec.ts`
- [x] Remove the only attachment — input returns to empty state and text-only send still works → `core-functionality/playground/playground-attachments-management.spec.ts`
- [x] Swap attachment (remove A, attach B) — only B is sent → `core-functionality/playground/playground-attachments-management.spec.ts`
- [x] ChatInput Input Text pre-fills the playground textarea on first open → `core-functionality/playground/playground-input-text-prefill.spec.ts`
- [x] ChatInput Input Text re-pre-fills the textarea on a new session → `core-functionality/playground/playground-input-text-prefill.spec.ts`
- [x] Pre-filled Input Text can be sent as the first message of the session → `core-functionality/playground/playground-input-text-prefill.spec.ts`

#### 9.2 History and Session
- [x] Configure custom session ID → `core-functionality/playground/playground-session-id.spec.ts`
- [x] Switch session — messages are isolated per session → `core-functionality/playground/playground-session-nav.spec.ts`
- [x] Edit user message — hover reveals edit button, saved changes replace original text → `core-functionality/playground/playground-message-edit.spec.ts`
- [x] Cancel message edit — original text is preserved → `core-functionality/playground/playground-message-edit.spec.ts`
- [x] Message edited in playground is reflected in Session Logs → `core-functionality/playground/playground-message-edit.spec.ts`
- [x] Clear chat removes all messages from Default Session (clear-chat-option via header menu) → `core-functionality/playground/playground-session-clear.spec.ts`
- [x] Clear full session history (Default session) → `playground/playground-clear-history.spec.ts`
- [x] Delete user-created session → `playground/playground-clear-history.spec.ts`
- [x] History persists when reopening Playground → `llm-agents/memory-history-regression.spec.ts`, `core-functionality/playground/playground-history-persist.spec.ts`
- [x] Rename unavailable for the Default Session → `core-functionality/playground/playground-session-rename.spec.ts`
- [x] Rename unavailable for a session with no messages → `core-functionality/playground/playground-session-rename.spec.ts`
- [x] Rename available and functional for a session with messages (Enter confirms, Escape cancels) → `core-functionality/playground/playground-session-rename.spec.ts`
- [x] Create new session via new-chat button → `core-functionality/playground/playground-session-nav.spec.ts`
- [x] Switch between sessions via session selector sidebar → `core-functionality/playground/playground-session-nav.spec.ts`
- [x] Open Message Logs via session more-menu → `core-functionality/playground/playground-message-logs.spec.ts`
- [x] Delete messages inside Message Logs table → `core-functionality/playground/playground-message-logs.spec.ts`
- [x] Select individual session checkbox → reveals bulk-delete-button → `core-functionality/playground/playground-bulk-delete.spec.ts`
- [x] Select all non-default sessions via select-all-checkbox → `core-functionality/playground/playground-bulk-delete.spec.ts`
- [x] Bulk delete selected sessions → Default Session preserved → `core-functionality/playground/playground-bulk-delete.spec.ts`

#### 9.3 Advanced Playground Features
- [x] Playground fullscreen mode → `playground/playground-fullscreen.spec.ts`
- [x] Shareable Playground — URL generation validated (switch enables sharing, href matches /playground/uuid) → `playground/playground-shareable-url.spec.ts`
- [!] Voice mode (voice assistant) → `ui-ux/voice-assistant.spec.ts` (**all tests unconditionally skipped — spec is a stub**)
- [x] Stop button in Playground → `core-functionality/playground/stop-button-playground.spec.ts`

#### 9.4 Output Modal
- [x] Copy component output → `core-functionality/playground/output-modal-copy-button.spec.ts`
- [x] Copy button in output → `core-functionality/playground/output-modal-copy-button.spec.ts`

#### 9.5 Structured Data Output
- [x] JSON Data output renders as code block → `core-functionality/playground/playground-output-data.spec.ts`
- [x] DataFrame output renders as Markdown table → `core-functionality/playground/playground-output-data.spec.ts`

---

### core-functionality/project-management/ — Project and Folder Management

#### 10.1 Folder CRUD
- [x] Create new folder → `core-functionality/project-management/folder-crud.spec.ts`
- [x] Rename folder → `core-functionality/project-management/folder-crud.spec.ts`
- [x] Delete empty folder → `core-functionality/project-management/folder-crud.spec.ts`
- [x] Delete folder with flows inside → `core-functionality/project-management/folder-crud.spec.ts`
- [-] Integrity after deletion
- [-] Create folder after deleting all folders
- [-] Upload flow by drag-and-drop to folder
- [-] Move flow to another folder

#### 10.2 Folder Navigation
- [~] Navigate between folders
- [-] Search flow by name filters results correctly
- [-] Folders in navigation sidebar

---

### core-functionality/templates/ — Predefined Flow and Component Models

#### 11.1 Basic Templates
- [-] Basic Prompting (OpenAI)
- [-] Basic Prompting (Anthropic)
- [-] Simple Agent (OpenAI)
- [-] Simple Agent (Anthropic)
- [-] Simple Agent with memory
- [-] Vector Store RAG
- [x] Memory Chatbot
- [-] **Basic Prompting** (OpenAI) → `core/integrations/Basic Prompting.spec.ts`
- [-] **Basic Prompting** (Anthropic) → `core/integrations/Basic Prompting Anthropic.spec.ts`
- [-] **Simple Agent** (OpenAI) → `core/integrations/Simple Agent.spec.ts`
- [-] **Simple Agent** (Anthropic) → `core/integrations/Simple Agent Anthropic.spec.ts`
- [-] **Simple Agent** with memory → `core/integrations/Simple Agent Memory.spec.ts`
- [-] **Vector Store RAG** → `core/integrations/Vector Store.spec.ts`
- [x] **Memory Chatbot** → `llm-agents/memory-history-regression.spec.ts`

#### 11.2 Content Generation Templates
- [-] Blog Writer
- [-] Instagram Copywriter
- [-] Twitter Thread Generator
- [-] SEO Keyword Generator
- [-] Portfolio Website Code Generator
- [-] SaaS Pricing

#### 11.3 Analysis and Processing Templates
- [-] Document QA
- [-] Invoice Summarizer
- [-] Financial Report Parser
- [-] Image Sentiment Analysis
- [-] Text Sentiment Analysis
- [-] Youtube Analysis

#### 11.4 Agent Templates
- [-] Dynamic Agent
- [-] Hierarchical Agent
- [-] Sequential Task Agent
- [-] Social Media Agent
- [-] Travel Planning Agent
- [-] Market Research
- [-] Research Translation Loop
- [-] Pokedex Agent
- [-] Price Deal Finder
- [-] News Aggregator

#### 11.5 Advanced Templates
- [-] Custom Component Generator
- [-] Prompt Chaining
- [-] Decision Flow
- [-] Similarity
- [-] MCP Server (starter projects)

---

## flow-functionality/ — Graph Execution, Drag-and-Drop and JSON

#### 12.1 Create Flow
- [x] Create blank flow → `flow-functionality/create-blank-flow.spec.ts`
- [x] Create flow from template → `flow-functionality/create-flow-from-template.spec.ts`
- [x] Create flow by duplicating an existing one → `flow-functionality/duplicate-flow.spec.ts`
- [x] Create flow via JSON file import → `flow-functionality/export-import-flow.spec.ts`

#### 12.2 View and Edit Flow
- [x] Rename flow via editor header → `flow-functionality/flow-rename-header.spec.ts`
- [x] Rename flow and verify on main page listing → `core-functionality/project-management/edit-flow-name.spec.ts`
- [x] Edit flow name and description → `core-components/edit-name-description-node.spec.ts`
- [x] Flow auto-save on changes → `flow-functionality/auto-save-off.spec.ts`
- [x] Flow settings → `core-functionality/project-management/flowSettings.spec.ts`

#### 12.3 Delete Flow
- [x] Delete individual flow → `ui-ux/actionsMainPage-shard-1.spec.ts`
- [x] Delete multiple flows (bulk actions) → `core-functionality/project-management/bulk-actions.spec.ts`
- [x] Shift-click range select + Ctrl/Cmd-click multi-select on main page → `core-functionality/project-management/bulk-actions.spec.ts`
- [x] Bulk download selected flows → `core-functionality/project-management/bulk-actions.spec.ts`
- [x] Confirm deleted flow does not appear in listing (after bulk delete) → `core-functionality/project-management/bulk-actions.spec.ts`

#### 12.4 Export / Import Flow
- [x] Export flow as JSON → `flow-functionality/export-import-flow.spec.ts`
- [x] Exported JSON contains valid data.nodes structure → `flow-functionality/export-import-flow.spec.ts`
- [x] Import flow via JSON file upload (drag-drop + upload button) → `flow-functionality/export-import-flow.spec.ts`
- [~] Import flow with outdated components
- [x] Import invalid JSON — should display error message → `flow-functionality/import-invalid-json.spec.ts`

#### 12.5 Flow Operations
- [x] Lock flow — prevents editing → `flow-functionality/lock-flow.spec.ts`
- [x] Unlock flow → `flow-functionality/flow-lock.spec.ts`
- [x] Move flow between folders via API → `api/flows/api-folders-crud.spec.ts`
- [x] Publish flow → `flow-functionality/publish-flow.spec.ts`
- [x] Save flow components as template → `core-components/saveComponents.spec.ts`

#### 12.6 Flow Execution
- [x] Run Flow component executes another flow → `flow-functionality/run-flow.spec.ts`
- [x] Run a flow from the canvas — terminal-node run builds the whole graph; all nodes reach build success and output is produced → `flow-functionality/flow-execution-canvas.spec.ts`
- [x] Stop building flow → `flow-functionality/stop-building.spec.ts`
- [!] Playground button disabled with empty flow — needs review → `regression/flow-functionality/generalBugs-shard-3.spec.ts` (**test skipped: assertion was a no-op, current Langflow behavior to confirm**)

---

## mcp/ — Model Context Protocol

> ⚠️ Tests that execute agents via MCP must use `SimpleAgentTemplatePage` and `models.json`.
> See `CLAUDE.md` in this folder for the complete guide.

### mcp/client/ — Tool and Context Consumption

#### 13.1 MCP Client
- [-] Configure connection with external MCP server (stdio or HTTP) → `mcp/client/mcp-client-regression.spec.ts`
- [-] List available tools via MCP protocol → `mcp/client/mcp-client-regression.spec.ts`
- [-] Execute MCP server tool and receive result in flow → `mcp/client/mcp-client-regression.spec.ts`
- [-] MCP server connection error — unreachable server produces empty tool dropdown → `mcp/client/mcp-client-regression.spec.ts`
- [-] Configure connection via HTTP form tab → `mcp/client/mcp-client-regression.spec.ts`
- [-] Execute numeric tool with inputs and verify result → `mcp/client/mcp-client-regression.spec.ts`
- [x] Duplicate MCP server registration returns 409 Conflict → `mcp/client/mcp-server-registration-status-codes.spec.ts`
- [x] Deleting a non-existent MCP server returns 404 Not Found → `mcp/client/mcp-server-registration-status-codes.spec.ts`
- [-] Agent uses MCPTools as tool and calls echo via MCP → `mcp/client/mcp-client-agent.spec.ts`
- [-] Gemini × MCP tool-calling regression — agent runs but invokes no echo MCP tool (guards upstream #440) → `mcp/client/mcp-client-agent-gemini-tool-regression.spec.ts`
- [ ] List available resources via MCP protocol
- [ ] Consume resource URI and inject content into flow

---

### mcp/server/ — Resource and Tool Provider

#### 14.1 MCP Server
- [-] MCP Server tab in flow
- [-] Add MCP server via modal
- [-] Starter project with MCP
- [-] Flow exposed as MCP server — verify generated endpoint → `mcp/server/mcp-server-protocol.spec.ts`
- [-] Execute MCP server tool via MCP protocol → `mcp/server/mcp-server-protocol.spec.ts`
- [ ] Resource exposed by server is accessible via URI (no product surface on 1.11.x — MCP server `resources/list` returns `[]`; #829)
- [ ] Prompt exposed by server returns correct template (no product surface on 1.11.x — MCP server `prompts/list` returns `[]`; #829)

---

## ui-ux/ — Visual Interface, Canvas and Design System

#### 15.1 Component Sidebar
- [-] Search component by name
- [-] Hover over component shows tooltip/preview
- [-] Keyboard search (keyboard shortcut)
- [-] Filter components by category
- [-] Sidebar shows correct provider count

#### 15.2 Add Components to Canvas
- [-] Drag component from sidebar to canvas
- [-] Double-click in sidebar adds component to canvas
- [x] Hover + click "+" button adds component to canvas → `core-components/componentHoverAdd.spec.ts`
- [-] Added component appears with default settings

#### 15.3 Component Connections
- [-] Connect two compatible components
- [-] Prevent connection between incompatible types
- [-] Delete edge/connection
- [-] Filter edges by data type
- [-] Reconnect existing edge

#### 15.4 Node Manipulation
- [x] Delete component from canvas via Backspace key → `core-components/componentDelete.spec.ts`
- [x] Delete component from canvas via node options (...) menu → `core-components/componentDelete.spec.ts`
- [x] Copy and paste ChatOutput component (Ctrl+C / Ctrl+V) → `flow-functionality/canvas-copy-paste.spec.ts`
- [x] Copy and paste Prompt Template (component with dynamic ports) (Ctrl+C / Ctrl+V) → `flow-functionality/canvas-copy-paste.spec.ts`
- [-] Canvas keyboard shortcuts
- [-] Minimize component on canvas
- [-] Move component within canvas
- [-] Select multiple components via box selection
- [x] Delete multiple selected components (marquee box selection) → `core-components/componentDelete.spec.ts`
- [-] Deselect node by clicking on empty canvas area
- [-] Deselect node via Escape

#### 15.5 Canvas Zoom and Navigation
- [-] Zoom in / Zoom out
- [-] Fit View centers nodes
- [-] Fit View button in toolbar
- [-] Scroll to navigate canvas
- [~] Minimap — feature flag-gated

#### 15.6 Grouping
- [-] Create component group
- [-] Ungroup components
- [-] Expand/collapse group

#### 15.7 Freeze and State
- [-] Freeze component
- [-] Freeze path
- [-] Unfreeze component

#### 15.8 Sticky Notes
- [-] Add sticky note
- [x] Edit sticky note text → `ui-ux/edit-sticky-note-text.spec.ts`
- [-] Change sticky note color
- [-] Resize sticky note
- [-] Delete sticky note

#### 15.9 Right-Click and Menus
- [-] Context menu via right-click on canvas
- [-] Context menu via right-click on component
- [-] Main menu actions

#### 15.10 Settings and UI Configuration
- [-] Access Settings page
- [-] Message history settings → `ui-ux/settings-message-history.spec.ts`
- [x] Change appearance/theme settings — dark/light toggle updates #body.dark class → `ui-ux/settings-theme-toggle.spec.ts`
- [-] Keyboard shortcuts work in editor
- [~] All documented shortcuts work
- [x] Edit a keyboard shortcut (Duplicate → `Ctrl/Cmd+Alt+U`) persists to the table and the new combination triggers the action on canvas → `ui-ux/settings-shortcuts-edit.spec.ts`
- [x] API Keys table renders `created_at`/`expires_at` in the viewer's local timezone (UTC→local), shows "Never" for unused keys and ∞ for no-expiry keys (PR #13471) → `ui-ux/api-keys-timezone-display.spec.ts`

---

## Coverage Summary — Test Automation Coverage

> **Validated** = test carries the `@stable` tag.
> **Needs validation** = automated but not yet `@stable` (bug, flake under investigation, or pending team review).

| Module | Total | Validated `[x]` | Needs validation `[-]` | Partial `[~]`/`[!]` | Not automated `[ ]` |
|--------|-------|-----------------|------------------------|---------------------|---------------------|
| `api/flows/` — REST API | 25 | 25 | 0 | 0 | 0 |
| `core-components/` — Component Config | 24 | 22 | 2 | 0 | 0 |
| `core-components/` — Core Components | 82 | 79 | 0 | 1 | 2 |
| `core-functionality/auth/` | 21 | 8 | 13 | 0 | 0 |
| `core-functionality/knowledge-ingestion/` | 8 | 8 | 0 | 0 | 0 |
| `core-functionality/llm-agents/` | 39 | 30 | 3 | 1 | 5 |
| `core-functionality/model-provider/` | 31 | 31 | 0 | 0 | 0 |
| `core-functionality/observability-monitoring/` | 24 | 24 | 0 | 0 | 0 |
| `core-functionality/playground/` | 48 | 46 | 0 | 1 | 1 |
| `core-functionality/project-management/` | 11 | 4 | 6 | 1 | 0 |
| `core-functionality/templates/` | 41 | 2 | 39 | 0 | 0 |
| `flow-functionality/` | 28 | 26 | 0 | 2 | 0 |
| `mcp/client/` | 12 | 2 | 8 | 0 | 2 |
| `mcp/server/` | 7 | 0 | 5 | 0 | 2 |
| `ui-ux/` — Canvas | 44 | 7 | 36 | 1 | 0 |
| `ui-ux/` — Settings | 7 | 3 | 3 | 1 | 0 |
| **TOTAL** | **452** | **317 (70%)** | **115 (25%)** | **8 (2%)** | **12 (3%)** |

> Note: `Validated [x]` counts checklist bullets, not `test()` calls. The
> `@stable` tag is per-`test()`, and a single `@stable` test may map to
> several bullets via `test.step()` (e.g. the agent suite covers 7
> bullets). The canonical list of `@stable` `test()` calls is in
> **Phase 0 — Validated** below.

---

## Implementation Roadmap

---

### 🟢 Phase 0 — Validated

> 352 `test()` calls carrying the `@stable` tag, distributed across 142 spec
> files. Run weekly by the stable workflow. New specs are merged with all
> tests tagged `@stable`; the tag is removed per-test during weekly triage
> when a failure is classified as a test bug — so a spec may end up with a
> mix of tagged and untagged tests over time.

#### api/flows/
- [x] direct event_delivery streams build events inline (no job_id) and echoes the input → `api-build-direct-response.spec.ts`
- [x] direct is distinct from the job_id path: streaming delivery returns a job_id → `api-build-direct-response.spec.ts`
- [x] polling is the two-step path: POST returns a job_id shell (no inline events) → `api-build-polling-response.spec.ts`
- [x] the poll loop drains the build to completion across repeated GET /events calls → `api-build-polling-response.spec.ts`
- [x] POST /api/v1/custom_component returns valid component structure → `api-custom-component-creation.spec.ts`
- [x] POST /api/v1/custom_component with invalid code returns error → `api-custom-component-creation.spec.ts`
- [x] GET /api/v1/all includes component types → `api-custom-component-creation.spec.ts`
- [x] POST /api/v1/custom_component without auth returns 401 or 403 → `api-custom-component-creation.spec.ts`
- [x] POST creates flow and returns ID → `api-flows-crud.spec.ts`
- [x] GET lists flows and includes the created one → `api-flows-crud.spec.ts`
- [x] GET by ID returns correct flow → `api-flows-crud.spec.ts`
- [x] PATCH updates flow name and description → `api-flows-crud.spec.ts`
- [x] DELETE removes flow and returns 200 → `api-flows-crud.spec.ts`
- [x] GET after DELETE returns 404 → `api-flows-crud.spec.ts`
- [x] GET non-existent flow returns 404 → `api-flows-crud.spec.ts`
- [x] POST with missing name returns 422 → `api-flows-crud.spec.ts`
- [x] deleted flow does not appear in flows listing → `api-flows-crud.spec.ts`
- [x] POST creates folder and returns ID and name → `api-folders-crud.spec.ts`
- [x] GET lists folders and includes the created one → `api-folders-crud.spec.ts`
- [x] DELETE removes folder and it no longer appears in listing → `api-folders-crud.spec.ts`
- [x] moving flow between folders via PATCH folder_id updates association → `api-folders-crud.spec.ts`
- [x] GET /health_check returns 200 with status ok → `api-health-check.spec.ts`
- [x] GET /health_check returns db ok → `api-health-check.spec.ts`
- [x] GET /health_check responds within 5 seconds → `api-health-check.spec.ts`
- [x] GET /health_check response has correct content-type → `api-health-check.spec.ts`
- [x] POST /api/v1/flows/ with invalid Bearer token returns 401, 403, or 422 → `api-invalid-key.spec.ts`
- [x] GET /api/v1/flows/ without Authorization header returns 401 or 403 → `api-invalid-key.spec.ts`
- [x] GET /api/v1/flows/{id} with invalid Bearer token returns 401 or 403 → `api-invalid-key.spec.ts`
- [x] POST /api/v1/run/{id} with invalid x-api-key returns 401 or 403 → `api-invalid-key.spec.ts`
- [x] DELETE /api/v1/flows/{id} without Authorization header returns 401 or 403 → `api-invalid-key.spec.ts`
- [x] PATCH /api/v1/flows/{id} with wrong token does not update the flow → `api-invalid-key.spec.ts`
- [x] rejects an expired API key with 403 and accepts a valid one with 200 → `api-key-expiry-enforcement.spec.ts`
- [x] evaluates the expiry boundary in UTC, not shifted by the viewer offset → `api-key-expiry-enforcement.spec.ts`
- [x] returns 200 with array → `api-monitor-messages.spec.ts`
- [x] without auth returns 401 or 403 → `api-monitor-messages.spec.ts`
- [x] filtered by session_id returns only matching messages → `api-monitor-messages.spec.ts`
- [x] filtered by flow_id returns only matching messages → `api-monitor-messages.spec.ts`
- [x] combined session_id and flow_id filters return 200 → `api-monitor-messages.spec.ts`
- [x] messages contain required fields when not empty → `api-monitor-messages.spec.ts`
- [x] executes flow with input_value and returns outputs → `api-run-flow.spec.ts`
- [x] executes flow with custom session_id and persists messages under it → `api-run-flow.spec.ts`
- [x] returns 404 for non-existent flow ID → `api-run-flow.spec.ts`
- [x] tweaks override a component field at runtime → `api-run-with-tweaks.spec.ts`
- [x] empty tweaks object is a no-op and leaves the flow default in effect → `api-run-with-tweaks.spec.ts`
- [x] tweaks referencing a non-existent component are silently ignored → `api-run-with-tweaks.spec.ts`
- [x] GET /api/v1/version returns 200 with a non-empty version string → `api-version.spec.ts`
- [x] GET /api/v1/version reports the Langflow package and main_version → `api-version.spec.ts`
- [x] GET /api/v1/version response has correct content-type → `api-version.spec.ts`
- [x] GET /api/v1/version responds within 5 seconds → `api-version.spec.ts`
- [x] POST /api/v1/version returns 405 Method Not Allowed → `api-version.spec.ts`

#### core-components/
- [x] renders on canvas with default fields and handles → `agent-component-regression.spec.ts`
- [x] system prompt accepts input and persists across flow reload → `agent-component-regression.spec.ts`
- [x] model dropdown exposes manage-model-providers and lists configured models → `agent-component-regression.spec.ts`
- [x] selecting a different-provider model swaps the canvas provider icon → `agent-component-regression.spec.ts`
- [x] API Request component — renders on canvas with correct output and URL handles → `api-request-component-regression.spec.ts`
- [x] API Request component — inspector fields accept configured values → `api-request-component-regression.spec.ts`
- [x] API Request component — invalid URL is accepted by field and run shows error notification → `api-request-component-regression.spec.ts`
- [x] API Request component — GET request returns 200 and output Data contains all required fields → `api-request-component-regression.spec.ts`
- [x] API Request component — PUT method executes PUT verb and returns 200 → `api-request-component-regression.spec.ts`
- [x] API Request component — PATCH method executes PATCH verb and returns 200 → `api-request-component-regression.spec.ts`
- [x] API Request component — DELETE method executes DELETE verb and returns 200 → `api-request-component-regression.spec.ts`
- [x] API Request component — non-2xx HTTP response propagates status_code without crashing → `api-request-component-regression.spec.ts`
- [x] API Request component — query parameters embedded in URL are sent and echoed → `api-request-component-regression.spec.ts`
- [x] API Request component — inspector headers table accepts key + value cell entries → `api-request-component-regression.spec.ts`
- [x] API Request component — cURL tab switches mode and field accepts a cURL command → `api-request-component-regression.spec.ts`
- [x] API Request component — cURL mode parses command, auto-fills URL, executes GET and returns 200 → `api-request-component-regression.spec.ts`
- [x] API Request component — body table accepts key + value cell entries when method is POST → `api-request-component-regression.spec.ts`
- [x] API Request component — flow state persists in database after autosave (URL, method, headers) → `api-request-component-regression.spec.ts`
- [x] Show Beta Components toggle controls visibility of beta components in the sidebar → `beta-components-toggle-regression.spec.ts`
- [x] Chat Input — toggling `showfiles` exposes the Files inspector field → `chat-input-files-field-regression.spec.ts`
- [x] Chat Input — uploading via the inspector populates the Files field → `chat-input-files-field-regression.spec.ts`
- [x] Chat Input → Chat Output — inspector-attached file is rendered in the Playground message → `chat-input-files-field-regression.spec.ts`
- [x] Chat Input — clicking the dismiss button on the Files field clears the value → `chat-input-files-field-regression.spec.ts`
- [x] Chat Input component — renders on canvas with Message output handle and Input Text field → `chat-input-output-component-regression.spec.ts`
- [x] Chat Output component — renders on canvas with Inputs handle and run button → `chat-input-output-component-regression.spec.ts`
- [x] Chat Input → Chat Output connection is accepted on canvas (Message ↔ Message) → `chat-input-output-component-regression.spec.ts`
- [x] Chat Input → Chat Output — Input Text value propagates to ChatOutput on run → `chat-input-output-component-regression.spec.ts`
- [x] Chat Input — sender_name override is reflected in the Playground chat message → `chat-input-output-component-regression.spec.ts`
- [x] Chat Input/Output — default sender_name is 'User' on input and 'AI' on output → `chat-input-output-component-regression.spec.ts`
- [x] breaking-change outdated components alert with a Review action, not a silent Update → `component-breaking-change-alert.spec.ts`
- [x] reviewing a single breaking change warns about disconnection and defaults to a backup → `component-breaking-change-alert.spec.ts`
- [x] Review All flags every outdated component as breaking and pre-selects none → `component-breaking-change-alert.spec.ts`
- [x] Should delete a single component with the Backspace key → `componentDelete.spec.ts`
- [x] Should delete a single component via the node options menu → `componentDelete.spec.ts`
- [x] Should delete multiple selected components with a marquee selection → `componentDelete.spec.ts`
- [x] user can add components by hovering and clicking the plus icon → `componentHoverAdd.spec.ts`
- [x] custom component code button should be pink when adding custom component → `customComponentAdd.spec.ts`
- [x] user should be able to edit name and description of a node → `edit-name-description-node.spec.ts`
- [x] user can edit a URL tool action in Tool Mode and the edits persist → `edit-tools.spec.ts`
- [x] a full custom component built from code exposes its declared interface → `full-custom-component.spec.ts`
- [x] the system must delete the handles from advanced fields when the code is updated → `general-bugs-delete-handle-advanced-input.spec.ts`
- [x] If-Else routes matching input through the True branch and skips the False branch → `if-else-component-regression.spec.ts`
- [x] If-Else routes non-matching input through the False branch and skips the True branch → `if-else-component-regression.spec.ts`
- [x] If-Else operator=contains routes a substring match through the True branch → `if-else-component-regression.spec.ts`
- [x] If-Else operator=regex routes a valid pattern match through the True branch → `if-else-component-regression.spec.ts`
- [x] If-Else operator=regex hides the case_sensitive advanced field → `if-else-component-regression.spec.ts`
- [x] If-Else case_sensitive defaults to ON — mixed-case inputs route to the False branch → `if-else-component-regression.spec.ts`
- [x] If-Else with case_sensitive=OFF treats mixed-case inputs as a match (True branch) → `if-else-component-regression.spec.ts`
- [x] If-Else operator=greater than routes a numeric match (10 > 5) through the True branch → `if-else-component-regression.spec.ts`
- [x] Show Legacy Components toggle controls visibility of legacy components in the sidebar → `legacy-components-toggle-regression.spec.ts`
- [x] Loop component — renders correctly with all handles and output inspection buttons → `loop-component-regression.spec.ts`
- [x] Loop component — run without connections shows build failed notification → `loop-component-regression.spec.ts`
- [x] Loop component — Research Translation Loop template: full wiring and iterates over 2 ArXiv papers → `loop-component-regression.spec.ts`
- [x] Loop component — stops after exhausting input DataFrame and emits aggregated done → `loop-component-regression.spec.ts`
- [x] box-selecting two connected non-IO components and clicking Group collapses them into a single Group node → `nested-grouping-regression.spec.ts`
- [x] ungrouping a Group node restores the original components and the edge between them → `nested-grouping-regression.spec.ts`
- [x] importing a flow with outdated components raises the flow-level outdated notification → `outdated-component-notification.spec.ts`
- [x] the outdated-notification count matches the per-node update indicators → `outdated-component-notification.spec.ts`
- [x] text input field edit persists → `parameters-panel-field-types.spec.ts`
- [x] dropdown field edit persists → `parameters-panel-field-types.spec.ts`
- [x] textarea field edit persists → `parameters-panel-field-types.spec.ts`
- [x] int field edit persists → `parameters-panel-field-types.spec.ts`
- [x] tab field edit persists → `parameters-panel-field-types.spec.ts`
- [x] toggle field edit persists → `parameters-panel-field-types.spec.ts`
- [x] float field edit persists → `parameters-panel-field-types.spec.ts`
- [x] slider field edit persists → `parameters-panel-field-types.spec.ts`
- [x] code field edit persists → `parameters-panel-field-types.spec.ts`
- [x] table field edit persists → `parameters-panel-field-types.spec.ts`
- [x] key-pair field edit persists → `parameters-panel-field-types.spec.ts`
- [x] Prompt Template component — renders on canvas with output handle → `prompt-template-component-regression.spec.ts`
- [x] Prompt Template component — variables in curly braces generate dynamic input handles → `prompt-template-component-regression.spec.ts`
- [x] Prompt Template component — removing a variable removes its input handle → `prompt-template-component-regression.spec.ts`
- [x] Prompt Template component — replacing a variable updates handles accordingly → `prompt-template-component-regression.spec.ts`
- [x] Prompt Template component — clearing the template removes all dynamic handles → `prompt-template-component-regression.spec.ts`
- [x] Prompt Template component — modal edits persist in UI and in saved flow → `prompt-template-component-regression.spec.ts`
- [x] Prompt Template — use_double_brackets toggle is exposed in the InspectionPanel with its upstream display name → `prompt-template-double-brackets-regression.spec.ts`
- [x] Prompt Template — default toggle state is OFF; f-string mode extracts {var} and treats {{var}} as literal → `prompt-template-double-brackets-regression.spec.ts`
- [x] Prompt Template — enabling toggle switches parser to mustache mode; {{var}} creates handle and {var} is ignored → `prompt-template-double-brackets-regression.spec.ts`
- [x] Prompt Template — disabling toggle reverts to f-string mode and variables are re-extracted under the new parser → `prompt-template-double-brackets-regression.spec.ts`
- [x] Prompt Template — use_double_brackets value persists in the autosaved flow → `prompt-template-double-brackets-regression.spec.ts`
- [x] Prompt Template — mustache `{{ var }}` (spaces inside braces) is rejected with an error toast and creates no handle → `prompt-template-invalid-mustache-patterns-regression.spec.ts`
- [x] Prompt Template — mustache `{{var.attr}}` (dot notation) is rejected with an error toast and creates no handle → `prompt-template-invalid-mustache-patterns-regression.spec.ts`
- [x] Prompt Template — mustache `{{#section}}{{/section}}` is rejected with the complex-syntax message and creates no handle → `prompt-template-invalid-mustache-patterns-regression.spec.ts`
- [x] Prompt Template — mustache `{{{var}}}` (triple braces) is rejected with the complex-syntax message and creates no handle → `prompt-template-invalid-mustache-patterns-regression.spec.ts`
- [x] Prompt Template — `{var.attr}` (dot notation) is rejected with an error toast and creates no handle → `prompt-template-invalid-patterns-regression.spec.ts`
- [x] Prompt Template — `{var name}` (space inside identifier) is rejected with an error toast and creates no handle → `prompt-template-invalid-patterns-regression.spec.ts`
- [x] Prompt Template — `{var,name}` (comma inside identifier) is rejected with an error toast and creates no handle → `prompt-template-invalid-patterns-regression.spec.ts`
- [x] Prompt Template — `{1var}` (leading digit) is rejected with an error toast and creates no handle → `prompt-template-invalid-patterns-regression.spec.ts`
- [x] Prompt Template — `{}` (empty braces) is accepted by the parser and creates no handle → `prompt-template-invalid-patterns-regression.spec.ts`
- [x] Prompt Template — repeating the same variable produces exactly one handle (deduplication contract) → `prompt-template-invalid-patterns-regression.spec.ts`
- [x] saving a canvas component as a template makes it reusable from the sidebar → `saveComponents.spec.ts`
- [x] should allow only one Chat Input on the canvas → `singleton-components.spec.ts`
- [x] should not allow adding a Webhook while a Chat Input is on the canvas → `singleton-components.spec.ts`
- [x] should not allow duplicating a Chat Input → `singleton-components.spec.ts`
- [x] should not allow copying and pasting a Chat Input → `singleton-components.spec.ts`
- [x] should allow only one Webhook on the canvas → `singleton-components.spec.ts`
- [x] should not allow adding a Chat Input while a Webhook is on the canvas → `singleton-components.spec.ts`
- [x] should not allow duplicating a Webhook → `singleton-components.spec.ts`
- [x] should not allow copying and pasting a Webhook → `singleton-components.spec.ts`
- [x] a component in Tool Mode can be grouped with its Agent consumer → `tool-mode-group.spec.ts`
- [x] User should be able to use components as tool → `tool-mode.spec.ts`
- [x] applying a single component update refreshes it, decrements the outdated count, and creates a backup → `update-component-action.spec.ts`
- [x] user should be able to see errors on popups when raise an error → `validate-raise-errors-components.spec.ts`
- [x] Webhook component — HTTP POST accepts JSON and plain-text bodies returning 202 → `webhook-component-regression.spec.ts`
- [x] Webhook component — cURL command in inspector shows valid POST URL with flow ID → `webhook-component-regression.spec.ts`
- [x] Webhook component — empty data field returns empty Data object → `webhook-component-regression.spec.ts`
- [x] Webhook component — endpoint field renders the actual webhook URL → `webhook-component-regression.spec.ts`
- [x] Webhook component — copy button copies the endpoint URL to clipboard → `webhook-component-regression.spec.ts`
- [x] Webhook component — POST to non-existent flow name returns 404 → `webhook-component-regression.spec.ts`
- [x] Webhook component — valid JSON payload is propagated as structured Data output → `webhook-component-regression.spec.ts`
- [x] Webhook component — invalid JSON payload is encapsulated in {payload: ...} → `webhook-component-regression.spec.ts`
- [x] GET /api/v1/monitor/messages returns 200 with array response → `webhook-component-regression.spec.ts`

#### core-functionality/auth/
- [x] logout must redirect user to login page → `logout-flow.spec.ts`
- [x] after logout, navigating to root must redirect to login → `logout-flow.spec.ts`
- [x] after logout, reload must stay on login page → `logout-flow.spec.ts`

#### core-functionality/knowledge-ingestion-management/
- [x] upload a <ext> file through the Files page → `file-types-upload.spec.ts`
- [x] should navigate to Files page and expose upload affordances → `files-page.spec.ts`
- [x] should upload file using upload button → `files-page.spec.ts`
- [x] should upload file using drag and drop → `files-page.spec.ts`
- [x] should upload multiple files with different types → `files-page.spec.ts`
- [x] should search uploaded files → `files-page.spec.ts`
- [x] should handle bulk actions for multiple files → `files-page.spec.ts`
- [x] user should not be able to upload a file larger than the limit → `limit-file-size-upload.spec.ts`
- [x] Full RAG pipeline grounds the model answer on the retrieved chunk → `rag-pipeline.spec.ts`
- [x] Split Text splits an ingested document into the expected number of chunks → `split-text-chunking.spec.ts`
- [x] upload a file through the Read File component and read its content → `upload-via-component.spec.ts`
- [x] Knowledge Base indexes the ingested document chunks (available for query) → `vector-store-index-query.spec.ts`
- [x] Knowledge Base query returns the relevant chunk for the prompt → `vector-store-index-query.spec.ts`

#### core-functionality/llm-agents/
- [x] agent interaction suite → `agent-component-regression.spec.ts`
- [x] Agent settings survive save and reopen → `agent-config-persistence.spec.ts`
- [x] agent run persists every session message tagged with the custom context_id → `agent-context-id-continuity.spec.ts`
- [x] context-scoped retrieval returns all turns of the context and not the untagged control → `agent-context-id-continuity.spec.ts`
- [x] mirrored context-scoped retrievals return only their own context's messages → `agent-context-id-isolation.spec.ts`
- [x] switching the agent's context_id re-tags new turns without touching previous ones → `agent-context-id-isolation.spec.ts`
- [x] toggle ON (default): agent's date tool returns today's date → `agent-current-date-tool.spec.ts`
- [x] toggle OFF: the date tool is removed from the agent's toolkit → `agent-current-date-tool.spec.ts`
- [x] model refusal does not crash the component → `agent-empty-refusal-response.spec.ts`
- [x] empty response does not crash the component → `agent-empty-refusal-response.spec.ts`
- [x] input via ChatInput handle drives the agent response → `agent-input-sources.spec.ts`
- [x] input via the Agent's direct field drives the agent response → `agent-input-sources.spec.ts`
- [x] agent stops when max iterations is reached → `agent-max-iterations.spec.ts`
- [x] causal control — a high max iterations does not hit the limit → `agent-max-iterations.spec.ts`
- [x] max_tokens=50 caps the response's output tokens → `agent-max-tokens.spec.ts`
- [x] causal control — unset max_tokens generates freely → `agent-max-tokens.spec.ts`
- [x] selecting 'Connect other models' clears the previously selected model → `agent-model-connection-isolation.spec.ts`
- [x] agent selects the URL tool for a fetch prompt → `agent-multi-tool-selection.spec.ts`
- [x] agent selects the Web Search tool for a search prompt → `agent-multi-tool-selection.spec.ts`
- [x] image via input handle is described by the agent → `agent-multimodal-image-input.spec.ts`
- [x] negative control — no image, no image-specific description → `agent-multimodal-image-input.spec.ts`
- [x] a small n_messages truncates retrieval to the most recent messages → `agent-n-messages-limit.spec.ts`
- [x] causal control — a large n_messages retrieves the full seeded history → `agent-n-messages-limit.spec.ts`
- [x] output_schema fields come back as typed JSON keys on the structured response → `agent-structured-output.spec.ts`
- [x] a multiple (As List) schema row returns an array of the row's type → `agent-structured-output.spec.ts`
- [x] Agent Instructions are respected in the model response → `agent-system-prompt.spec.ts`
- [x] negative control — sentinel is absent without the instruction → `agent-system-prompt.spec.ts`
- [x] an invalid tool name blocks execution with a clear message → `agent-tool-name-validation.spec.ts`
- [x] causal control — a valid custom tool name executes normally → `agent-tool-name-validation.spec.ts`
- [x] language model must respond with Google provider → `language-model-regression.spec.ts`
- [x] language model provider switch from OpenAI to Google must persist → `language-model-regression.spec.ts`
- [x] model provider dialog opens from the Language Model node → `language-model-regression.spec.ts`
- [x] playground shows error when LLM run endpoint returns 500 (mocked invalid API key) → `llm-invalid-api-key-ui.spec.ts`
- [x] playground input remains usable after API error (mocked) → `llm-invalid-api-key-ui.spec.ts`
- [x] memory chatbot template loads with correct node structure → `memory-history-regression.spec.ts`
- [x] message history context retention suite → `memory-history-regression.spec.ts`
- [x] session isolation: new session has no context from previous session → `memory-history-regression.spec.ts`
- [x] OpenAI provider is listed in Model Providers settings → `model-provider-api-key.spec.ts`
- [x] Anthropic provider is listed in Model Providers settings → `model-provider-api-key.spec.ts`
- [x] a configured provider exposes the key edit surface (Replace, no raw input) → `model-provider-api-key.spec.ts`
- [x] an invalid API key is rejected and does not enable the provider → `model-provider-modal-actions.spec.ts`
- [x] selecting another provider switches the visible detail panel → `model-provider-modal-actions.spec.ts`
- [x] model toggle changes immediately and persists across reopen → `model-provider-model-toggle.spec.ts`
- [x] disabling a model removes it from a component model dropdown → `model-provider-model-toggle.spec.ts`
- [x] the Language Model node renders its model selector → `modelInputComponent.spec.ts`
- [x] opening the model dropdown lists model options → `modelInputComponent.spec.ts`
- [x] the model dropdown exposes the Manage Model Providers entry → `modelInputComponent.spec.ts`
- [x] the trigger shows the selected model name → `modelInputComponent.spec.ts`
- [x] provider list renders with the known providers → `modelProviderModal.spec.ts`
- [x] selecting a provider opens its API key configuration detail → `modelProviderModal.spec.ts`
- [x] a configured provider shows its model selection panel → `modelProviderModal.spec.ts`
- [x] should display error message when using invalid authentication for provider <provider> → `provider-invalid-auth-error.spec.ts`
- [x] a provider credential variable can be removed through the Global Variables UI → `remove-provider-api-key.spec.ts`
- [x] DELETE /api/v1/variables/{id} removes a provider API key variable → `remove-provider-api-key.spec.ts`

#### core-functionality/model-provider/
- [x] Anthropic API key is configured via Settings → Model Providers → `anthropic-provider.spec.ts`
- [x] configured Anthropic selects a Claude model in the Agent and executes the flow → `anthropic-provider.spec.ts`
- [x] switches between Claude model families (Haiku → Sonnet → Opus) → `anthropic-provider.spec.ts`
- [x] Google API key is configured via Settings → Model Providers → `google-provider.spec.ts`
- [x] configured Google selects a Gemini model in the Agent and executes the flow → `google-provider.spec.ts`
- [x] the Groq component configures the API key and executes the flow → `groq-provider.spec.ts`
- [x] the MistralAI component configures the API key and executes the flow → `mistral-provider.spec.ts`
- [x] Ollama base URL is configured via Settings → Model Providers → `ollama-provider.spec.ts`
- [x] the Ollama component lists the local model live and executes the flow → `ollama-provider.spec.ts`
- [x] OpenAI API key is configured via Settings → Model Providers → `openai-provider.spec.ts`

#### core-functionality/observability-monitoring/
- [x] a misconfigured flow surfaces an appropriate build-error message → `flow-error-message.spec.ts`
- [x] Clearing traces for a flow whose trace has spans succeeds (cascade), leaving no traces behind → `traces-delete-cascade.spec.ts`
- [x] DELETE /api/v1/monitor/traces returns 404 for an unknown flow_id → `traces-delete.spec.ts`
- [x] DELETE /api/v1/monitor/traces?flow_id=... clears all traces, and a second DELETE on the empty owned flow still returns 204 → `traces-delete.spec.ts`
- [x] GET /api/v1/monitor/traces/{trace_id} returns a populated tokenUsage + modelName on the LLM span → `traces-detail-llm-span-populated.spec.ts`
- [x] GET /api/v1/monitor/traces/{trace_id} returns 404 for an unknown but well-formed UUID → `traces-detail-single.spec.ts`
- [x] GET /api/v1/monitor/traces/{trace_id} returns the full TraceRead contract with a non-empty span tree → `traces-detail-single.spec.ts`
- [x] GET /api/v1/monitor/transactions returns 200 with paginated result → `traces-detail.spec.ts`
- [x] GET /api/v1/monitor/transactions filters by flow_id (UUID) → `traces-detail.spec.ts`
- [x] transaction records contain required fields when not empty → `traces-detail.spec.ts`
- [x] GET /api/v1/monitor/traces returns totalLatencyMs and totalTokens for a flow run → `traces-latency-tokens.spec.ts`
- [x] Flow Activity page shows latency and token columns for the run → `traces-latency-tokens.spec.ts`
- [x] Trace Details modal shows span tree and per-span latency → `traces-latency-tokens.spec.ts`
- [x] GET /api/v1/monitor/traces?status=error returns only the failing trace; rejects unknown values → `traces-list-filters.spec.ts`
- [x] GET /api/v1/monitor/traces?status=ok returns only the successful trace → `traces-list-filters.spec.ts`
- [x] GET /api/v1/monitor/traces?start_time pins the >= lower bound → `traces-list-filters.spec.ts`
- [x] GET /api/v1/monitor/traces?query=<substring> filters by trace name (incl. 50-char sanitize cap) → `traces-list-filters.spec.ts`
- [x] GET /api/v1/monitor/traces?session_id filters by the session passed at run time → `traces-list-filters.spec.ts`
- [x] should be able to see and interact with Traces → `traces.spec.ts`

#### core-functionality/playground/
- [x] copy button copies Chat Input output and toggles Check icon → `output-modal-copy-button.spec.ts`
- [x] playground must show one compact preview per attached image when two images are attached → `playground-attachments-management.spec.ts`
- [x] playground must keep the remaining preview when one of two attachments is removed → `playground-attachments-management.spec.ts`
- [x] playground must render both attached images in the user message after sending → `playground-attachments-management.spec.ts`
- [x] playground input must return to empty state after removing the only attachment → `playground-attachments-management.spec.ts`
- [x] playground swap flow must send only the second image when the first is removed before attaching the second → `playground-attachments-management.spec.ts`
- [x] selecting an individual session checkbox must reveal the bulk-delete-button → `playground-bulk-delete.spec.ts`
- [x] select-all-checkbox must select all non-default sessions → `playground-bulk-delete.spec.ts`
- [x] bulk-delete-button must remove all selected sessions from the sidebar → `playground-bulk-delete.spec.ts`
- [x] clear chat on Default session must remove messages but keep the session → `playground-clear-history.spec.ts`
- [x] deleting a user-created session must remove it and return to Default session → `playground-clear-history.spec.ts`
- [x] send button stays enabled regardless of input content → `playground-empty-message-send.spec.ts`
- [x] clearing the input after typing leaves the field empty → `playground-empty-message-send.spec.ts`
- [x] playground opens in fullscreen with chat input visible → `playground-fullscreen.spec.ts`
- [x] playground closes and reopens correctly from the flow editor → `playground-fullscreen.spec.ts`
- [x] messages sent in playground must persist after closing and reopening → `playground-history-persist.spec.ts`
- [x] playground opens with chat textarea pre-filled from ChatInput Input Text → `playground-input-text-prefill.spec.ts`
- [x] edit user message — hover reveals edit button and saved changes replace original text → `playground-message-edit.spec.ts`
- [x] cancel message edit — original text is preserved → `playground-message-edit.spec.ts`
- [x] message edited in playground is reflected in Session Logs → `playground-message-edit.spec.ts`
- [x] message-logs-option must open the Session Logs modal for the active session → `playground-message-logs.spec.ts`
- [x] selecting messages in the log table and deleting them must reduce the row count → `playground-message-logs.spec.ts`
- [x] playground must show non-image preview tile (delete button, no <img>) in input area after attaching a .txt file → `playground-non-image-attachment.spec.ts`
- [x] playground must render non-image attachment in user message (truncated filename + zero file-images) after sending a .txt → `playground-non-image-attachment.spec.ts`
- [x] playground must render JSON Data output as a code block → `playground-output-data.spec.ts`
- [x] playground must render DataFrame output as a markdown table → `playground-output-data.spec.ts`
- [x] playground must show image compact preview in input area after attaching an image → `playground-output-image.spec.ts`
- [x] playground must display uploaded image in user message after sending → `playground-output-image.spec.ts`
- [x] Playground run is delivered over an SSE (text/event-stream) response → `playground-response-streaming-sse.spec.ts`
- [x] session selector sidebar must switch to the selected session → `playground-session-nav.spec.ts`
- [x] rename option must not be available for a session with no messages → `playground-session-rename.spec.ts`
- [x] rename option must be available and functional for a session with messages → `playground-session-rename.spec.ts`
- [x] Shareable playground URL is generated when publishing is enabled → `playground-shareable-url.spec.ts`
- [x] user message must appear instantly in playground before AI responds → `playground-ux.spec.ts`
- [x] playground must scroll to latest message after sending → `playground-ux.spec.ts`
- [x] playground input field must be ready after flow responds → `playground-ux.spec.ts`
- [x] User must be able to stop building from inside Playground → `stop-button-playground.spec.ts`

#### core-functionality/project-management/
- [x] user should be able to select flows with different methods and perform bulk actions → `bulk-actions.spec.ts`
- [x] flow settings enforce character limits and persist name & description → `flowSettings.spec.ts`
- [x] creates, renames and deletes an empty project folder via the UI → `folder-crud.spec.ts`
- [x] deleting a folder that contains a flow removes the flow with it → `folder-crud.spec.ts`
- [x] getting-started progress increments as onboarding steps complete → `user-progress-track.spec.ts`

#### flow-functionality/
- [x] API access modal opens from the Publish dropdown exposing the Python, JavaScript and cURL tabs → `api-access-modal-regression.spec.ts`
- [x] API access modal switches the displayed snippet when changing language tabs → `api-access-modal-regression.spec.ts`
- [x] API access modal embeds the current flow ID in the generated run endpoint URL → `api-access-modal-regression.spec.ts`
- [x] API access modal closes cleanly via Escape and via the close button → `api-access-modal-regression.spec.ts`
- [x] user should be able to manually save a flow when the auto_save is off → `auto-save-off.spec.ts`
- [x] copy and paste ChatOutput component via Ctrl+C / Ctrl+V → `canvas-copy-paste.spec.ts`
- [x] copy and paste Prompt Template (component with dynamic ports) via Ctrl+C / Ctrl+V → `canvas-copy-paste.spec.ts`
- [x] user can create a blank flow from the new-project modal → `create-blank-flow.spec.ts`
- [x] user can create a flow from a starter template → `create-flow-from-template.spec.ts`
- [x] user can copy a valid macOS/Linux curl command from the API access modal → `curlApiGeneration.spec.ts`
- [x] user can duplicate a flow from the home page dropdown menu → `duplicate-flow.spec.ts`
- [x] duplicate flow via API auto-suffixes the name on collision → `duplicate-flow.spec.ts`
- [x] export flow to JSON triggers success toast and produces a valid file → `export-import-flow.spec.ts`
- [x] imported JSON flow must load all components on canvas → `export-import-flow.spec.ts`
- [x] import flow from JSON via upload button must load flow on canvas → `export-import-flow.spec.ts`
- [x] 1 - runs the flow from the canvas terminal node → `flow-execution-canvas.spec.ts`
- [x] 2 - the flow ran correctly: every node reached build success → `flow-execution-canvas.spec.ts`
- [x] 3 - the chat input and chat output are visible in the Playground → `flow-execution-canvas.spec.ts`
- [x] should lock and unlock a flow and verify UI changes → `flow-lock.spec.ts`
- [x] should show correct lock/unlock icon in settings based on state → `flow-lock.spec.ts`
- [x] flow can be renamed via the header edit → `flow-rename-header.spec.ts`
- [x] flow name persists after rename via API PATCH and GET → `flow-rename-header.spec.ts`
- [x] import invalid JSON must show error message → `import-invalid-json.spec.ts`
- [x] import non-JSON file must show error message → `import-invalid-json.spec.ts`
- [x] import JSON with missing data field must show error → `import-invalid-json.spec.ts`
- [x] user must be able to lock a flow and it must be saved → `lock-flow.spec.ts`
- [x] user can publish a flow and access it via shareable URL, then unpublish to revoke access → `publish-flow.spec.ts`
- [x] publish flow via API toggles access_type between PUBLIC and PRIVATE → `publish-flow.spec.ts`
- [x] user can copy a valid Python requests snippet from the API access modal → `pythonApiGeneration.spec.ts`
- [x] user should be able to use Run Flow without any issues → `run-flow.spec.ts`
- [x] user must be able to stop a building from the canvas → `stop-building.spec.ts`
- [x] flow state should be properly cleaned up between user sessions → `user-flow-state-cleanup.spec.ts`

#### mcp/client/
- [x] agent calls echo MCP tool and returns echoed message → `mcp-client-agent.spec.ts`
- [x] unreachable HTTP server results in empty tool dropdown → `mcp-client-regression.spec.ts`
- [x] configures MCP server via HTTP form tab and verifies registration → `mcp-client-regression.spec.ts`
- [x] selects get-sum tool, provides numeric inputs, and verifies sum in output → `mcp-client-regression.spec.ts`

#### ui-ux/
- [x] select and delete a flow → `actionsMainPage-shard-1.spec.ts`
- [x] serializes created_at/expires_at with UTC offset and no microseconds → `api-keys-timezone-display.spec.ts`
- [x] renders API key timestamps in the viewer's local timezone → `api-keys-timezone-display.spec.ts`
- [x] user can edit the text of an existing sticky note and the canvas reflects only the new text → `edit-sticky-note-text.spec.ts`
- [x] executing flow with network error shows error feedback → `execution-error-notification.spec.ts`
- [x] executing flow with server error shows error feedback → `execution-error-notification.spec.ts`
- [x] create a Generic global variable from Settings page → `global-variable-edit.spec.ts`
- [x] edit existing global variable by clicking its row → `global-variable-edit.spec.ts`
- [x] create a Generic type global variable → `global-variables-crud.spec.ts`
- [x] delete a global variable removes it from the list → `global-variables-crud.spec.ts`
- [x] Credential variable value is hidden from the variable list → `global-variables-crud.spec.ts`
- [x] User should be able to interact notifications tab → `notifications.spec.ts`
- [x] dark and light mode toggle correctly updates the body class → `settings-theme-toggle.spec.ts`

---

### 🔵 Phase 1 — Next Delivery

> Validate (`[-]`) and create (`[ ]`) in the modules below. See details in Part II.

| Module | Validate (`[-]`) | Create (`[ ]`) |
|--------|-----------------|---------------|
| `api/flows/` — REST API | 0 | 0 |
| `core-components/` — Component Config | 2 | 0 |
| `core-components/` — Core Components | 0 | 2 |
| `core-functionality/auth/` | 13 | 0 |
| `core-functionality/llm-agents/` | 3 | 5 |
| `core-functionality/model-provider/` | 0 | 0 |
| `core-functionality/playground/` | 0 | 1 |
| `mcp/client/` | 8 | 2 |
| `mcp/server/` | 5 | 2 |
| `ui-ux/` — Canvas | 36 | 0 |

---

### 🟡 Phase 2 — Next Delivery

> Remaining modules after Phase 1 completion. See details in Part II.

| Module | Validate (`[-]`) | Create (`[ ]`) |
|--------|-----------------|---------------|
| `core-functionality/observability-monitoring/` | 0 | 0 |
| `core-functionality/knowledge-ingestion/` | 0 | 0 |
| `flow-functionality/` | 0 | 0 |
| `core-functionality/project-management/` | 6 | 0 |
| `core-functionality/templates/` | 39 | 0 |
| `ui-ux/` — Settings | 3 | 0 |
