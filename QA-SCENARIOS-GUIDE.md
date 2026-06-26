# Langflow — Test Scenario Guide (Step by Step)

> Generated from `QA-CHECKLIST.md` to facilitate understanding and manual validation of tests.
>
> **Status legend:**
> - `[-]` → automated, needs validation
> - `[x]` → automated and validated
> - `[ ]` → needs to be created
> - `[~]` → partially covered
> - `[!]` → flaky / unstable

---

## Index

1. [REST API — Health Check](#1-rest-api--health-check)
2. [REST API — Flow CRUD](#2-rest-api--flow-crud)
3. [REST API — Flow Execution](#3-rest-api--flow-execution)
4. [REST API — Components and Messages](#4-rest-api--components-and-messages)
5. [REST API — Integration Code Generation](#5-rest-api--integration-code-generation)
6. [Component Configuration — Parameters Panel](#6-component-configuration--parameters-panel)
7. [Tool Mode](#7-tool-mode)
8. [Component Updates](#8-component-updates)
9. [Core Components — Chat Input/Output](#9-core-components--chat-inputoutput)
10. [Core Components — Prompt Template](#10-core-components--prompt-template)
11. [Core Components — API Request](#11-core-components--api-request)
12. [Core Components — Webhook](#12-core-components--webhook)
13. [Core Components — Agent](#13-core-components--agent) *(13.1–13.13 — includes new provider, memory, tools and output scenarios)*
14. [Authentication — Login and Logout](#14-authentication--login-and-logout)
15. [User Management (Admin)](#15-user-management-admin)
16. [Global Variables (API Keys)](#16-global-variables-api-keys)
17. [File Upload and Processing](#17-file-upload-and-processing)
18. [LLM Agents — Execution and Control](#18-llm-agents--execution-and-control) *(18.1–18.17 — includes context_id, multi-tool, tool error)*
19. [Model Providers](#19-model-providers)
20. [Observability — Traces and Notifications](#20-observability--traces-and-notifications)
21. [Playground — Chat and Session](#21-playground--chat-and-session)
22. [Project and Folder Management](#22-project-and-folder-management)
23. [Templates and Starter Projects](#23-templates-and-starter-projects)
24. [Flow — CRUD and Operations](#24-flow--crud-and-operations)
25. [MCP — Client and Server](#25-mcp--client-and-server)
26. [UI/UX — Sidebar and Canvas](#26-uiux--sidebar-and-canvas)
27. [Core Components — Loop](#27-core-components--loop)
28. [API Keys — Timestamps & Expiry](#28-api-keys--timestamps--expiry)

---

---

## 1. REST API — Health Check

**File:** `core/features/api-health-check.spec.ts`

---

### 1.1.a GET `/health_check` → status 200 `[-]`

**Objective:** Confirm that the Langflow server is online and healthy.

**Precondition:** Langflow running at `http://localhost:7860`.

**Step by step:**
1. Make a `GET /health_check` request without authentication.
2. Verify that the returned HTTP status is `200`.
3. Verify that the response body contains `{ status: "ok", db: "ok" }`.

**Validation:** Server responded with `200` and database is accessible.

---

### 1.1.b GET `/api/v1/version` → returns version, main_version, package `[x]`

**Objective:** Verify that the version endpoint returns instance metadata.

**Step by step:**
1. Make a `GET /api/v1/version` request without authentication.
2. Verify that the status is `200`.
3. Verify that the body contains `version`, `main_version` and `package` fields.
4. Make a `POST /api/v1/version` request; verify that the status is `405`.

**Validation:** Version information is present; `package` is `Langflow`. `POST` is rejected with `405`.

---

---

## 2. REST API — Flow CRUD

**File:** `core/features/api-flows-crud.spec.ts`

---

### 2.1 POST `/api/v1/flows/` → creates flow, returns ID `[-]`

**Objective:** Verify that a flow can be created via API.

**Precondition:** Authentication token obtained via `/api/v1/auto_login`.

**Step by step:**
1. Get Bearer token via `GET /api/v1/auto_login`.
2. Make `POST /api/v1/flows/` with body `{ name, description, data: { nodes: [], edges: [] }, is_component: false }`.
3. Verify that the returned status is `201 Created`.
4. Verify that the response body contains an `id` field (UUID).

**Validation:** Flow created with unique ID returned.

---

### 2.2 GET `/api/v1/flows/` → lists user flows `[-]`

**Objective:** Confirm that the flow listing returns the authenticated user's flows.

**Step by step:**
1. Create at least one flow via POST (setup).
2. Make `GET /api/v1/flows/` with header `Authorization: Bearer <token>`.
3. Verify that the status is `200`.
4. Verify that the returned array contains the created flow (by ID or name).

**Validation:** List includes the created flow and does not include other users' flows.

---

### 2.3 GET `/api/v1/flows/{id}` → returns flow by ID `[-]`

**Objective:** Confirm that a specific flow is returned correctly by its ID.

**Step by step:**
1. Create flow and save the returned `id`.
2. Make `GET /api/v1/flows/{id}` with Bearer header.
3. Verify that the status is `200`.
4. Verify that the `id` field in the response equals the requested ID.

**Validation:** Returned flow corresponds to the queried ID.

---

### 2.4 PATCH `/api/v1/flows/{id}` → updates name/description `[-]`

**Objective:** Verify that flow fields can be updated via API.

**Step by step:**
1. Create flow and save the `id`.
2. Make `PATCH /api/v1/flows/{id}` with body `{ name: "New Name" }`.
3. Verify that the status is `200`.
4. Make `GET /api/v1/flows/{id}` and confirm that the `name` was updated.

**Validation:** Name/description reflect the values sent in the PATCH.

---

### 2.5 DELETE `/api/v1/flows/{id}` → removes flow, returns 200 `[-]`

**Objective:** Confirm that a flow can be deleted via API.

**Step by step:**
1. Create flow and save the `id`.
2. Make `DELETE /api/v1/flows/{id}` with Bearer header.
3. Verify that the status is `200`.

**Validation:** Deletion confirmed with status 200.

---

### 2.6 GET after DELETE → should return 404 `[-]`

**Objective:** Ensure that a deleted flow is no longer accessible.

**Step by step:**
1. Delete a flow by ID.
2. Make `GET /api/v1/flows/{id}` with the same deleted ID.
3. Verify that the returned status is `404 Not Found`.

**Validation:** Attempt to access a deleted flow results in 404.

---

---

## 3. REST API — Flow Execution

**Files:** `core/features/api-run-flow.spec.ts`, `api-run-with-tweaks.spec.ts`

---

### 3.1 POST `/api/v1/run/{flow_id}` with `input_value` `[-]`

**Objective:** Execute a flow via API and receive a response.

**Precondition:** Flow created and API key generated via `/api/v1/api_key/`.

**Step by step:**
1. Get Bearer token via auto_login.
2. Create API key via `POST /api/v1/api_key/` → save `api_key` and `id`.
3. Create test flow.
4. Make `POST /api/v1/run/{flow_id}` with header `x-api-key: <key>` and body `{ input_value: "Hello", input_type: "chat", output_type: "chat" }`.
5. Verify that the status is `200`.
6. Verify that the body contains `outputs`.

**Validation:** Flow executed with structured response in `outputs`.

---

### 3.2 POST with `tweaks` → parameters override configuration `[-]`

**Objective:** Verify that tweaks override parameters configured in the flow.

**Step by step:**
1. Create flow with a configured component.
2. Make `POST /api/v1/run/{flow_id}` including field `tweaks: { "ComponentName": { "parameter": "value" } }`.
3. Verify that the execution uses the tweak value (not the original from the flow).

**Validation:** The parameter overridden by tweak is used in the execution.

---

### 3.3 POST with custom `session_id` `[-]`

**Objective:** Ensure that custom sessions isolate conversation history.

**Step by step:**
1. Execute flow with `session_id: "session-abc"` in the body.
2. Verify that the `session_id` returned in the response matches the one sent.
3. Execute again with `session_id: "session-xyz"` and verify it is an independent session.

**Validation:** Each session_id maintains isolated history.

---

### 3.4 POST with invalid API key → returns 401/403 `[-]`

**Objective:** Confirm that the API protects execution with authentication.

**Step by step:**
1. Make `POST /api/v1/run/{flow_id}` with header `x-api-key: invalid-key`.
2. Verify that the returned status is `401` or `403`.

**Validation:** Access denied with invalid credential.

---

### 3.5 POST to non-existent flow → returns 404 `[-]`

**Objective:** Confirm behavior when flow does not exist.

**Step by step:**
1. Make `POST /api/v1/run/00000000-0000-0000-0000-000000000000` with valid API key.
2. Verify that the status is `404`.

**Validation:** Endpoint returns 404 for non-existent flow.

---

---

## 4. REST API — Components and Messages

---

### 4.1 GET `/api/v1/all` → lists available components `[-]`

**Objective:** Verify that the component catalog is accessible.

**Step by step:**
1. Make `GET /api/v1/all` with Bearer header.
2. Verify that the status is `200`.
3. Verify that the body is an object with multiple keys (component names).

**Validation:** Catalog returns all registered components.

---

### 4.2 GET `/api/v1/monitor/messages` → returns array `[-]`

**Objective:** Verify that the message history of a flow is accessible via API.

**Precondition:** Flow executed at least once to generate messages.

**Step by step:**
1. Execute flow and save the `flow_id` (UUID).
2. Make `GET /api/v1/monitor/messages?flow_id={uuid}` with Bearer.
3. Verify that the status is `200`.
4. Verify that the body is an array.

**Validation:** Endpoint returns `200` and array of messages.

> ⚠️ `flow_id` must be a valid UUID — arbitrary strings return `422`.

---

### 4.3 GET with session_id filter `[-]`

**Objective:** Verify that messages can be filtered by session.

**Step by step:**
1. Execute flow with `session_id: "test-session"`.
2. Make `GET /api/v1/monitor/messages?flow_id={uuid}&session_id=test-session`.
3. Verify that all returned messages belong to the filtered session.

**Validation:** session_id filter isolates messages from the correct session.

---

---

## 5. REST API — Integration Code Generation

---

### 5.1 Generate curl for execution `[x]`

**Objective:** Verify that Langflow generates a valid `curl` command for flow execution.

**Step by step:**
1. Open a flow in the editor.
2. Click the "API Access" button (api-access-button).
3. Select the `cURL` tab.
4. Verify that the generated code targets the correct flow URL and uses the `POST` HTTP method (the actual `curl` invocation may use either `-X POST` or `--request POST` depending on Langflow's snippet generator).

**Validation:** Generated curl code points to the correct flow endpoint.

---

### 5.2 Generate Python code for integration `[x]`

**Objective:** Verify that Langflow generates functional Python code to call the flow.

**Step by step:**
1. Open a flow in the editor.
2. Click the "API Access" button.
3. Select the `Python` tab.
4. Verify that the code contains `import requests` and the flow URL.

**Validation:** Generated Python code contains the correct execution parameters.

---

---

## 6. Component Configuration — Parameters Panel

**Files:** `core/unit/inputComponent.spec.ts`, `dropdownComponent.spec.ts`, etc.

---

### 6.1 Open component advanced options `[-]`

**Objective:** Verify that the advanced parameters panel can be opened.

**Step by step:**
1. Add any component to the canvas.
2. Click "Advanced" or the component settings icon.
3. Verify that the advanced options panel expands showing additional fields.

**Validation:** Advanced options panel visible with configurable fields.

---

### 6.2 Edit text field (input) `[-]`

**Step by step:**
1. Add component with a text field (e.g.: Chat Input).
2. Click on the text field of the component.
3. Type a value (e.g.: "my text").
4. Verify that the value was saved in the field.

**Validation:** Text field displays the typed value.

---

### 6.3 Edit dropdown `[-]`

**Step by step:**
1. Add component with dropdown (e.g.: OpenAI with model selection).
2. Click the dropdown.
3. Select a different option from the default.
4. Verify that the selected option is visible in the dropdown.

**Validation:** Dropdown reflects the selected option.

---

### 6.4 Edit toggle `[-]`

**Step by step:**
1. Add component with toggle (e.g.: "Stream" option).
2. Check the initial state of the toggle (on/off).
3. Click the toggle to invert the state.
4. Verify that the toggle changed state.

**Validation:** Toggle correctly alternates between states.

---

### 6.5 Edit float / int field `[-]`

**Step by step:**
1. Locate a numeric field in a component (e.g.: Temperature = 0.7).
2. Click the field and change the value.
3. Press Enter or click elsewhere.
4. Verify that the value was updated.

**Validation:** Numeric field accepts and displays the new value.

---

### 6.6 Edit slider `[-]`

**Step by step:**
1. Locate a component with a slider (e.g.: temperature parameter in slider mode).
2. Drag the slider to the right or left.
3. Verify that the corresponding numeric value is updated.

**Validation:** Slider and numeric value are synchronized.

---

---

## 7. Tool Mode

**Files:** `extended/features/tool-mode.spec.ts`, `core/features/toolModeGroup.spec.ts`

---

### 7.1 Enable Tool Mode on a component `[-]`

**Objective:** Verify that a component can be enabled as a "Tool" for use by Agents.

**Step by step:**
1. Add component to canvas (e.g.: API Request).
2. Locate the "Tool Mode" toggle in the component.
3. Click to enable.
4. Verify that the component displays a visual indication of active Tool Mode.
5. Verify that the tool handle becomes available for connection with an Agent.

**Validation:** Component in Tool Mode displays tool handle and visual indication.

---

### 7.2 Group components in Tool Mode `[-]`

**Step by step:**
1. Add two or more components to the canvas in Tool Mode.
2. Select all components (Shift+drag).
3. Use the grouping option (context menu or shortcut).
4. Verify that the group maintains the Tool Mode settings.

**Validation:** Created group preserves the Tool Mode of internal components.

---

---

## 8. Component Updates

**Files:** `extended/features/outdated-message.spec.ts`, `outdated-actions.spec.ts`

---

### 8.1 Outdated component notification `[-]`

**Objective:** Ensure that Langflow alerts the user when a component is on an old version.

**Step by step:**
1. Import a flow JSON that contains an outdated component version.
2. Open the flow in the editor.
3. Verify that the component displays an "outdated" icon/badge or notification.
4. Verify that there is an option to update the component.

**Validation:** Outdated component badge visible with update action available.

---

### 8.2 Update component action `[-]`

**Step by step:**
1. Identify component with outdated badge.
2. Click the "Update" option of the component.
3. Verify that the outdated badge disappears.
4. Verify that the component maintains its settings after the update.

**Validation:** Component updated without loss of configuration.

---

---

## 9. Core Components — Chat Input/Output

**Files:** `core/unit/chatInputOutput.spec.ts`, `core/integrations/textInputOutput.spec.ts`

---

### 9.1 ChatInput receives user message `[-]`

**Objective:** Verify that the Chat Input component processes an input message.

**Step by step:**
1. Create flow with Chat Input component connected to Chat Output.
2. Open Playground (button `playground-btn-flow-io`).
3. Type a message in the `input-chat-playground` field.
4. Click the send button (`button-send`).
5. Verify that the user message appears in the chat history.

**Validation:** Sent message appears in the Playground interface.

---

### 9.2 ChatOutput displays LLM response `[-]`

**Step by step:**
1. Create flow: Chat Input → LLM (OpenAI/Anthropic) → Chat Output.
2. Configure API key in the LLM component.
3. Open Playground and send a message.
4. Wait for LLM response.
5. Verify that the response appears in the chat box (div with assistant message).

**Validation:** LLM response displayed in Playground after execution.

---

---

## 10. Core Components — Prompt Template

**Files:** `core-components/prompt-template-component-regression.spec.ts`

---

### 10.1 Prompt with variables in curly braces `[x]`

**Objective:** Verify that `{name}` variables in the prompt create dynamic handles.

**Step by step:**
1. Add Prompt Template component to canvas.
2. Click "Edit Prompt" (button `button_open_prompt_modal`).
3. In the modal text field, type: `Hello {name}, your role is {role}.`
4. Click "Save" (`genericModalBtnSave`).
5. Verify that two handles were created: `name` and `role` (left side of the component).

**Validation:** Handles `handle-prompt template-shownode-name-left` and `handle-prompt template-shownode-role-left` visible.

---

### 10.2 Removing variable from prompt deletes corresponding port `[x]`

**Step by step:**
1. Create prompt with variable `{name}` (handle `name` created).
2. Reopen the prompt modal and remove `{name}` from the text.
3. Save.
4. Verify that the `name` handle disappeared from the component.

**Validation:** Handle removed when variable is deleted from prompt.

---

---

## 11. Core Components — API Request

**Files:** `core-components/api-request-component-regression.spec.ts`

---

### 11.1 Renders on canvas with URL and API Response handles `[x]`

**Step by step:**
1. Add "API Request" component to canvas.
2. Verify the node title `title-API Request` is visible.
3. Verify both `handle-apirequest-shownode-api response-right` (output) and `handle-apirequest-shownode-url-left` (input) handles render.

**Validation:** Exactly one node on the canvas with both URL input and API Response output handles visible.

---

### 11.2 Inspector accepts URL and HTTP method values `[x]`

**Step by step:**
1. Add API Request component.
2. Fill `popover-anchor-input-url_input` with `https://httpbin.org/get` and confirm the value persists.
3. Open the method dropdown, select POST, and confirm the displayed value updates.

**Validation:** URL and method fields reflect the configured values; no validation errors.

---

### 11.3 Invalid URL is accepted by field but run shows error notification `[x]`

**Step by step:**
1. Call `allowFlowErrors()` (the run is expected to fail).
2. Add the component, fill `not-a-url` in the URL field.
3. Run the component.
4. Assert the toast `Error building Component API Request:` and the detail `Invalid URL provided:` are visible.

**Validation:** The component does not crash on an invalid URL; the toast surfaces the descriptive error and the run button remains usable.

---

### 11.4–11.8 Execute GET / POST / PUT / PATCH / DELETE returns 200 `[x]`

**Step by step (per verb):**
1. Add API Request component.
2. Fill the URL with `https://httpbin.org/<verb>` (each endpoint only accepts that verb — any other returns 405).
3. Select the matching method in the dropdown.
4. Run the component.
5. Open the output via `output-inspection-api response-apirequest`.
6. Assert the output Data contains `200`, the echoed URL, `status_code`, `response_headers`, and `result`.

**Validation:** Each verb correctly executes and returns 200 with the structural Data fields populated.

---

### 11.9 Non-2xx HTTP response (404) propagates as status_code without crashing `[x]`

**Step by step:**
1. Fill `https://httpbin.org/status/404`.
2. Run the component.
3. Assert the output Data contains `404`, the `source` key, and does **not** contain an `"error"` field.

**Validation:** A 404 response is propagated as `status_code: 404` (not surfaced as an exception). The `error` field appears only on httpx transport exceptions.

---

### 11.10 Query parameters embedded in URL are sent and echoed `[x]`

**Step by step:**
1. Fill `https://httpbin.org/get?e2e_param=functional_test_value`.
2. Run the component.
3. Assert the output contains the parameter key (`e2e_param`) and value (`functional_test_value`) and status `200`.

**Validation:** Query parameters in the URL are forwarded and echoed by httpbin.

---

### 11.11 Headers table accepts key + value cell entries via inspector `[x]`

**Step by step:**
1. Open the headers table via `div-table_headers` → `Open table` button.
2. Add a row, fill the `[col-id="key"]` cell with `X-E2E-Header` and the `[col-id="value"]` cell with `test-header-value` via the inline View Text editor.
3. Each `fillViewTextCell` call asserts the saved cell value renders as a button inside the table dialog.
4. Close with `btn-cancel-modal`; verify canvas integrity.

**Validation:** Both key and value cells accept text input through the View Text editor and render the saved value in-session.

---

### 11.12 cURL tab switches mode and field accepts a cURL command `[x]`

**Step by step:**
1. Switch to the cURL tab via `tab_1_curl`.
2. Fill `textarea_str_curl_input` with a valid cURL command (`curl -X GET ... -H 'Accept: application/json'`).
3. Assert the cURL handle `handle-apirequest-shownode-curl-left` is visible.

**Validation:** The cURL tab is reachable, the textarea accepts the command, and the cURL handle is exposed on the node.

---

### 11.13 cURL parser auto-fills URL field and executes the GET, returning 200 `[x]`

**Step by step:**
1. Switch to the cURL tab **before** touching `url_input` (pre-filling would mask a parser regression).
2. Fill the cURL command with the URL embedded.
3. Wait for `url_input` to be auto-populated by the parser (`waitForFunction` polls `document.getElementById('popover-anchor-input-url_input').value`).
4. Run the component and assert the output Data contains `200`, the echoed URL, `status_code`, and `result`.

**Validation:** The cURL parser extracts the URL from the command and feeds the run end-to-end.

---

---

## 12. Core Components — Webhook

**Files:** `core-components/webhook-component-regression.spec.ts`

---

### 12.1 Webhook component displayed on canvas `[-]`

**Step by step:**
1. Search "Webhook" in the sidebar.
2. Add to canvas via double-click or drag.
3. Verify that the component appears on the canvas with its default settings.

**Validation:** Webhook component visible on canvas with handles and default settings.

---

### 12.2 Webhook URL generated automatically `[-]`

**Step by step:**
1. Add Webhook component to canvas.
2. Verify that the webhook URL field is populated automatically.
3. Confirm that the URL contains the flow ID (format `/api/v1/webhook/{flow_id}`).

**Validation:** Webhook URL automatically generated with correct flow ID.

---

### 12.3 POST endpoint accepts JSON and plain-text bodies returning 202 `[x]`

**Objective:** Confirm that `POST /api/v1/webhook/{flowId}` accepts both `application/json` and `text/plain` bodies and returns `202` with `{status: "in progress", message: "Task started in the background"}`.

**Preconditions:**
- A blank flow with the Webhook component on the canvas (created via UI; autosave persists the flow).
- A temporary `x-api-key` is required because Langflow's `WEBHOOK_AUTH_ENABLE` defaults to `True` since 1.9.2+ (PR langflow-ai/langflow#12845).

**Step by step:**
1. Add the Webhook component to a blank flow via the sidebar.
2. Wait for autosave (4 s debounce) before any webhook POST.
3. Create a temporary API key via `POST /api/v1/api_key/`.
4. POST a JSON object with the `x-api-key` header to `/api/v1/webhook/{flowId}`.
5. POST a plain-text body with `x-api-key` and `Content-Type: text/plain` to the same endpoint.
6. Delete the temporary API key in `finally`.

**Validation:**
- JSON POST returns 202 with `status === "in progress"` and `message === "Task started in the background"`.
- Plain-text POST returns 202 with `status === "in progress"`.
- The temporary API key is deleted regardless of test outcome.

---

## 13. Core Components — Agent

**Files:** `agent-reasoning-steps.spec.ts`, `agent-system-prompt.spec.ts`, `agent-model-connection-isolation.spec.ts`, `agent-config-persistence.spec.ts`, `agent-max-iterations.spec.ts`, `agent-max-tokens.spec.ts`, `agent-reasoning-effort.spec.ts`, `agent-input-sources.spec.ts`, `agent-structured-output.spec.ts`, `agent-empty-refusal-response.spec.ts`, `agent-current-date-tool.spec.ts`, `agent-parse-error-behavior.spec.ts`, `agent-multimodal-image-input.spec.ts`

---

### 13.1 Agent component displayed on canvas with default settings `[-]`

**Step by step:**
1. Search "Agent" in the sidebar.
2. Add to canvas.
3. Verify that the component displays:
   - Input handle for "Language Model" (`handle-agent-shownode-language model-left`)
   - Input handle for "Tools" (`handle-agent-shownode-tools-left`)
   - Output handle "Response" (`handle-agent-shownode-response-right`)
4. Verify that default fields (Max Iterations, System Prompt) are visible.

**Validation:** Agent component with all handles and default fields visible.

---

### 13.2 Connecting an external model in Agent drops the prior model selection `[x]`

**File:** `agent-model-connection-isolation.spec.ts`

**Objective:** Ensure connection-mode isolation in the Langflow 1.11 unified model picker: choosing "Connect other models" clears the previously selected model (and the node's secret fields), so a stale provider configuration cannot reach a backend run. The 1.11 Agent has no inline per-provider credential fields (credentials are global, under Settings → Model Providers), so the older "switch provider → provider-specific fields disappear" scenario no longer applies.

**Step by step:**
1. Load "Simple Agent" template with a configured provider/model (resolved from `models.json` / `MODEL_TEST_ID`).
2. Confirm the model picker (`model_model`) shows a concrete model name in `value-dropdown-model_model` (not the "Select a model" placeholder).
3. Open the picker and click the `connect-other-models` footer button.
4. Verify `value-dropdown-model_model` now reads "Connect other models" — the connection-mode label that replaces the prior model selection.

**Validation:** The previously selected model is dropped and the trigger reflects connection mode; the prior provider selection cannot leak into execution.

---

### 13.3 Flow with Agent saved and reopened — settings persist `[ ]`

**File:** `agent-config-persistence.spec.ts`

**Objective:** Confirm that when saving a flow with a configured Agent and reopening it, all parameters are preserved.

**Step by step:**
1. Load "Simple Agent" template with provider X, model Y.
2. Configure `Agent Instructions` = `"You are an assistant specialized in Python."`.
3. Configure `Max Iterations` = `5`.
4. Save the flow (auto-save or Ctrl+S).
5. Navigate to the main page and open another flow.
6. Return to the original flow.
7. Verify that provider, model, `Agent Instructions` and `Max Iterations` have the configured values.

**Validation:** All Agent settings are preserved after saving and reopening the flow.

---

### 13.4 max_iterations limits agent cycles `[ ]`

**File:** `agent-max-iterations.spec.ts`

**Objective:** Verify that the `max_iterations` parameter is respected and the agent stops when the limit is reached.

**Step by step:**
1. Load "Simple Agent" template with a tool connected (e.g.: Calculator).
2. Configure `Max Iterations` = `1` in the Agent component.
3. Send a prompt that would normally require multiple cycles (e.g.: `"Calculate 5+3 and then multiply by 2"`).
4. Wait for execution to finish.
5. Verify that the agent responded (did not fail silently).
6. Verify in "Agent Steps" that there was at most 1 reasoning iteration.

**Validation:** Agent stops after 1 iteration and returns response or limit-reached message.

---

### 13.5 max_tokens limits response size `[ ]`

**File:** `agent-max-tokens.spec.ts`

**Objective:** Verify that the `max_tokens` parameter is included in the payload sent to the model API.

**Step by step:**
1. Intercept requests to `**/api/v1/run/**` via `page.route`.
2. Load "Simple Agent" template and configure `Max Tokens` = `50`.
3. Send a prompt that normally generates a long response (e.g.: `"Write 500 words about AI"`).
4. Verify in the intercepted payload that `max_tokens: 50` is present.
5. Verify that the response is shorter than without the limit.

**Validation:** `max_tokens` parameter present in the payload and response truncated as expected.

---

### 13.6 reasoning_effort field is conditional on the model `[ ]`

**File:** `agent-reasoning-effort.spec.ts`

**Objective:** Verify that the reasoning effort field only appears for models that support this feature.

**Step by step:**
1. Load "Simple Agent" template with a model that supports reasoning (e.g.: `claude-sonnet-4-5`).
2. Verify if `reasoning_effort` field is visible in the Agent component.
3. Switch to a model that does not support reasoning (e.g.: `gpt-4o-mini`).
4. Verify that the `reasoning_effort` field is **not visible** (or is disabled).

**Validation:** `reasoning_effort` field appears/disappears based on the capability of the selected model.

---

### 13.7 Agent Instructions (system prompt) is respected `[ ]`

**File:** `agent-system-prompt.spec.ts`

**Objective:** Confirm that the content of the `Agent Instructions` field is sent as a system prompt and influences the model's response.

**Precondition:** Provider with valid API key configured.

**Step by step:**
1. Load "Simple Agent" template.
2. Configure `Agent Instructions` = `"Always respond in French, regardless of the question language."`.
3. Open Playground.
4. Send message in English: `"What is the capital of France?"`.
5. Wait for response.
6. Verify that the response is in **French**.

**Scenario B — Empty system prompt:**
1. Clear the `Agent Instructions` field.
2. Send any message.
3. Verify that the agent responds normally (no crash or error).

**Validation:** System prompt influences response; empty field does not cause failure.

---

### 13.8 Input via direct field vs handle (ChatInput) `[ ]`

**File:** `agent-input-sources.spec.ts`

**Objective:** Verify that the Agent accepts input both from the `input_value` field directly and via a handle connected to ChatInput.

**Step by step (Scenario A — direct field):**
1. Add Agent to canvas without ChatInput connected.
2. Fill `input_value` field directly: `"Hello from direct input"`.
3. Click Run on the component.
4. Verify that the response is generated.

**Step by step (Scenario B — via handle):**
1. Load "Simple Agent" template (ChatInput connected to Agent).
2. Open Playground and send a message.
3. Verify that the message reaches the Agent and the response is returned.

**Validation:** Both input forms work correctly.

---

### 13.9 Structured output schema generates valid JSON `[ ]`

**File:** `agent-structured-output.spec.ts`

**Objective:** Verify that when `output_schema` is configured, the Agent returns JSON with the defined fields.

**Step by step:**
1. Load "Simple Agent" template.
2. Open Agent advanced settings.
3. Configure `output_schema` with fields: `name` (string), `age` (integer).
4. Configure `format_instructions` = `"Respond with a JSON object with 'name' and 'age' fields."`.
5. Send prompt: `"Generate a fictional person named John who is 30 years old."`.
6. Wait for response.
7. Verify that the response contains JSON with `name` and `age` fields.

**Validation:** Valid JSON returned with the fields from the configured schema.

---

### 13.10 Empty response or model refusal — no crash `[ ]`

**File:** `agent-empty-refusal-response.spec.ts`

**Objective:** Verify that the Agent component does not crash when the model refuses or returns an empty response.

**Step by step (via mock):**
1. Intercept the LLM API call via `page.route`.
2. Return an empty response (body `""`, status `200`).
3. Send a message in the Playground.
4. Verify that the Playground does not freeze — some message is displayed (empty response or friendly error).
5. Verify that the input field becomes available again (does not remain in endless loading state).

**Validation:** Graceful behavior — no crash; UI returns to interactive state.

---

### 13.11 Toggle add_current_date_tool works `[ ]`

**File:** `agent-current-date-tool.spec.ts`

**Objective:** Verify that the `Add Current Date Tool` toggle adds/removes the date tool from the agent.

**Precondition:** Provider with valid API key configured.

**Step by step:**
1. Load "Simple Agent" template.
2. Enable the `Add Current Date Tool` toggle in the Agent component.
3. Open Playground and send: `"What is today's date?"`.
4. Verify that the agent uses the date tool (appears in Agent Steps) and returns the correct date.
5. Disable the `Add Current Date Tool` toggle.
6. Send the same question.
7. Verify that the date tool **does not appear** in Agent Steps.

**Validation:** Toggle controls the presence of the date tool; tool appears/disappears in steps as configured.

---

### 13.12 handle_parsing_errors controls behavior on parse failure `[ ]`

**File:** `agent-parse-error-behavior.spec.ts`

**Objective:** Verify the difference in behavior between `handle_parsing_errors=True` and `False`.

**Step by step (via mock):**
1. Configure `handle_parsing_errors = False` in the Agent.
2. Intercept the LLM response to return malformed JSON when output_schema is configured.
3. Send a message.
4. Verify that the Agent returns an **explicit error** (does not try to correct).

**Scenario B — True:**
1. Configure `handle_parsing_errors = True`.
2. Repeat the same mock.
3. Verify that the Agent tries to self-correct (sends a second request) or returns a partial response.

**Validation:** Distinct behaviors according to `handle_parsing_errors`.

---

### 13.13 Image via input handle is processed by Agent `[ ]`

**File:** `agent-multimodal-image-input.spec.ts`

**Objective:** Verify that images passed via the input handle (not through the playground) are processed correctly by the agent.

**Precondition:** Multimodal model configured (e.g.: `claude-3-5-sonnet`, `gpt-4o`).

**Step by step:**
1. Add to canvas: Agent + component that generates an image (e.g.: URL Extractor with a public image).
2. Connect the image output to the Agent's input handle.
3. Configure Agent Instructions = `"Describe what you see in the image."`.
4. Execute the flow.
5. Verify that the Agent returns a description of the image (not an error or empty response).

**Validation:** Image content processed correctly via input handle.

---

---

## 14. Authentication — Login and Logout

**Files:** `core/features/auto-login-off.spec.ts`, `login-invalid-credentials.spec.ts`, `logout-flow.spec.ts`

---

### 14.1 Login with valid credentials `[-]`

**Objective:** Verify that a user with correct credentials accesses the system.

**Precondition:** Auto-login disabled (LANGFLOW_AUTO_LOGIN=false).

**Step by step:**
1. Navigate to `http://localhost:7860`.
2. Verify that the login screen is displayed.
3. Fill Username: `langflow` and Password: `langflow`.
4. Click "Sign In".
5. Verify that the user is redirected to the main page (`mainpage_title` visible).

**Validation:** User authenticated and redirected to the home.

---

### 14.2 Login with invalid credentials `[-]`

**Step by step:**
1. Navigate to the login screen.
2. Fill Username: `wrong_user` and Password: `wrong_password`.
3. Click "Sign In".
4. Verify that the error message `"Error signing in"` is displayed.
5. Verify that the user remains on the login screen.

**Validation:** Error message displayed, access blocked.

---

### 14.3 Logout redirects to login screen `[-]`

**Step by step:**
1. Login successfully.
2. Click the profile icon (`user-profile-settings`).
3. Click "Logout".
4. Verify that the user is redirected to the login screen.

**Validation:** Session ended and user redirected to login.

---

### 14.4 Auto-login enabled — skips login screen `[-]`

**Step by step:**
1. Navigate to `http://localhost:7860` with LANGFLOW_AUTO_LOGIN=true.
2. Verify that the login screen is NOT displayed.
3. Verify that the main page loads directly.

**Validation:** With auto-login active, user accesses directly without credentials.

---

### 14.5 Auto-login disabled — displays login screen `[-]`

**Step by step:**
1. Mock the `/api/v1/auto_login` endpoint to return status 500.
2. Navigate to `http://localhost:7860`.
3. Verify that the login screen is displayed (`text=sign in to langflow`).

**Validation:** Without auto-login, the authentication screen is mandatory.

---

### 14.6 Expired session — redirects to login `[-]`

**Step by step:**
1. Login successfully.
2. Simulate token expiration (via mock or wait for timeout).
3. Attempt an authenticated action (e.g.: create flow).
4. Verify that the system redirects to the login screen.

**Validation:** Action with expired session results in redirect to login.

---

### 14.7 Session cleanup after logout `[-]`

**Step by step:**
1. Login and create a flow.
2. Logout.
3. Verify that session cookies/tokens were removed.
4. Attempt to access an authenticated URL directly — should redirect to login.

**Validation:** Session tokens cleared after logout.

---

---

## 15. User Management (Admin)

**File:** `core/features/admin-user-management.spec.ts`

---

### 15.1 Admin creates new user `[-]`

**Step by step:**
1. Login as admin.
2. Navigate to Admin Page (user menu → "Admin Page").
3. Click "New User".
4. Fill in the name, username and password of the new user.
5. Click save.
6. Verify success message `"new user added"`.
7. Verify that the user appears in the listing.

**Validation:** New user created and visible in the listing.

---

### 15.2 Admin deactivates user `[-]`

**Step by step:**
1. Locate active user in Admin Page listing.
2. Click the `#is_active` toggle to deactivate.
3. Try to login with the deactivated user.
4. Verify that the login fails.

**Validation:** Deactivated user cannot authenticate.

---

### 15.3 Admin activates inactive user `[-]`

**Step by step:**
1. Locate inactive user.
2. Click the `#is_active` toggle to activate.
3. Login with the reactivated user.
4. Verify that the login is successful.

**Validation:** Activated user can authenticate normally.

---

### 15.4 Admin renames user `[-]`

**Step by step:**
1. Click the edit icon (`icon-Pencil`) of the user.
2. Change the display name.
3. Save.
4. Verify message `"user edited"`.
5. Verify that the new name appears in the listing.

**Validation:** User name updated in the listing.

---

### 15.5 Admin changes user password `[-]`

**Step by step:**
1. Edit user and change password to `"NewPassword123"`.
2. Save.
3. Try login with the old password — should fail.
4. Try login with the new password — should work.

**Validation:** Old password invalid, new password works.

---

### 15.6 Isolation: user A cannot see user B's flows `[-]`

**Step by step:**
1. Create flow with user A.
2. Login as user B.
3. Verify that user A's flows do NOT appear in user B's listing.

**Validation:** Flows are isolated per user.

---

---

## 16. Global Variables (API Keys)

**Files:** `ui-ux/global-variable-edit.spec.ts`, `ui-ux/global-variables-crud.spec.ts`

---

### 16.1 Create global variable from Settings page `[x]`

**Objective:** Confirm that a Generic global variable can be created from the Settings page (`/settings/global-variables`) and appears in the ag-grid table.

**Step by step:**
1. Navigate to Settings → Global Variables (`/settings/global-variables`).
2. Click the "Add New" button (`api-key-button-store`).
3. Switch to the Generic tab (`generic-tab`).
4. Fill in name and value.
5. Click Save (`save-variable-btn`).

**Validation:** The variable name appears as an exact match in `.ag-cell-value` within 10s.

---

### 16.2 Edit existing global variable `[x]`

**Objective:** Confirm that clicking an existing variable row opens the Update modal and saving a new value emits the "updated successfully" toast.

**Step by step:**
1. Create a variable as in 16.1.
2. Click the variable row in the ag-grid table.
3. Verify the "Update Variable" heading is visible.
4. Replace the value field with a new value.
5. Click Save (`save-variable-btn`).

**Validation:** Text matching `/updated successfully/` is visible within 5s — the toast only fires when `PATCH /api/v1/variables/{id}` returns 200.

---

### 16.3 Delete global variable `[x]`

**Objective:** Confirm that deleting a variable removes it from the listing.

**Step by step:**
1. Locate a global variable in the listing.
2. Click the delete icon (`icon-Trash2`).
3. Confirm the deletion in the dialog.

**Validation:** The variable no longer appears in the listing (count drops to 0 for that name).

---

### 16.4 Create global variable of type "Generic" `[x]`

**Objective:** Confirm that the Generic tab is selectable and produces a Generic-type variable.

**Step by step:**
1. Open the Add New modal (either via the Globe icon in a component or via the Settings page).
2. Switch to the Generic tab.
3. Fill in name and value, save.

**Validation:** Generic type variable created with correct type, listed in the table.

---

### 16.5 Credential variable value is hidden from the variable list `[x]`

**Objective:** Confirm that after saving a Credential-type variable, its value is never rendered as visible text anywhere on the page (toast, label, preview, etc.).

**Step by step:**
1. Open the Add New modal.
2. Switch to the Credential tab.
3. Fill in name and a distinctive sentinel value (e.g. `SECRET-SENTINEL-{Date.now()}`).
4. Save.

**Validation:** `getByText(sentinelValue)` has count 0 — the sentinel must not surface as visible text anywhere in the DOM. Input value attributes (`<input type="password" value="…">`) don't count as visible text; only rendered text does, which is the guarantee under test.

---

---

## 17. File Upload and Processing

**Files:** `core/unit/fileUploadComponent.spec.ts`, `extended/features/files-page.spec.ts`

---

### 17.1 Upload file via component `[-]`

**Step by step:**
1. Add file upload component to canvas.
2. Click the upload button of the component.
3. Select file (e.g.: `test.txt`).
4. Verify that the file name appears in the component after upload.

**Validation:** File loaded and name displayed in the component.

---

### 17.2 Upload files of different types `[-]`

**Step by step:**
1. Test uploading `.txt`, `.pdf`, `.json`, `.py` files.
2. Verify that all types are accepted without error.

**Validation:** Multiple file formats accepted by the component.

---

### 17.3 File size limit `[-]`

**Step by step:**
1. Try to upload a file that exceeds the configured limit.
2. Verify that the system displays a size error message.
3. Verify that the file is NOT uploaded.

**Validation:** Error message displayed for file above the limit.

---

---

## 18. LLM Agents — Execution and Control

**Files:** `llm-agents/agent-component-regression.spec.ts`, `llm-agents/memory-history-regression.spec.ts`

---

### agent-component-regression.spec.ts

---

### 18.1 Agent responds without connected tools `[x]`

**Objective:** Verify that the agent executes and returns a valid response even without any connected tool.

**Step by step:**
1. Load "Simple Agent" template and configure model via `models.json`.
2. Open Playground.
3. Send: `"What is the capital of France?"`.
4. Wait for execution to finish (Stop button disappears or never appears).
5. Verify that `div-chat-message` is visible.
6. Verify that the response text has content (length > 1).

**Validation:** Agent responds correctly without connected tools.

---

### 18.2 Agent displays reasoning steps and returns valid response `[x]`

**Objective:** Verify that the Agent responds with valid content and, when using internal reasoning, displays the duration indicator in the Playground. The steps check is soft — models that respond directly without tools do not generate the indicator, which is expected behavior.

**Step by step:**
1. Load "Simple Agent" template and configure model via `models.json`.
2. Open Playground.
3. Send: `"Who was the first astronaut to walk on the Moon?"`.
4. Wait for execution to finish (Stop button disappears or never appears — both valid).
5. Verify that `div-chat-message` is visible and has content (length > 1).
6. **(Soft check)** If `"Finished in Xs"` is visible, verify it is not empty.

**Relevant DOM:**
- `div-chat-message` → assistant message
- `"Finished in"` → duration indicator, displayed when the agent uses reasoning steps

**Validation:** Valid response returned for all models; duration indicator verified when present.

---

### 18.3 Agent stop button halts execution mid-run `[x]`

**Objective:** Verify that the Stop button interrupts agent execution during an ongoing run.

**Step by step:**
1. Load "Simple Agent" template and configure model via `models.json`.
2. Open Playground.
3. Send: `"Write a detailed story about the life and adventures of a fictional explorer in the 18th century."`.
4. Wait for Stop button to appear (timeout 30s). If it doesn't appear, model responded too fast — implicit skip.
5. Click the Stop button via `dispatchEvent("click")`.
6. Verify that the Stop button disappears.
7. Verify that `input-chat-playground` becomes visible again.

**Validation:** Execution interrupted successfully and playground returns to input state.

---

### 18.4 Agent displays duration after successful run `[x]`

**Objective:** Verify that the execution time is displayed at the end of a successful run.

**Step by step:**
1. Load "Simple Agent" template and configure model via `models.json`.
2. Open Playground.
3. Send: `"What are the main differences between mammals and reptiles?"`.
4. Wait for execution to finish (Stop button disappears or never appears).
5. Verify that `div-chat-message` is visible.
6. **(Soft check)** If `"Finished in Xs"` is visible, verify it is not empty.

**Validation:** Duration indicator displayed when present after successful run.

---

### 18.5 Agent streams response progressively in the playground `[x]`

**Objective:** Verify that the agent's response is displayed progressively in the playground, confirming that streaming is active during generation.

**Step by step:**
1. Load "Simple Agent" template and configure model via `models.json`.
2. Open Playground.
3. Send: `"Write a 5-paragraph summary explaining what artificial intelligence is, covering its definition, history, main techniques, applications, and future perspectives."`.
4. Wait for `div-chat-message` to appear (agent started responding).
5. Capture the text at that moment (`textAtStart`).
6. Wait 3 seconds.
7. Capture the text again (`textAfterWait`).
8. If Stop button is still visible: assert that `textAfterWait.length > textAtStart.length`.
9. Wait for Stop to disappear and verify that the final text has content (length > 1).

**Validation:** Text grows progressively during streaming; final response with valid content.

---

### 18.6 Playground displays response time on canvas after closing `[x]`

**Objective:** Verify that after the agent finishes responding and the playground is closed, the duration indicator is displayed on the agent node in the canvas.

**Step by step:**
1. Load "Simple Agent" template and configure model via `models.json`.
2. Open Playground.
3. Send: `"What are the main differences between mammals and reptiles?"`.
4. Wait for the response to finish (Stop button disappears) and `div-chat-message` to be visible.
5. Click `playground-close-button` to close the playground.
6. Verify that `node_duration_agent` is visible on the canvas.

**Relevant DOM:**
- `playground-close-button` → button to close the playground
- `node_duration_agent` → duration indicator on the agent node in the canvas

**Validation:** Duration indicator displayed on canvas after closing the playground.

---

### 18.7 Agent handles multiple consecutive messages in same session `[x]`

**Objective:** Verify that the agent responds correctly to multiple sequential messages in the same session.

**Step by step:**
1. Load "Simple Agent" template and configure model via `models.json`.
2. Open Playground.
3. Send `"Hello."` and wait for response.
4. Send `"Name three countries in South America."` and wait for response.
5. Verify that there are at least 2 visible messages (`div-chat-message` count ≥ 2).

**Validation:** Agent responds correctly to both messages in the same session.

---

### memory-history-regression.spec.ts

---

### 18.8 Memory History retains context between messages in the same session `[x]`

**Objective:** Verify that the Message History component maintains the conversation history between messages within the same Playground session.

**File:** `llm-agents/memory-history-regression.spec.ts`

**Step by step:**
1. Load "Memory Chatbot" template and configure OpenAI model.
2. Open Playground and start a new session (`new-chat`).
3. Send: `"In our conversation my name is TESTNAME_XY9Z."`.
4. Wait for response (1 message displayed).
5. Send: `"What is my name from our conversation?"`.
6. Wait for response (2 messages displayed).
7. Verify that the response contains `"TESTNAME_XY9Z"`.

**Validation:** Assistant recalls the name provided in the previous message.

---

### 18.9 Session isolation: distinct session IDs have independent histories `[x]`

**Objective:** Verify that two distinct sessions do not share history.

**File:** `llm-agents/memory-history-regression.spec.ts`

**Step by step:**
1. Load "Memory Chatbot" template and configure OpenAI model.
2. Session A: send `"In our conversation my secret code is ALPHA_CODE_111."`.
3. Start a new session (`new-chat`) — session B: send `"What secret code did I mention?"`.
4. Verify that session B's response does **not** contain `"ALPHA_CODE_111"`.

**Validation:** Session B has no access to session A's history.

---

### 18.10 Messages persist after closing and reopening the Playground `[x]`

**File:** `llm-agents/memory-history-regression.spec.ts`

**Step by step:**
1. Load "Memory Chatbot" template and configure OpenAI model.
2. Open Playground, start a new session and send: `"In our conversation my value is PERSIST_VALUE_42."`.
3. Close the Playground and reopen it by clicking `playground-btn-flow-io`.
4. Select the same session and send: `"What value did I mention earlier?"`.
5. Verify that the response contains `"PERSIST_VALUE_42"`.

**Validation:** History persisted between Playground openings.

---

### 18.11 Without Message History, LLM does not retain context between messages `[x]`

**File:** `llm-agents/memory-history-regression.spec.ts`

**Step by step:**
1. Load "Simple Agent" template (without Message History) and configure OpenAI model.
2. Open Playground, send: `"In our conversation my secret is NOMEM5678."`.
3. Send: `"What secret did I just tell you?"`.
4. Verify that the response does **not** contain `"NOMEM5678"`.

**Validation:** LLM without memory does not recall information from previous messages.

---

### 18.12 n_messages parameter of Message History `[ ]`

**File:** `agent-n-messages-limit.spec.ts` — awaiting backend bug fix.

> ⚠️ **Confirmed bug:** The `n_messages` parameter is saved correctly by the frontend but ignored during backend execution (`MemoryComponent.retrieve_messages()`).

**Step by step (when the bug is fixed):**
1. Load "Memory Chatbot" template, change `n_messages` to `2` in the "Message History" node.
2. Send 3 exchanges with distinct values (ALPHA, BETA, GAMMA).
3. Ask for all 3 values.
4. Verify that GAMMA is in the response and ALPHA is not.

**Validation:** With `n_messages=2`, only the last 2 message pairs are in context.

---

### 18.13 Fixed context_id — continuity between messages `[ ]`

**File:** `agent-context-id-continuity.spec.ts`

**Objective:** Verify that the Agent maintains memory between messages when a fixed `context_id` is configured.

**Precondition:** Provider with valid API key. Agent with `context_id` defined (e.g.: `"test-session-001"`).

**Step by step:**
1. Load "Simple Agent" template.
2. Configure `context_id` = `"test-session-001"` in the Agent component.
3. Open Playground.
4. Send: `"My name is John"`. Wait for response.
5. Send: `"What is my name?"`. Wait for response.
6. Verify that the response contains `"John"`.

**Validation:** Agent recalls information from the previous message via `context_id`.

---

### 18.14 Switch context_id — isolation between sessions `[ ]`

**File:** `agent-context-id-isolation.spec.ts`

**Objective:** Verify that changing the `context_id` starts a new context, without access to the previous history.

**Precondition:** Provider with valid API key.

**Step by step:**
1. Configure `context_id` = `"session-A"` in the Agent.
2. Send: `"My name is Ana"`. Wait for response.
3. Change `context_id` to `"session-B"`.
4. Send: `"What is my name?"`.
5. Verify that the response does **not mention** `"Ana"` (isolated session).

**Validation:** History of `"session-A"` does not leak into `"session-B"`.

---

### 18.15 Multiple tools — agent selects the correct one `[ ]`

**File:** `agent-multi-tool-selection.spec.ts`

**Objective:** Verify that the agent chooses the correct tool among multiple available ones.

**Precondition:** Two tools connected to the Agent (e.g.: Calculator + DuckDuckGo).

**Step by step:**
1. Connect Calculator and DuckDuckGo to the Agent.
2. Open Playground.
3. Send: `"What is 47 times 83?"`.
4. Wait for response.
5. Verify in "Agent Steps" that `Calculator` was called (not DuckDuckGo).
6. Send: `"Search for the latest news about artificial intelligence"`.
7. Verify in "Agent Steps" that `DuckDuckGo` was called (not Calculator).

**Validation:** Agent selects the correct tool based on the nature of the prompt.

---

### 18.16 Tool that returns error — agent does not crash `[ ]`

**File:** `agent-tool-error-handling.spec.ts`

**Objective:** Verify agent behavior when a connected tool returns an error.

**Step by step:**
1. Create a custom component that always raises an exception (e.g.: `raise ValueError("tool error")`).
2. Connect as a tool to the Agent.
3. Send a prompt that forces use of the tool.
4. Wait for execution.
5. Verify that:
   - The Playground does not freeze indefinitely.
   - The tool error appears in "Agent Steps" (ToolContent with error status).
   - The agent returns some response (alternative or friendly error message).

**Validation:** Tool failure is handled; agent does not crash; error visible in steps.

---

### 18.17 Tool with invalid name — validation prevents execution `[ ]`

**File:** `agent-tool-name-validation.spec.ts`

**Objective:** Verify that the Agent validates tool names and rejects names outside the pattern `^[a-zA-Z0-9_-]+$`.

**Step by step:**
1. Create a custom component with a name containing a space or special character (e.g.: `"my tool!"`).
2. Connect as a tool to the Agent.
3. Execute the flow.
4. Verify that the Agent component displays a validation error before calling the LLM.
5. Verify that the error message is clear and visible on the canvas (not a silent error).

**Validation:** Tool name validation occurs before execution; explicit error displayed.

---

---

## 19. Model Providers

**Files:** `claude-model-switch.spec.ts`, `modelProviderModal.spec.ts`, `provider-invalid-auth-error.spec.ts`

---

### 19.1 Configure OpenAI API key via Global Variables `[-]`

**Step by step:**
1. Navigate to Settings → Global Variables.
2. Create variable `OPENAI_API_KEY` with the valid key.
3. Add OpenAI component to canvas.
4. Verify that the API key field displays the global variable as an option.
5. Select the global variable.

**Validation:** API key configured via global variable.

---

### 19.2 Select GPT model (GPT-4o-mini) `[-]`

**Step by step:**
1. Add OpenAI component to canvas.
2. Click the model dropdown.
3. Select `gpt-4o-mini` (testid: `gpt-4o-mini-option`).
4. Verify that the selected model appears in the dropdown.

**Validation:** GPT-4o-mini model selected and displayed.

---

### 19.3 Select Claude model `[-]`

**Step by step:**
1. Add Anthropic component to canvas.
2. Configure Anthropic API key.
3. Select Claude model (e.g.: `claude-sonnet-4-5-20250929`).
4. Verify that the model is selected.

**Validation:** Claude model selected correctly.

---

### 19.4 Switch between Claude models `[-]`

**Step by step:**
1. With Anthropic component configured with Sonnet model.
2. Open dropdown and select Haiku.
3. Verify that the model changes.
4. Repeat for Opus.

**Validation:** All Claude models available and selectable.

---

### 19.5 Invalid authentication error — OpenAI `[-]`

**File:** `provider-invalid-auth-error.spec.ts`

**Precondition:** `OPENAI_API_KEY` configured in `.env`.

**Step by step:**
1. Navigate to `Settings` via user menu.
2. Click the `icon-Brain` icon to access Model Providers.
3. Click the OpenAI provider.
4. Select all content in the API key field and enter an invalid key (e.g.: `sk-invalid-openai-key-for-testing`).
5. Click `Save Configuration` (first time) or `Replace Configuration` (key already exists).
6. Verify that `.error-build-message` displays text matching `/Invalid API key/i`.
7. (Cleanup) Select the field, enter the valid key from `.env` and click `Replace Configuration`.

**Validation:** Langflow displays `.error-build-message` with `/Invalid API key/i` immediately after saving an invalid key on the provider configuration page.

---

### 19.6 Invalid authentication error — Anthropic `[-]`

**File:** `provider-invalid-auth-error.spec.ts`

**Precondition:** `ANTHROPIC_API_KEY` configured in `.env`.

**Step by step:**
1. Navigate to `Settings` via user menu.
2. Click the `icon-Brain` icon to access Model Providers.
3. Click the Anthropic provider.
4. Select all content in the API key field and enter an invalid key (e.g.: `sk-ant-invalid-for-testing`).
5. Click `Save Configuration` or `Replace Configuration`.
6. Verify that `.error-build-message` displays text matching `/Invalid API key/i`.
7. (Cleanup) Select the field, enter the valid key from `.env` and click `Replace Configuration`.

**Validation:** Langflow displays `.error-build-message` with `/Invalid API key/i` immediately after saving an invalid key on the provider configuration page.

---

### 19.7 Invalid authentication error — Google `[-]`

**File:** `provider-invalid-auth-error.spec.ts`

**Precondition:** `GOOGLE_API_KEY` configured in `.env`.

**Step by step:**
1. Navigate to `Settings` via user menu.
2. Click the `icon-Brain` icon to access Model Providers.
3. Click the Google Generative AI provider.
4. Select all content in the API key field and enter an invalid key (e.g.: `AIza-invalid-google-key-for-testing`).
5. Click `Save Configuration` or `Replace Configuration`.
6. Verify that `.error-build-message` displays text matching `/Invalid API key/i`.
7. (Cleanup) Select the field, enter the valid key from `.env` and click `Replace Configuration`.

**Validation:** Langflow displays `.error-build-message` with `/Invalid API key/i` immediately after saving an invalid key on the provider configuration page.

---

### 19.8 "Manage Model Providers" modal `[-]`

**Step by step:**
1. Click the provider management button.
2. Verify that the "Manage Model Providers" modal opens.
3. Verify the list of available providers.
4. Click on a provider and verify that it is possible to configure the API key.

**Validation:** Modal opens, lists providers and allows configuration.

---

### 19.9 Configure provider API key — first setup (Save Configuration) `[x]`

**File:** `helpers/provider-setup/collect-models.ts` — `collectModelsForProvider`

**Objective:** Verify that the helper can configure an API key on a provider that does not yet have a saved key.

**Precondition:** Provider without API key configured in Langflow (field with placeholder `sk-ant-...`, `AIza...` or `sk-...` visible).

**Step by step:**
1. Navigate to Settings → Model Providers.
2. Click the desired provider (e.g.: Anthropic).
3. Verify that the input with placeholder `sk-ant-...` is visible.
4. Click the input — "Save Configuration" button appears enabled.
5. Type the API key via `pressSequentially`.
6. Click "Save Configuration".
7. Wait for the "Replace Configuration" button to appear on screen as confirmation.

**Validation:** "Replace Configuration" button displayed after save, indicating the key was persisted.

---

### 19.10 Replace provider API key — existing key (Replace Configuration) `[x]`

**File:** `helpers/provider-setup/collect-models.ts` — `collectModelsForProvider`

**Objective:** Verify that the helper can replace an API key already configured on a provider.

**Precondition:** Provider with API key already saved ("Replace Configuration" button present).

**Step by step:**
1. Navigate to Settings → Model Providers.
2. Click the desired provider.
3. Verify that the input with placeholder `sk-ant-...` is visible.
4. Click the input — previous value disappears and "Replace Configuration" button becomes disabled.
5. Type the new API key via `pressSequentially` — the React `onChange` enables the button.
6. Click "Replace Configuration".
7. Wait for the "Replace Configuration" button to reappear as confirmation.

**Validation:** "Replace Configuration" button redisplayed after click, confirming the new key was saved.

---

---

## 20. Observability — Traces and Notifications

**Files:** `core/features/traces.spec.ts`, `traces-latency-tokens.spec.ts`, `execution-error-notification.spec.ts`

---

### 20.1 View execution traces `[-]`

**Step by step:**
1. Execute a flow at least once.
2. Navigate to the Traces/Logs section.
3. Verify that the execution appears in the traces list.
4. Click on the trace to expand details.

**Validation:** Execution trace visible with expandable details.

---

### 20.2 Trace displays latency of each component `[-]`

**Step by step:**
1. Access the detail of a trace.
2. Verify that each flow component displays its latency (execution time).

**Validation:** Per-component latency visible in trace details.

---

### 20.3 Trace displays tokens consumed `[-]`

**Step by step:**
1. Execute flow with LLM.
2. Access the execution trace.
3. Verify that token fields (input tokens, output tokens, total) are present.

**Validation:** Token count visible in the trace.

---

### 20.4 Execution error notification `[-]`

**Step by step:**
1. Create flow with a component that will generate an error (e.g.: invalid URL in API Request).
2. Execute the flow.
3. Verify that an error notification appears in the interface with a descriptive message.

**Validation:** Execution error displayed as notification with details.

---

---

## 21. Playground — Chat and Session

**Files:** `core/features/playground-ux.spec.ts`, `playground-session-id.spec.ts`, `playground-history-persist.spec.ts`

---

### 21.1 Open Playground `[-]`

**Step by step:**
1. With a flow created and open in the editor.
2. Click the Playground button (`playground-btn-flow-io`).
3. Verify that the Playground panel opens.
4. Verify that the input field (`input-chat-playground`) is visible.

**Validation:** Playground opens with chat interface ready to use.

---

### 21.2 Send message and receive response `[-]`

**Step by step:**
1. Open Playground.
2. Type message in the input field.
3. Click "Send" (`button-send`).
4. Wait for response.
5. Verify that the assistant's response appears in the history.

**Validation:** Message sent, response received and displayed.

---

### 21.3 Send empty message `[!]` (DOCUMENTED BUG)

> ⚠️ **KNOWN BUG:** The send button is always enabled even with an empty field.

**Step by step:**
1. Open Playground without typing anything.
2. Check the state of the "Send" button.
3. Click "Send" with empty field.

**Validation:** Documented as bug — button should be disabled with empty field.

---

### 21.4 Switch session ID — starts new conversation `[-]`

**Step by step:**
1. Send message in the current session.
2. Locate the `chat-session-id` field and type a new ID.
3. Verify that the chat history is cleared (new session).
4. Confirm it is an independent conversation.

**Validation:** New session created without previous session's history.

---

### 21.5 Delete individual message from history `[-]`

**Step by step:**
1. Send at least one message in the Playground.
2. Hover over the message to show options.
3. Click the delete icon of the message.
4. Verify that the message was removed from the history.

**Validation:** Deleted message no longer appears in history.

---

### 21.6 History persists when reopening Playground `[-]`

**Step by step:**
1. Send messages in the Playground.
2. Close the Playground panel.
3. Reopen the Playground.
4. Verify that the previous messages are still in the history.

**Validation:** Chat history preserved after closing and reopening.

---

### 21.7 Playground fullscreen mode `[-]`

**Step by step:**
1. Open Playground.
2. Click the fullscreen button.
3. Verify that the Playground occupies the full screen.
4. Verify that it is still possible to send messages.

**Validation:** Fullscreen active, chat functionality preserved.

---

### 21.8 Shareable Playground — URL generation `[-]`

**File:** `tests/tests-automations/regression/core-functionality/playground/playground-shareable-url.spec.ts`

**Objective:** Verify that enabling the Shareable Playground feature on a flow with Chat I/O generates a valid public URL in the format `/playground/{uuid}`.

**Preconditions:** Langflow running. The `ENABLE_PUBLISH` feature flag must be active (enabled by default). Flow must contain Chat Input and Chat Output (Simple Agent template satisfies this).

**Step by step:**
1. Load the Simple Agent template.
2. Click the `publish-button` (Share button in the flow toolbar) to open the Share dropdown.
3. Verify that the `shareable-playground` item is visible and the `publish-switch` is unchecked (sharing off by default).
4. Click `publish-switch` to enable sharing.
5. Verify the switch becomes checked.
6. Verify that a link `<a href="/playground/{uuid}">` appears inside the `shareable-playground` item.
7. Assert the `href` matches `/\/playground\/[0-9a-f-]{36}/`.
8. Click `publish-switch` again to disable sharing (cleanup).

**Validation:** After enabling the switch, `[data-testid="shareable-playground"] a` is visible and its `href` attribute matches the `/playground/{uuid}` pattern. The switch returns to unchecked after cleanup.

---

## 22. Project and Folder Management

**File:** `core/features/folders.spec.ts`, `folder-deletion-integrity.spec.ts`

---

### 22.1 Create new folder `[-]`

**Step by step:**
1. On the main page, click "New Folder".
2. Type the folder name.
3. Confirm creation.
4. Verify that the folder appears in the listing.

**Validation:** Folder created and visible in the projects sidebar.

---

### 22.2 Rename folder `[-]`

**Step by step:**
1. Click the folder edit icon.
2. Type new name and confirm.
3. Verify that the new name appears in the listing.

**Validation:** Folder name updated.

---

### 22.3 Delete empty folder `[-]`

**Step by step:**
1. Create empty folder.
2. Click delete and confirm.
3. Verify that the folder no longer appears in the listing.

**Validation:** Empty folder deleted successfully.

---

### 22.4 Delete folder with flows inside `[-]`

**Step by step:**
1. Create folder with at least one flow inside.
2. Try to delete the folder.
3. Confirm deletion (cascade or alert).
4. Verify that folder and flows were removed.

**Validation:** Cascade deletion works or alert is displayed.

---

### 22.5 Move flow to another folder `[-]`

**Step by step:**
1. Select a flow and use "Move to Folder" option.
2. Select the target folder.
3. Verify that the flow appears in the new folder and not in the original.

**Validation:** Flow moved to target folder correctly.

---

### 22.6 Search flow by name `[-]`

**Step by step:**
1. Create at least two flows with different names.
2. Use the search field on the main page.
3. Type part of a flow name.
4. Verify that only the matching flow is displayed.

**Validation:** Search filters flows by name correctly.

---

---

## 23. Templates and Starter Projects

**Files:** `core/integrations/*.spec.ts`

---

### 23.1 Basic Prompting (OpenAI) `[-]`

**Step by step:**
1. Select "Basic Prompting" template.
2. Verify that the flow loads with Chat Input, Prompt Template, OpenAI LLM, Chat Output.
3. Configure OpenAI API key.
4. Open Playground and send a message.
5. Verify that a response is received.

**Validation:** Basic Prompting template executes and returns OpenAI response.

---

### 23.2 Simple Agent (OpenAI) `[-]`

**Step by step:**
1. Select "Simple Agent" template.
2. Verify that flow loads with Agent and default tools.
3. Configure API key.
4. Send a question in the Playground.
5. Verify Agent response.

**Validation:** Agent executes and returns response via Simple Agent template.

---

### 23.3 Memory Chatbot `[x]`

**Objective:** Verify that the Memory Chatbot template loads correctly and that the chatbot maintains context between messages.

**File:** `llm-agents/memory-history-regression.spec.ts`

**Step by step:**
1. Navigate to "All Templates" and select "Memory Chatbot".
2. Wait for canvas to load (`canvas_controls_dropdown` visible).
3. Verify that there are at least 3 nodes on the canvas (Memory History, LLM, Chat I/O).
4. Verify that there are at least 2 edges (connections between nodes).
5. Verify that the Playground button is visible (`playground-btn-flow-io`).
6. Configure OpenAI API key, open Playground and start new session.
7. Send: `"In our conversation my name is TESTNAME_XY9Z."`.
8. Send: `"What is my name from our conversation?"`.
9. Verify that the response contains `"TESTNAME_XY9Z"`.

**Validation:** Template loads with correct structure; chatbot maintains conversation context between messages.

---

### 23.4 Vector Store RAG `[-]`

**Step by step:**
1. Load "Vector Store RAG" template.
2. Upload a test document.
3. Configure embeddings and vector store.
4. Send a question related to the document content.
5. Verify that the response is based on the document.

**Validation:** RAG returns response based on the loaded document.

---

---

## 24. Flow — CRUD and Operations

**Files:** `core/features/export-import-flow.spec.ts`, `flow-lock.spec.ts`, `run-flow.spec.ts`

---

### 24.1 Create blank flow `[-]`

**Step by step:**
1. Click "New Flow" and select "Blank Flow".
2. Verify that an empty canvas is displayed.

**Validation:** Empty canvas displayed after selecting Blank Flow.

---

### 24.2 Create flow by duplicating existing `[-]`

**Step by step:**
1. Click "Duplicate" in a flow menu.
2. Verify that a new flow with "(copy)" in the name is created with the same components.

**Validation:** Flow duplicated with a copy of the original components.

---

### 24.3 Import flow via JSON `[-]`

**Step by step:**
1. Click "Import" and select a flow JSON file.
2. Verify that the flow is imported and displayed in the editor.

**Validation:** Flow imported correctly from JSON file.

---

### 24.4 Export flow as JSON `[-]`

**Step by step:**
1. Open existing flow.
2. Click Export.
3. Verify that a `.json` file download starts with the correct structure.

**Validation:** Valid JSON file generated for the flow.

---

### 24.5 Import invalid JSON — shows error `[-]`

**Step by step:**
1. Try to import a `.json` file with invalid content.
2. Verify that an error message is displayed.
3. Verify that no invalid flow is created.

**Validation:** Invalid JSON import displays descriptive error.

---

### 24.6 Lock flow `[-]`

**Step by step:**
1. Click the lock button in the editor.
2. Try to move a component on the canvas.
3. Verify that the movement is prevented.

**Validation:** Locked flow prevents edits on the canvas.

---

### 24.7 Execute flow via Run button `[-]`

**Step by step:**
1. Click the "Run" button (`button_run_flow`).
2. Verify that execution starts (loading indicators on components).
3. Verify that outputs are displayed at the end.

**Validation:** Execution started and results displayed in components.

---

### 24.8 Stop building flow `[-]`

**Step by step:**
1. Start flow execution.
2. Click "Stop" (`stop-building-button`) during execution.
3. Verify that execution stops and the "Run" button becomes available again.

**Validation:** Execution interrupted when clicking Stop.

---

---

## 25. MCP — Client and Server

---

### 25.1 MCP Server tab in flow `[-]`

**Step by step:**
1. Open a flow in the editor.
2. Verify the presence of the "MCP Server" tab.
3. Click the tab and verify that MCP-related content is displayed.

**Validation:** MCP Server tab accessible in the flow editor.

---

### 25.2 Add MCP server via modal `[-]`

**Step by step:**
1. Navigate to MCP configuration.
2. Click "Add MCP Server".
3. Fill in configuration (name, URL/command) and save.
4. Verify that the MCP server appears in the listing.

**Validation:** MCP server added and visible in the listing.

---

### 25.3 Configure MCP client connection `[ ]`

**Step by step:**
1. Add MCP Client component to the flow.
2. Configure connection type (stdio or HTTP) and parameters.
3. Verify that the connection is established without errors.

**Validation:** MCP Client component connected successfully.

---

---

## 26. UI/UX — Sidebar and Canvas

---

### 26.1 Search component by name `[-]`

**Step by step:**
1. Type name in the `sidebar-search-input` field.
2. Verify that only matching components are displayed.
3. Clear with `.clear()`.
4. Verify that all components return.

**Validation:** Search filter works and clears correctly.

---

### 26.2 Drag component from sidebar to canvas `[-]`

**Step by step:**
1. Locate component in the sidebar.
2. Drag to a specific position on the canvas.
3. Verify that the component appears on the canvas.

**Validation:** Component added to canvas via drag-and-drop.

---

### 26.3 Double-click in sidebar adds component `[-]`

**Step by step:**
1. Locate component in the sidebar.
2. Double-click on the component.
3. Verify that the component is added to the canvas automatically.

**Validation:** Double-click adds component to canvas.

---

### 26.4 Connect two compatible components `[-]`

**Step by step:**
1. Add Chat Input and Chat Output to canvas.
2. Click on the output handle of Chat Input.
3. Click on the input handle of Chat Output.
4. Verify that an edge is created.

**Validation:** Edge visible connecting the two components.

---

### 26.5 Prevent connection between incompatible types `[-]`

**Step by step:**
1. Try to connect handles of incompatible types.
2. Verify that the connection is not allowed.

**Validation:** System prevents connection between handles of incompatible types.

---

### 26.6 Delete component from canvas `[-]`

**Step by step:**
1. Select component on canvas.
2. Press Delete or use context menu → Delete.
3. Verify that the component is removed.

**Validation:** Component removed after Delete key.

---

### 26.7 Copy and paste component (Ctrl+C / Ctrl+V) `[-]`

**Step by step:**
1. Click on component to select it.
2. Press `Ctrl+C`.
3. Click on empty area of canvas.
4. Press `Ctrl+V`.
5. Verify that a second component (copy) appears.

**Validation:** Canvas with 2 components after copy-paste.

---

### 26.8 Select multiple components via box selection `[-]`

**Step by step:**
1. Add 2+ components to canvas.
2. Hold Shift and drag to create a selection box covering the components.
3. Verify that all covered components become selected.

**Validation:** Multiple components selected via Shift+drag.

---

### 26.9 Minimize component on canvas `[-]`

**Step by step:**
1. Click the minimize button of the component.
2. Verify that the component displays the minimized version.
3. Click again to expand.
4. Verify that the component returns to normal size.

**Validation:** Component minimizes and expands correctly.

---

### 26.10 Zoom in / Zoom out / Fit View `[-]`

**Step by step:**
1. Click Zoom In — verify that scale increases.
2. Click Zoom Out — verify that scale decreases.
3. Press `Ctrl+Shift+H` or click "Fit View" — verify that canvas centers all nodes.

**Validation:** Zoom and fit view work as expected.

---

### 26.11 Create and undo grouping `[-]`

**Step by step:**
1. Select 2+ components via box selection.
2. Use group option (context menu → "Group").
3. Verify that a group component is created.
4. Use "Ungroup" and verify that the original components are restored.

**Validation:** Component grouping and ungrouping works.

---

### 26.12 Freeze component `[-]`

**Step by step:**
1. Click "Freeze" on the component.
2. Verify visual indication of frozen.
3. Execute flow — verify that the frozen component uses cache.

**Validation:** Frozen component does not re-execute on new flow run.

---

### 26.13 Add and delete sticky note `[-]`

**Step by step:**
1. Right-click on canvas → "Add Note".
2. Verify that sticky note appears on canvas.
3. Select and press Delete.
4. Verify that the note was removed.

**Validation:** Sticky note added and removed from canvas.

---

### 26.14 Change sticky note color `[-]`

**Step by step:**
1. Select sticky note on canvas.
2. Choose a different color in the color selector.
3. Verify that the sticky note color changed.

**Validation:** Sticky note color changed as selected.

---

### 26.15 Context menu via right-click on canvas `[-]`

**Step by step:**
1. Right-click on empty area of canvas.
2. Verify that context menu opens with available options.

**Validation:** Context menu opens with correct options.

---

### 26.16 Access Settings page `[-]`

**Step by step:**
1. Click the profile icon (`user-profile-settings`).
2. Click "Settings" (`menu_settings_button`).
3. Verify that the Settings page loads with all tabs.

**Validation:** Settings page accessible with all tabs.

---

### 26.17 Change appearance/theme settings `[-]`

**Step by step:**
1. Access Settings.
2. Locate the theme toggle (Dark/Light mode).
3. Click to toggle the theme.
4. Verify that the theme changes in the interface.

**Validation:** Interface theme changes as configured.

---

---

## Current Coverage Summary

| Module | Total | Covered | Pending |
|--------|-------|----------|---------|
| REST API | 17 | 17 | 0 |
| Authentication + Users | 17 | 15 | 2 |
| Component Configuration | 20 | 18 | 2 |
| Core Components | 22 | 16 | 6 |
| Playground | 17 | 14 | 3 |
| Observability | 16 | 13 | 3 |
| Model Providers | 19 | 10 | 9 |
| Knowledge Ingestion | 8 | 4 | 4 |
| Flow Operations | 20 | 18 | 2 |
| MCP | 13 | 3 | 10 |
| Project Management | 11 | 9 | 2 |
| Templates | 35 | 33 | 2 |
| UI/UX Canvas | 34 | 32 | 2 |
| **TOTAL** | **249** | **202 (81%)** | **47 (19%)** |

---

## Automation Priorities

### 🔴 High Priority (release blockers)
1. Invalid API key error (OpenAI/Anthropic) — user must be clearly informed
2. Flow with Python error displays clear message in UI
3. Component update with breaking change — user alert
4. Network error during execution — retry or descriptive message

### 🟡 Medium Priority
5. MCP client — consumption of external tools and resources
6. Webhook trigger via external HTTP request
7. Agent — inspect tools used in Playground
8. [-] Shareable Playground URL generation (see 21.8)
9. Complete RAG pipeline

### 🟢 Low Priority
10. [x] Loop component — correct iterations (covered in section 27)
11. Ollama, Groq, Mistral providers
12. Model parameters (temperature, max tokens)
13. Edit sticky note text
14. Use global variable directly in component

---

## 27. Core Components — Loop

**File:** `tests/tests-automations/regression/core-components/loop-component-regression.spec.ts`

---

### 27.1 Loop component renders on canvas with all handles `[x]`

**Objective:** Verify that the Loop appears correctly on the canvas with all input/output handles and output inspection buttons.

**Preconditions:** Langflow running.

**Step by step:**
1. Create a blank flow.
2. Search "Loop" in the sidebar and add to canvas.
3. Verify that the title `title-Loop` is visible.
4. Verify that the run button `button_run_loop` is visible.
5. Verify that there is exactly 1 node on the canvas.
6. Verify input handles (left side):
   - `handle-loopcomponent-shownode-inputs-left` — receives the DataFrame to iterate
   - `handle-loopcomponent-shownode-item-left` — feedback port: receives the processed item
7. Verify output handles (right side):
   - `handle-loopcomponent-shownode-item-right` — emits the current iteration item
   - `handle-loopcomponent-shownode-done-right` — emits the aggregated DataFrame at the end
8. Verify output inspection buttons in the node footer:
   - `output-inspection-item-loopcomponent`
   - `output-inspection-done-loopcomponent`

**Validation:** All handles and inspection buttons visible; canvas with exactly 1 node.

---

### 27.2 Loop without connections shows "Flow build failed" notification `[x]`

**Objective:** Verify that executing the Loop in isolation (without connections) results in a controlled failure — without application crash.

**Preconditions:** Langflow running.

**Step by step:**
1. Create a blank flow.
2. Add the Loop component to canvas.
3. Click `button_run_loop` (node with no connections).
4. Wait for the error notification to appear.

**Validation:**
- Text "Flow build failed" visible on screen.
- Button `button_run_loop` still accessible after failure.
- Node `title-Loop` remains intact on canvas (1 node).
- Application does not freeze or reload.

---

### 27.3 Loop iterates over 2 ArXiv articles via Research Translation Loop template `[x]`

**Objective:** Validate the complete wiring of the Loop and that it iterates correctly — each DataFrame item enters the cycle, is processed by the LLM and returns via the `item` port, until `done` fires with the aggregated result.

**Preconditions:** Langflow running, OPENAI_API_KEY configured.

**Step by step:**
1. Access the Templates tab (`side_nav_options_all-templates`).
2. Click the template `template-research-translation-loop`.
3. Wait for canvas to load with the Loop node visible.
4. Verify wiring:
   - At least 1 edge present on canvas (template already connects the Loop in a cycle).
   - Handles `inputs-left`, `item-left`, `item-right` and `done-right` of the Loop visible.
5. Reduce the `int_int_max_results` field of ArXiv to `2` (minimum to validate iteration without long wait).
6. Open the Playground (`playground-btn-flow-io`).
7. Send the message `"transformer neural networks"`.
8. Wait for the bot response (`chat-message-AI-`).
9. Verify that the response contains at least 2 occurrences of "title" (case-insensitive) — each ArXiv article has a title, confirming the loop processed the 2 articles.

**Validation:** Non-empty bot response; "title" count ≥ 2 (confirms 2 loop iterations).

**Note:** Validation via "Title" is intentional and slightly fragile — it depends on the Parser's output format. If the template changes the prompt template, the counter may not match. The test's focus is to confirm the Loop iterated, not the exact content.

---

## 28. API Keys — Timestamps & Expiry

**Files:** `ui-ux/api-keys-timezone-display.spec.ts`, `api/flows/api-key-expiry-enforcement.spec.ts`
**Reference:** PR #13471 — Fix timestamp rendering for `expires_at` in API Key model.

---

### 28.1 Serializer emits UTC offset, no microseconds `[x]`

**Objective:** Confirm `GET /api/v1/api_key/` serializes datetime fields as offset-aware UTC ISO (`+00:00`) at second precision, the root-cause fix for the UTC display bug.

**Precondition:** Langflow running; authenticated (auto_login or form login).

**Step by step:**
1. Create two keys via `POST /api/v1/api_key/`: one with `expires_at = 2026-06-10T23:59:59+00:00`, one with no expiry.
2. `GET /api/v1/api_key/` and locate both keys.
3. Verify `created_at` (both) and `expires_at` (expiring key) match `^…T…\+00:00$` with no microseconds.
4. Verify `expires_at` round-trips to `2026-06-10T23:59:59+00:00`.
5. Verify no-expiry `expires_at` and both `last_used_at` are `null`.

**Validation:** All datetime fields offset-aware and second-precision; nulls preserved.

---

### 28.2 Settings table renders timestamps in local timezone `[x]`

**Objective:** Confirm the Settings → API Keys table converts UTC instants to the viewer's local time, with correct empty-state glyphs.

**Precondition:** Browser timezone pinned to `America/Sao_Paulo` (UTC−03:00); the two keys from 28.1 present.

**Step by step:**
1. Log in and open `/settings/api-keys`.
2. Verify the expiring key's **expires** cell reads `2026-06-10 20:59:59` (23:59:59 UTC − 03:00).
3. Verify the **created** cell is well-formatted and differs from the raw UTC wall clock.
4. Verify the unused key's **last used** cell reads `Never` and the no-expiry key's **expires** cell reads `∞`.

**Validation:** `expires_at` shows `20:59:59` (not the pre-fix `23:59:59`); `Never` and `∞` render correctly.

---

### 28.3 Expired key rejected, valid key accepted `[x]`

**Objective:** Confirm API key expiry is enforced on `POST /api/v1/run/{id}` (`x-api-key`).

**Precondition:** Langflow running; an empty flow created to run against.

**Step by step:**
1. Create an expired key (`expires_at = 2020-01-01T00:00:00+00:00`) and a valid key (`2099-12-31T23:59:59+00:00`).
2. Run the flow with the expired key → expect `403`.
3. Run the flow with the valid key → expect `200`.

**Validation:** Expired → `403 "Invalid or missing API key"`; valid → `200`.

---

### 28.4 Expiry boundary evaluated in UTC `[x]`

**Objective:** Confirm the expiry comparison is UTC-based and not shifted by the viewer's timezone offset.

**Precondition:** Langflow running; empty flow available.

**Step by step:**
1. Create a key expiring `now + 30 min` (UTC) and a key expiring `now − 30 min` (UTC).
2. Run with the near-future key → expect `200`.
3. Run with the recently-expired key → expect `403`.

**Validation:** Both verdicts correct — the 30-min margins sit inside the ±3h offset window, so a timezone-shifted comparison would flip one of them.

---

*Generated on 2026-03-18 | Source: QA-CHECKLIST.md*
