# Langflow — Regression Test Checklist

> **Repository:** `C:/QAx/langflow-playwright/langflow-e2e`
> **Tests:** `tests/tests-automations/regression/`
> **Config:** `playwright.config.ts`
> **Last updated:** 2026-05-18

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

- [ ] Configure an MCP
- [ ] Configure a Custom Component
- [ ] Delete a component
- [ ] Run a flow
- [ ] Pause a flow
- [ ] Send a chat input
- [ ] Verify the chat output

---

---

# PART II — TEST AUTOMATION COVERAGE

> Organized according to `tests/tests-automations/regression/`

---

## api/ — REST API

### api/flows/ — REST API

#### 1.1 Health Check
- [x] GET `/health_check` → status 200, db ok → `api-health-check.spec.ts`
- [-] GET `/api/v1/health` → returns uptime and version

#### 1.2 Flow CRUD via API
- [-] POST `/api/v1/flows/` → creates flow, returns ID
- [-] GET `/api/v1/flows/` → lists user flows
- [-] GET `/api/v1/flows/{id}` → returns flow by ID
- [-] PATCH `/api/v1/flows/{id}` → updates name/description
- [-] DELETE `/api/v1/flows/{id}` → removes flow, returns 200
- [-] GET `/api/v1/flows/{id}` after DELETE → should return 404

#### 1.3 Flow Execution via API
- [-] POST `/api/v1/run/{flow_id}` with `input_value` → returns response
- [-] POST with `tweaks` → parameters override flow configuration
- [-] POST with custom `session_id`
- [-] POST with `input_type: "chat"` and `output_type: "chat"`
- [x] POST with invalid API key → returns 401/403 → `api-invalid-key.spec.ts`
- [-] POST to non-existent flow → returns 404

#### 1.4 Components via API
- [-] GET `/api/v1/all` → lists all available components
- [-] POST `/api/v1/custom_component` → creates custom component

#### 1.5 Messages and Monitoring via API
- [-] GET `/api/v1/monitor/messages` → returns 200 with array
- [-] GET with session_id filter returns only messages from that session

#### 1.6 Integration Code Generation
- [x] Generate curl for API execution → `flow-functionality/curlApiGeneration.spec.ts`
- [x] Generate Python code for integration → `flow-functionality/pythonApiGeneration.spec.ts`
- [-] API access modal

---

## core-components/ — Component Configuration + Core Components

### 2. Component Configuration

#### 2.1 Parameters Panel
- [-] Open component advanced options
- [-] Edit text field (input)
- [-] Edit dropdown
- [-] Edit text area (textarea)
- [-] Edit code field
- [-] Edit float field
- [-] Edit int field
- [-] Edit toggle field
- [-] Edit key-pair list
- [-] Edit input list
- [-] Edit table input
- [-] Edit slider
- [-] Edit tab component

#### 2.2 Tool Mode
- [x] Enable Tool Mode on a component
- [-] Group components in Tool Mode
- [-] Edit tools (edit-tools)

#### 2.3 Component Updates
- [-] Outdated component notification
- [-] Update component action
- [ ] Update with breaking change — should alert user
- [ ] Legacy component visible via configuration

#### 2.4 Code Editing
- [-] Edit Python code of custom component
- [-] Full custom component

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
- [ ] Body table key + value entries (body field is `advanced=True`)
- [ ] Flow state persisted in database after autosave

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

#### 3.5 Agent (Component)
- [-] Agent component displayed on canvas with default settings
- [ ] Configure system prompt in Agent component → `agent-system-prompt.spec.ts`
- [ ] Configure model provider directly in Agent component → `agent-provider-field-isolation.spec.ts`

#### 3.6 Loop Component
- [x] Loop component renders on canvas with title and run button → `core-components/loop-component-regression.spec.ts`
- [x] Correct handles: inputs-left, item-left, item-right, done-right → `core-components/loop-component-regression.spec.ts`
- [x] Output inspection buttons present for item and done → `core-components/loop-component-regression.spec.ts`
- [x] Run without connections shows "Flow build failed" notification without crash → `core-components/loop-component-regression.spec.ts`
- [x] Loop iterates over 2 ArXiv articles (Research Translation Loop template) and aggregates response in Playground → `core-components/loop-component-regression.spec.ts`
- [x] Loop stops when exit condition is met → `core-components/loop-component-regression.spec.ts`

#### 3.7 Nested / Grouping
- [-] Nested component
- [-] Enter and exit grouped component

---

## core-functionality/ — Core and Operational Logic

### core-functionality/auth/ — Authentication and User Management

#### 4.1 Login / Logout
- [-] Login with valid credentials
- [-] Login with invalid credentials — should display error message
- [-] Logout — should redirect to login screen
- [-] Auto-login enabled — should skip login screen
- [-] Auto-login disabled — should display login screen
- [-] Expired session — should redirect to login
- [-] Session cleanup after logout

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
- [ ] Use global variable in component (API key)
- [-] Edit existing global variable
- [x] Delete global variable
- [x] Create global variable of type "Generic"
- [x] Credential variable value is hidden from the variable list

---

### core-functionality/knowledge-ingestion-management/ — Upload, Processing and Vectors

#### 5.1 File Upload
- [-] Upload file via component
- [-] Upload files of different types (txt, pdf, json, py, wav)
- [-] File size limit
- [-] File management page

#### 5.2 Processing and Vectorization
- [ ] Document ingestion via Split Text + Embeddings component
- [ ] Indexing in Vector Store — document available for query
- [ ] Vector Store query returns relevant chunks for the prompt
- [ ] Complete RAG pipeline (ingest → embed → store → retrieve → answer)

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
- [ ] Agent stops when maximum number of iterations is reached → `agent-max-iterations.spec.ts`
- [ ] Agent with multiple configured tools executes correctly → `agent-multi-tool-selection.spec.ts`
- [ ] Agent with configured timeout respects the limit
- [ ] Switch provider in Agent → previous provider fields do not persist → `agent-provider-field-isolation.spec.ts`
- [ ] Flow with Agent saved and reopened → settings preserved → `agent-config-persistence.spec.ts`
- [ ] max_tokens truncates response as configured → `agent-max-tokens.spec.ts`
- [ ] reasoning_effort field appears/disappears based on selected model → `agent-reasoning-effort.spec.ts`

#### 6.3 Memory and Context
- [x] Memory Chatbot template loads with correct node and edge structure → `llm-agents/memory-history-regression.spec.ts`
- [x] Message History retains context between messages in the same Playground session → `llm-agents/memory-history-regression.spec.ts`
- [x] Session isolation: distinct session IDs have independent histories → `llm-agents/memory-history-regression.spec.ts`
- [x] Without Message History, LLM does not retain context between messages → `llm-agents/memory-history-regression.spec.ts`
- [ ] n_messages parameter limits the number of retained messages → `agent-n-messages-limit.spec.ts` (**confirmed bug**: value saved correctly by frontend but ignored in backend execution)
- [ ] Agent uses custom `context_id` — continuity between session messages → `agent-context-id-continuity.spec.ts`
- [ ] Switching `context_id` isolates history between distinct sessions → `agent-context-id-isolation.spec.ts`

#### 6.4 Tools and Integrations
- [ ] Agent with integrated external MCP tool executes action and returns result
- [ ] Agent executes multiple tools in sequence
- [ ] Tool returns error — agent handles it and continues execution → `agent-tool-error-handling.spec.ts`
- [ ] Multiple connected tools — agent selects the correct one for each prompt → `agent-multi-tool-selection.spec.ts`
- [ ] Tool with invalid name — validation prevents execution with clear message → `agent-tool-name-validation.spec.ts`

#### 6.5 Output and Reasoning
- [ ] Inspect tools used by Agent in Playground
- [ ] Agent returns output in structured JSON format (output_schema) → `agent-structured-output.spec.ts`
- [ ] Agent returns output in correctly rendered Markdown
- [ ] Agent Instructions (system prompt) is respected in the model response → `agent-system-prompt.spec.ts`
- [ ] Input via direct field vs handle (ChatInput) — both work → `agent-input-sources.spec.ts`
- [ ] Empty response or model refusal — component does not crash → `agent-empty-refusal-response.spec.ts`
- [ ] Toggle add_current_date_tool works (enables/disables date tool) → `agent-current-date-tool.spec.ts`
- [ ] handle_parsing_errors=False fails explicitly vs True auto-corrects → `agent-parse-error-behavior.spec.ts`
- [ ] Image passed via input handle is processed correctly → `agent-multimodal-image-input.spec.ts`

---

### core-functionality/model-provider/ — Provider Management

> ⚠️ Provider configuration tests via Settings use `SettingsPage`.
> See `helpers/provider-setup/` for the setup helpers of each provider.

#### 7.1 Provider Collection and Validation
- [-] Validate API keys of all providers via real call → `collect-models.spec.ts`
- [-] Collect available models per provider via UI → `collect-models.spec.ts`
- [x] Inactive providers appear as skipped in tests with reason → `agent-component-regression.spec.ts`
- [-] Configure provider API key via Save Configuration (first setup) → `collect-models.spec.ts`
- [-] Replace provider API key via Replace Configuration (existing key) → `collect-models.spec.ts`

#### 7.2 OpenAI
- [-] Configure OpenAI API key via GlobalVariables
- [-] Select GPT model in agent
- [-] Execute flow with OpenAI
- [x] Invalid API key error — display error message → `core-functionality/llm-agents/provider-invalid-auth-error.spec.ts`

#### 7.3 Anthropic
- [-] Configure Anthropic API key
- [-] Select Claude model in agent
- [-] Switch between Claude models (Sonnet, Haiku, Opus)
- [x] Invalid Anthropic API key error → `core-functionality/llm-agents/provider-invalid-auth-error.spec.ts`

#### 7.4 Google Generative AI
- [-] Configure Google API key in agent
- [-] Select Gemini model in agent
- [x] Invalid Google API key error → `core-functionality/llm-agents/provider-invalid-auth-error.spec.ts`

#### 7.5 Provider Management
- [-] "Manage Model Providers" modal
- [-] Available provider count
- [-] Language Model component — configuration
- [-] Model Input component
- [-] Add new provider via modal
- [-] Remove API key from existing provider

#### 7.6 Open-Source Providers
- [ ] Configure and execute flow with Ollama (local model)
- [ ] Configure and execute flow with Groq
- [ ] Configure and execute flow with Mistral

#### 7.7 Model Parameters (Agent)
- [ ] Temperature parameter (verify via network payload) → `agent-max-tokens.spec.ts`
- [ ] Reasoning effort parameter — conditional field based on model → `agent-reasoning-effort.spec.ts`
- [ ] Maximum token count — response truncated as configured → `agent-max-tokens.spec.ts`
- [ ] Maximum agent iterations → `agent-max-iterations.spec.ts`
- [ ] Use of custom `context_id` for memory isolation → `agent-context-id-isolation.spec.ts`
- [ ] Output formatting (JSON via output_schema, Markdown, plain text) → `agent-structured-output.spec.ts`

---

### core-functionality/observability-monitoring/ — Tracing, Logs and Metrics

#### 8.1 Traces
- [-] View execution traces
- [-] Trace API returns paginated transactions
- [-] Trace displays latency of each component
- [-] Trace displays tokens consumed

#### 8.2 Notifications
- [-] System notifications
- [-] Execution error notification
- [-] Outdated component notification

#### 8.3 User State
- [-] Track user progress
- [-] User flow state cleanup

#### 8.4 Error Handling and Edge Cases
- [-] Component that raises Python error
- [ ] Flow with error displays appropriate message
- [-] Network error during execution
- [-] Execution timeout — clear message to user

---

### core-functionality/playground/ — Chat, Rendering and Output Tests

#### 9.1 Chat Interactions
- [x] Open Playground → exercised by every `@stable` playground spec via `playground-btn-flow-io`
- [x] Send text message → exercised by `playground-ux.spec.ts`, `playground-message-edit.spec.ts`, `playground-session-nav.spec.ts` and others
- [x] Receive LLM response → exercised by all specs that send a message via ChatInput → ChatOutput echo flow
- [-] Response streaming (SSE) → no dedicated spec; exercised implicitly by `playground-ux.spec.ts`
- [-] Response polling → no dedicated spec
- [-] Direct response → no dedicated spec
- [x] Playground UX (playground-ux) → `playground/playground-ux.spec.ts`
- [x] Send empty message — send button stays enabled by design (only disabled while a file upload is in progress) → `playground/playground-empty-message-send.spec.ts`
- [ ] Send message while response is in progress — should wait or queue
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
- [-] Create new folder
- [-] Rename folder
- [-] Delete empty folder
- [-] Delete folder with flows inside
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
- [-] Create blank flow
- [-] Create flow from template
- [x] Create flow by duplicating an existing one → `flow-functionality/duplicate-flow.spec.ts`
- [-] Create flow via JSON file import

#### 12.2 View and Edit Flow
- [x] Rename flow via editor header → `flow-functionality/flow-rename-header.spec.ts`
- [-] Edit flow name and description
- [-] Flow auto-save on changes
- [-] Flow settings

#### 12.3 Delete Flow
- [-] Delete individual flow
- [-] Delete multiple flows (bulk actions)
- [-] Confirm deleted flow does not appear in listing

#### 12.4 Export / Import Flow
- [-] Export flow as JSON
- [-] Import flow via JSON file upload
- [~] Import flow with outdated components
- [-] Import invalid JSON — should display error message

#### 12.5 Flow Operations
- [-] Lock flow — prevents editing
- [-] Unlock flow
- [-] Move flow between folders via API
- [x] Publish flow → `flow-functionality/publish-flow.spec.ts`
- [-] Save flow components as template

#### 12.6 Flow Execution
- [-] Execute flow via Run button → `core/features/run-flow.spec.ts`
- [-] Stop building flow → `core/features/stop-building.spec.ts`
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
- [-] Agent uses MCPTools as tool and calls echo via MCP → `mcp/client/mcp-client-agent.spec.ts`
- [ ] List available resources via MCP protocol
- [ ] Consume resource URI and inject content into flow

---

### mcp/server/ — Resource and Tool Provider

#### 14.1 MCP Server
- [-] MCP Server tab in flow
- [-] Add MCP server via modal
- [-] Starter project with MCP
- [ ] Flow exposed as MCP server — verify generated endpoint
- [ ] Execute MCP server tool via MCP protocol
- [ ] Resource exposed by server is accessible via URI
- [ ] Prompt exposed by server returns correct template

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
- [-] Hover + click "+" button adds component to canvas
- [-] Added component appears with default settings

#### 15.3 Component Connections
- [-] Connect two compatible components
- [-] Prevent connection between incompatible types
- [-] Delete edge/connection
- [-] Filter edges by data type
- [-] Reconnect existing edge

#### 15.4 Node Manipulation
- [-] Delete component from canvas
- [x] Copy and paste ChatOutput component (Ctrl+C / Ctrl+V) → `flow-functionality/canvas-copy-paste.spec.ts`
- [x] Copy and paste Prompt Template (component with dynamic ports) (Ctrl+C / Ctrl+V) → `flow-functionality/canvas-copy-paste.spec.ts`
- [-] Canvas keyboard shortcuts
- [-] Minimize component on canvas
- [-] Move component within canvas
- [-] Select multiple components via box selection
- [-] Delete multiple selected components
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
- [ ] Edit sticky note text
- [-] Change sticky note color
- [-] Resize sticky note
- [-] Delete sticky note

#### 15.9 Right-Click and Menus
- [-] Context menu via right-click on canvas
- [-] Context menu via right-click on component
- [-] Main menu actions

#### 15.10 Settings and UI Configuration
- [-] Access Settings page
- [-] Message history settings
- [x] Change appearance/theme settings — dark/light toggle updates #body.dark class → `ui-ux/settings-theme-toggle.spec.ts`
- [-] Keyboard shortcuts work in editor
- [~] All documented shortcuts work

---

## Coverage Summary — Test Automation Coverage

> **Validated** = test carries the `@stable` tag.
> **Needs validation** = automated but not yet `@stable` (bug, flake under investigation, or pending team review).

| Module | Total | Validated `[x]` | Needs validation `[-]` | Partial `[~]`/`[!]` | Not automated `[ ]` |
|--------|-------|-----------------|------------------------|---------------------|---------------------|
| `api/flows/` — REST API | 21 | 4 | 17 | 0 | 0 |
| `core-components/` — Component Config | 22 | 1 | 19 | 0 | 2 |
| `core-components/` — Core Components | 67 | 59 | 3 | 1 | 4 |
| `core-functionality/auth/` | 19 | 0 | 18 | 0 | 1 |
| `core-functionality/knowledge-ingestion/` | 8 | 0 | 4 | 0 | 4 |
| `core-functionality/llm-agents/` | 40 | 13 | 2 | 0 | 25 |
| `core-functionality/model-provider/` | 31 | 4 | 18 | 0 | 9 |
| `core-functionality/observability-monitoring/` | 13 | 0 | 12 | 0 | 1 |
| `core-functionality/playground/` | 48 | 43 | 3 | 1 | 1 |
| `core-functionality/project-management/` | 11 | 0 | 10 | 1 | 0 |
| `core-functionality/templates/` | 41 | 2 | 39 | 0 | 0 |
| `flow-functionality/` | 23 | 3 | 18 | 2 | 0 |
| `mcp/client/` | 9 | 0 | 7 | 0 | 2 |
| `mcp/server/` | 7 | 0 | 3 | 0 | 4 |
| `ui-ux/` — Canvas | 43 | 2 | 39 | 1 | 1 |
| `ui-ux/` — Settings | 5 | 1 | 3 | 1 | 0 |
| **TOTAL** | **408** | **132 (32%)** | **215 (53%)** | **7 (2%)** | **54 (13%)** |

> Note: `Validated [x]` counts checklist bullets, not `test()` calls. The
> `@stable` tag is per-`test()`, and a single `@stable` test may map to
> several bullets via `test.step()` (e.g. the agent suite covers 7
> bullets). The canonical list of `@stable` `test()` calls is in
> **Phase 0 — Validated** below.

---

## Implementation Roadmap

---

### 🟢 Phase 0 — Validated

> 132 `test()` calls carrying the `@stable` tag, distributed across 45 spec
> files. Run weekly by the stable workflow. New specs are merged with all
> tests tagged `@stable`; the tag is removed per-test during weekly triage
> when a failure is classified as a test bug — so a spec may end up with a
> mix of tagged and untagged tests over time.

#### api/flows/
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

#### core-components/
- [x] API Request component — renders on canvas with correct output and URL handles → `api-request-component-regression.spec.ts`
- [x] API Request component — inspector fields accept configured values → `api-request-component-regression.spec.ts`
- [x] API Request component — invalid URL is accepted by field and run shows error notification → `api-request-component-regression.spec.ts`
- [x] API Request component — GET request returns 200 and output Data contains all required fields → `api-request-component-regression.spec.ts`
- [x] API Request component — POST method executes POST verb and returns 200 → `api-request-component-regression.spec.ts`
- [x] API Request component — PUT method executes PUT verb and returns 200 → `api-request-component-regression.spec.ts`
- [x] API Request component — PATCH method executes PATCH verb and returns 200 → `api-request-component-regression.spec.ts`
- [x] API Request component — DELETE method executes DELETE verb and returns 200 → `api-request-component-regression.spec.ts`
- [x] API Request component — non-2xx HTTP response propagates status_code without crashing → `api-request-component-regression.spec.ts`
- [x] API Request component — query parameters embedded in URL are sent and echoed → `api-request-component-regression.spec.ts`
- [x] API Request component — inspector headers table accepts key + value cell entries → `api-request-component-regression.spec.ts`
- [x] API Request component — cURL tab switches mode and field accepts a cURL command → `api-request-component-regression.spec.ts`
- [x] API Request component — cURL mode parses command, auto-fills URL, executes GET and returns 200 → `api-request-component-regression.spec.ts`
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
- [x] Loop component — renders correctly with all handles and output inspection buttons → `loop-component-regression.spec.ts`
- [x] Loop component — run without connections shows build failed notification → `loop-component-regression.spec.ts`
- [x] Loop component — Research Translation Loop template: full wiring and iterates over 2 ArXiv papers → `loop-component-regression.spec.ts`
- [x] Loop component — stops after exhausting input DataFrame and emits aggregated done → `loop-component-regression.spec.ts`
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
- [x] User should be able to use components as tool → `tool-mode.spec.ts`
- [x] Webhook component — cURL command in inspector shows valid POST URL with flow ID → `webhook-component-regression.spec.ts`
- [x] Webhook component — empty data field returns empty Data object → `webhook-component-regression.spec.ts`
- [x] Webhook component — endpoint field renders the actual webhook URL → `webhook-component-regression.spec.ts`
- [x] Webhook component — copy button copies the endpoint URL to clipboard → `webhook-component-regression.spec.ts`
- [x] Webhook component — POST to non-existent flow name returns 404 → `webhook-component-regression.spec.ts`
- [x] Webhook component — valid JSON payload is propagated as structured Data output → `webhook-component-regression.spec.ts`
- [x] Webhook component — invalid JSON payload is encapsulated in {payload: ...} → `webhook-component-regression.spec.ts`
- [x] GET /api/v1/monitor/messages returns 200 with array response → `webhook-component-regression.spec.ts`

#### core-functionality/llm-agents/
- [x] agent interaction suite → `agent-component-regression.spec.ts`
- [x] agent stop button must halt execution mid-run → `agent-component-regression.spec.ts`
- [x] playground shows error when LLM run endpoint returns 500 (mocked invalid API key) → `llm-invalid-api-key-ui.spec.ts`
- [x] playground input remains usable after API error (mocked) → `llm-invalid-api-key-ui.spec.ts`
- [x] memory chatbot template loads with correct node structure → `memory-history-regression.spec.ts`
- [x] message history context retention suite → `memory-history-regression.spec.ts`
- [x] session isolation: new session has no context from previous session → `memory-history-regression.spec.ts`
- [x] should display error message when using invalid authentication for provider <provider> → `provider-invalid-auth-error.spec.ts`

#### core-functionality/playground/
- [x] copy button copies Text Input output and toggles Check icon → `output-modal-copy-button.spec.ts`
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
- [x] creating a new session re-applies the Input Text pre-fill → `playground-input-text-prefill.spec.ts`
- [x] pre-filled value is sent as the first message of the session → `playground-input-text-prefill.spec.ts`
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
- [x] clear-chat removes all messages from Default Session → `playground-session-clear.spec.ts`
- [x] session ID input accepts a custom value → `playground-session-id.spec.ts`
- [x] new-chat button must add a new session entry to the sidebar → `playground-session-nav.spec.ts`
- [x] session selector sidebar must switch to the selected session → `playground-session-nav.spec.ts`
- [x] rename option must not be available for the Default Session → `playground-session-rename.spec.ts`
- [x] rename option must not be available for a session with no messages → `playground-session-rename.spec.ts`
- [x] rename option must be available and functional for a session with messages → `playground-session-rename.spec.ts`
- [x] Shareable playground URL is generated when publishing is enabled → `playground-shareable-url.spec.ts`
- [x] user message must appear instantly in playground before AI responds → `playground-ux.spec.ts`
- [x] playground must scroll to latest message after sending → `playground-ux.spec.ts`
- [x] playground input field must be ready after flow responds → `playground-ux.spec.ts`
- [x] User must be able to stop building from inside Playground → `stop-button-playground.spec.ts`

#### flow-functionality/
- [x] copy and paste ChatOutput component via Ctrl+C / Ctrl+V → `canvas-copy-paste.spec.ts`
- [x] copy and paste Prompt Template (component with dynamic ports) via Ctrl+C / Ctrl+V → `canvas-copy-paste.spec.ts`
- [x] user can copy a valid macOS/Linux curl command from the API access modal → `curlApiGeneration.spec.ts`
- [x] user can duplicate a flow from the home page dropdown menu → `duplicate-flow.spec.ts`
- [x] duplicate flow via API auto-suffixes the name on collision → `duplicate-flow.spec.ts`
- [x] flow can be renamed via the header edit → `flow-rename-header.spec.ts`
- [x] flow name persists after rename via API PATCH and GET → `flow-rename-header.spec.ts`
- [x] user can publish a flow and access it via shareable URL, then unpublish to revoke access → `publish-flow.spec.ts`
- [x] publish flow via API toggles access_type between PUBLIC and PRIVATE → `publish-flow.spec.ts`
- [x] user can copy a valid Python requests snippet from the API access modal → `pythonApiGeneration.spec.ts`

#### mcp/client/
- [x] agent calls echo MCP tool and returns echoed message → `mcp-client-agent.spec.ts`
- [x] unreachable HTTP server results in empty tool dropdown → `mcp-client-regression.spec.ts`
- [x] configures MCP server via HTTP form tab and verifies registration → `mcp-client-regression.spec.ts`
- [x] selects get-sum tool, provides numeric inputs, and verifies sum in output → `mcp-client-regression.spec.ts`

#### ui-ux/
- [x] dark and light mode toggle correctly updates the body class → `settings-theme-toggle.spec.ts`

---

### 🔵 Phase 1 — Next Delivery

> Validate (`[-]`) and create (`[ ]`) in the modules below. See details in Part II.

| Module | Validate (`[-]`) | Create (`[ ]`) |
|--------|-----------------|---------------|
| `api/flows/` — REST API | 17 | 0 |
| `core-components/` — Component Config | 19 | 2 |
| `core-components/` — Core Components | 3 | 4 |
| `core-functionality/auth/` | 18 | 1 |
| `core-functionality/llm-agents/` | 2 | 25 |
| `core-functionality/model-provider/` | 18 | 9 |
| `core-functionality/playground/` | 3 | 1 |
| `mcp/client/` | 7 | 2 |
| `mcp/server/` | 3 | 4 |
| `ui-ux/` — Canvas | 39 | 1 |

---

### 🟡 Phase 2 — Next Delivery

> Remaining modules after Phase 1 completion. See details in Part II.

| Module | Validate (`[-]`) | Create (`[ ]`) |
|--------|-----------------|---------------|
| `core-functionality/observability-monitoring/` | 12 | 1 |
| `core-functionality/knowledge-ingestion/` | 4 | 4 |
| `flow-functionality/` | 18 | 0 |
| `core-functionality/project-management/` | 10 | 0 |
| `core-functionality/templates/` | 39 | 0 |
| `ui-ux/` — Settings | 3 | 0 |
