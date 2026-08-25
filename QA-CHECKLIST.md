# Langflow — Regression Test Checklist

> **Repository:** `C:/QAx/langflow-playwright/langflow-e2e`
> **Tests:** `tests/tests-automations/regression/`
> **Config:** `playwright.config.ts`
> **Last updated:** 2026-08-25

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
- [-] Component sidebar — component navigation bar with searchable parameter support → covered by `ui-ux/sidebar-search-and-filter.spec.ts`, `ui-ux/keyboardComponentSearch.spec.ts`, `ui-ux/sidebar-add-component.spec.ts` (#820: no dedicated nav spec needed — exercised across the sidebar suite; #937 consolidated `sidebar-provider-count` / `sidebar-category-filter` / `sidebar-filter-by-category` into `sidebar-search-and-filter`)
- [-] Model Provider — navigation to the model provider management tab → covered by `ui-ux/settings-navigation.spec.ts` ("Settings Model Providers section loads") (#820)
- [-] API Keys — navigation to the API keys / global variables tab → covered by `ui-ux/userSettings.spec.ts` (API Keys), `ui-ux/global-variable-edit.spec.ts` + `ui-ux/global-variables-crud.spec.ts` (global variables) (#820)
- [-] Templates — navigation to the template selection tab (Starter Projects) → covered by `core-functionality/templates/starter-projects.spec.ts`, `flow-functionality/create-flow-from-template.spec.ts` (#820)
- [x] Import Flow — navigation to import a flow via JSON → `flow-functionality/export-import-flow.spec.ts` (also `flow-functionality/import-invalid-json.spec.ts`; see §12.4) (#820)
- [x] Delete Flow — navigation to delete a flow → `ui-ux/actionsMainPage-shard-1.spec.ts` ("select and delete a flow"); bulk via `core-functionality/project-management/bulk-actions.spec.ts` (#820)
- [-] MCP Config — navigation to configure MCP Server → covered by `mcp/server/mcp-server-tab.spec.ts`, `mcp/server/mcp-server.spec.ts`, `core-components/configure-mcp-and-custom-component.spec.ts` (#820)

---

## Helpers

### Provider Setup

- [-] OpenAI Provider Setup → `helpers/provider-setup/setup-openai.ts`
- [-] Anthropic Provider Setup → `helpers/provider-setup/setup-anthropic.ts`
- [-] Google Generative AI Provider Setup → `helpers/provider-setup/setup-google.ts`
- [-] Provider Map (`providerSetupMap`) — central registration point → `helpers/provider-setup/index.ts`
- [-] Provider validation via API (credit, valid key) → `helpers/provider-setup/collect-models.ts`
- [-] Provider build-axis probe (registry key present + component instantiates) → `helpers/provider-setup/probe-component-buildable.ts`
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

#### 1.3.1 Folder (Project) CRUD via API
- [x] POST `/api/v1/projects/` → creates folder, returns id and name → `api/flows/api-folders-crud.spec.ts`
- [x] GET `/api/v1/projects/` → lists folders including the created one → `api/flows/api-folders-crud.spec.ts`
- [x] DELETE `/api/v1/projects/{id}` → returns 204 and the folder leaves the listing — quarantine lifted 2026-08-11 (#965). It answered **500** (`sqlite3.OperationalError: database is locked`) under concurrent writes with the folder surviving, 44% of deletes on `1.12.0.dev7` vs 6% on stable `1.10.3`; fixed upstream by langflow#14308 (`run_with_lock_retry`, forward-ported to `release-1.12.0`) and re-measured on `1.12.0.dev23` at 24/24 `204` at P=2 and 32/32 at P=4 ([LE-2020](https://datastax.jira.com/browse/LE-2020)). The `204` assertion is unchanged. Same ticket also covered `PATCH /api/v1/flows/{id}` (§12.5, #932) — one root cause, two endpoints → `api/flows/api-folders-crud.spec.ts`

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

#### 1.8 Workflows v2 — Job Lifecycle (1.12)

> `POST /api/v2/workflows` is the run path the product itself uses, and this suite already **observes** it — `tests/fixtures/flow-error-policy.ts` classifies its stream and eight specs trigger it incidentally — but until now nothing **drove it as an API contract**. The submit half was exercised constantly; the read-back half by nothing. Spec doc: `docs/api/flows/workflows-v2-job-lifecycle.md`.

- [-] A batch create with a duplicate name is refused `409 "Name must be unique"` rather than stalling on the SQLite write lock, the body renders no SQL or bound parameters, and the **next write still succeeds** — the last clause is the one that matters: a `409` that left the lock held satisfies every other assertion and is still the defect `langflow-ai/langflow#14634` fixed, because the caller sees a clean conflict and the *next* writer dies with "database is locked" → `api/flows/workflows-v2-job-lifecycle.spec.ts`
- [-] A batch create with a duplicate `endpoint_name` is refused with its **own** message (`"Endpoint name must be unique"`), asserted as not equal to the name guard's — two guards, one status, so the message is the only thing separating them → `api/flows/workflows-v2-job-lifecycle.spec.ts`
- [-] A completed `mode=background` run reports the `session_id` it was submitted with, and its outputs, on the **first** status read that says `completed` — asserted as "not the flow id" too, since the flow id is the specific degradation `langflow-ai/langflow#14512` names → `api/flows/workflows-v2-job-lifecycle.spec.ts`
- [!] A completed `mode=sync` run answers its own status query with the session and outputs it just returned — **declared failing (`test.fail()`) against a live defect, 15/15 on `1.12.0.dev37`**; it flips to an *unexpected pass* the day upstream fixes it, which is the alarm to remove the annotation: the read-back reports `status: "completed"` alongside `session_id == flow_id` and `outputs: {}`, self-healing in 250–463 ms (median 434, 12/12 cold jobs). #14512's fix is present (its `sync_result_storage_enabled` setting reads `False`, the default) but the flag-off path races the `vertex_build` commit it reconstructs from. Detection depends on issuing the two calls back to back — with assertions interleaved between them the defect went unseen in 1 of 13 runs → `api/flows/workflows-v2-job-lifecycle.spec.ts`
- [-] Attribution control: the same sync read-back **is** correct once the job's rows settle (≤10 s). Paired with the row above on purpose — that red plus this green is the race; *both* red would be a strictly worse regression, reconstruction unavailable at any time, and without the pair the two would report as one finding → `api/flows/workflows-v2-job-lifecycle.spec.ts`

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
- [x] Edit input list → `core-components/parameters-panel-field-types.spec.ts`
- [x] Edit table input → `core-components/parameters-panel-field-types.spec.ts`
- [x] Edit slider → `core-components/parameters-panel-field-types.spec.ts`
- [x] Edit tab component → `core-components/parameters-panel-field-types.spec.ts`
- [-] Visibility toggle of a connected input is disabled (tooltip "Cannot change visibility of connected handles") and re-enables once the edge is deleted → `flow-functionality/general-bugs-hidden-input-edges.spec.ts`
- [x] Two nodes on the canvas exposing the same field name render distinct DOM ids, while `data-testid` stays unscoped so both nodes remain selectable (LE-2037 / langflow#14312) → `core-components/duplicate-dom-ids-regression.spec.ts`

#### 2.2 Tool Mode
- [x] Enable Tool Mode on a component → `core-components/tool-mode.spec.ts`
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
- [-] `configureCustomComponent` helper compiles code into a node with its declared interface → `core-components/configure-mcp-and-custom-component.spec.ts`

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
- [x] A value typed on a node (Chat Input as the host) is persisted by the debounced autosave and rehydrated after leaving and re-entering the flow — four consecutive edits, each gated on the server before the exit → `core-components/general-bugs-save-changes-on-node.spec.ts`
- [x] Chat Input cannot be duplicated (`Cmd/Ctrl+D`) or copy/pasted (`Cmd/Ctrl+C`+`V`) — blocked with the "components were not pasted" toast → `core-components/singleton-components.spec.ts`
- [-] File on the advanced `files` field can be removed and re-uploaded; after running, the image and the user message render in the Playground → `flow-functionality/general-bugs-shard-3836.spec.ts`

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
- [x] `include_httpx_metadata=true` adds the outgoing request headers as a top-level `headers` key in the output Data (advanced field, added to the node body via the inspector) → `api/flows/api-component-regression.spec.ts`
- [x] Request timeout shorter than the endpoint's delay returns `status_code` 500 with an `error` field instead of raising (advanced field, added to the node body via the inspector) → `api/flows/api-component-regression.spec.ts`

#### 3.4 Webhook
- [x] POST aceita JSON e text/plain retornando 202 com `status: "in progress"` → `core-components/webhook-component-regression.spec.ts`
- [x] Flow salvo no banco contém o nó Webhook com endpoint="BACKEND_URL" → `core-components/webhook-component-regression.spec.ts` (quarentena de 2½ meses liberada em #990: o teste lia o flow via `page.evaluate(fetch)` e tropeçava no defeito do interceptor de `window.fetch` do frontend; agora lê via `request.get` autenticado)
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
- [-] Generated cURL includes the `x-api-key` header when webhook auth is enabled (mocked `GET /api/v1/config`, auto-login off) → `core-components/general-bugs-component-webhook-api-key-display.spec.ts`
- [-] Generated cURL omits `x-api-key` when webhook auth is disabled → `core-components/general-bugs-component-webhook-api-key-display.spec.ts`

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
- [x] Other numeric operators (`less than`, `less than or equal`, `greater than or equal`) — share the same `float(...)` cast as `greater than` → `core-components/if-else-component-regression.spec.ts`
- [ ] `max_iterations` + `default_route` cycle break (not implementable as a standalone If-Else feedback loop on 1.12.x — Langflow forms graph cycles only via loop-aware target handles (`from_loop_target_handle`, `target_handle.type is None`) that `LoopComponent` ports provide; a feedback edge into the router's regular `match_text` field-input persists in the flow JSON but does not make the graph iterate (`is_cyclic` stays false, router runs once). `conditional_router.py`'s cycle-break only fires when the router already sits inside a Loop-created cycle. Confirmed live on 1.12.0.dev3; product finding filed upstream; #891, follow-up of #822)

#### 3.9 Human Input (HITL, 1.11.0)
- [x] Human Input node config: default Approve/Reject branch handles, custom User Action creates a new handle, configured handles persist after save + reload → `core-components/human-input-node-config.spec.ts`

#### 3.10 Data Operations (1.11.0)
- [x] Data Operations component: unified JSON/Table/Text operations produce correct outputs per operation mode (Text→Message, Word Count→JSON override, JSON Select Keys, Table Filter) → `core-components/data-operations-component.spec.ts`
- [x] Legacy operations components link/redirect to Data Operations (banner resolves the replacement, link filters the sidebar, old names still find the new component, legacy flows keep working) → `core-components/data-operations-legacy-link.spec.ts`

---

## core-functionality/ — Core and Operational Logic

### core-functionality/auth/ — Authentication and User Management

#### 4.1 Login / Logout
- [x] Login with valid credentials — through the form with auto-login mocked off; every form login rides `helpers/auth/sign-in-through-form.ts`, which absorbs the endpoint's per-IP 5/min budget → `core-functionality/auth/auto-login-off.spec.ts`
- [x] Login with invalid credentials — should display error message → `core-functionality/auth/login-invalid-credentials.spec.ts`
- [x] Logout — should redirect to login screen → `core-functionality/auth/logout-flow.spec.ts`
- [x] Auto-login enabled — should skip login screen (and `/login`, `/admin`, `/admin/login` do not break the auto-logged app) → `core-functionality/auth/autoLogin.spec.ts`
- [x] Auto-login disabled — should display login screen → `core-functionality/auth/auto-login-off.spec.ts`
- [x] Expired session — should redirect to login: invalid/absent token refused at the API plus the UI falling back to the form, with a valid-token control → `core-functionality/auth/session-expired.spec.ts`
- [x] Session cleanup after logout — after logging out, navigating to `/` and reloading both stay on the login screen → `core-functionality/auth/logout-flow.spec.ts`
- [-] `POST /api/v1/login` is rate-limited: repeated attempts are refused `429` with a `retry_after` body field and a matching `retry-after` header, a **successful** login does not reset the counter (the check runs before authentication, so brute force cannot be made free by interleaving a good login), and the limiter reopens after the window it advertised. **`@destructive`**: the budget is keyed on the client address and is instance-global, so exhausting it would hand a `429` to the eight specs that authenticate through this endpoint — which also means it does not run in the daily → `core-functionality/auth/login-rate-limit.spec.ts`

#### 4.2 User Management (Admin)

> **The OSS Admin Page is gone** (`langflow-ai/langflow#14276`, 2026-08-05) — user
> management in OSS is the API, `/api/v1/users/`, and the specs below drive it
> there. `admin-user-management.spec.ts` also pins the removal itself (no menu
> item, no admin route), so an Enterprise admin UI leaking back into the OSS
> bundle is a named failure.

- [x] Admin creates new user — `201`, inactive by default, and the pending user's login is refused `400 "Waiting for approval"` → `core-functionality/auth/admin-user-management.spec.ts`
- [x] Admin deactivates user — the identical credentials flip back to refused, `401 "Inactive user"` (the deactivated-after-use branch, distinct from the pending one) → `core-functionality/auth/admin-user-management.spec.ts`
- [x] Admin activates inactive user — the identical login flips to `200` with an `access_token` → `core-functionality/auth/admin-user-management.spec.ts`
- [x] Admin renames user — the new username logs in with the unchanged password and the old one is refused → `core-functionality/auth/admin-user-management.spec.ts`
- [x] Admin changes user password → `core-functionality/auth/admin-password-change.spec.ts`
- [x] Admin changes password — old password does not work after change (with a works-before control) → `core-functionality/auth/admin-password-change.spec.ts`
- [x] Isolation flow: user A cannot see user B's flows — both directions, exact random names → `core-functionality/auth/auto-login-off.spec.ts`
- [x] The OSS build offers no Admin Page — menu and `/admin` route both, pinning `langflow-ai/langflow#14276` → `core-functionality/auth/admin-user-management.spec.ts`

#### 4.3 Global Variables (API Keys)
- [x] Create global variable
- [-] Use global variable in component (API key) → `ui-ux/use-global-variable-in-component.spec.ts`
- [x] Edit existing global variable — quarantine lifted 2026-08-11 (#1235). The row click was silently dropped while the RBAC permission query loaded, so the Update Variable modal never opened (dailies 2026-07-27 and 2026-08-03, [LE-2123](https://datastax.jira.com/browse/LE-2123)); fixed upstream by langflow#14404 (permission loading state) and re-validated on `1.12.0.dev23`. The provider-credential removal below (§7.5) was grouped here at triage and proved to be a separate *test* defect, fixed in #1276 → `ui-ux/global-variable-edit.spec.ts`
- [x] Delete global variable → `ui-ux/global-variables-crud.spec.ts`
- [x] Create global variable of type "Generic" → `ui-ux/global-variables-crud.spec.ts`
- [x] Credential variable value is hidden from the variable list → `ui-ux/global-variables-crud.spec.ts`
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

#### 6.1 llm-agents/agent-component-regression.spec.ts — Agent Behavior Regression `@stable`
- [x] Agent responds without connected tools
- [x] Agent displays valid response and optionally reasoning steps
- [x] Stop button interrupts agent execution
- [x] Execution duration displayed after successful run
- [x] Response displayed progressively in the Playground (streaming)
- [x] Duration indicator displayed on canvas (`node_duration_agent`) after closing the playground
- [x] Agent responds to multiple consecutive messages in the same session

#### 6.2 Other execution tests
- [ ] ~~Composio (tool integration for Agent)~~ — **out of scope (2026-08-06):** Composio is a separately-shipped vendor bundle, and this QA team no longer supports that surface. `composio.spec.ts` exists but must not be promoted: doing so would count coverage the team does not sustain. See `docs/coverage-heatmap/` — vendor bundles are the single largest source of upstream defects (227 issues) and are excluded from the risk model for the same reason
- [x] Playground shows error when LLM run endpoint returns 500 (mocked invalid API key) → `llm-agents/llm-invalid-api-key-ui.spec.ts`
- [x] Playground input remains usable after API error (mocked) → `llm-agents/llm-invalid-api-key-ui.spec.ts`
- [x] Agent stops when configured stop condition is reached → `core-functionality/llm-agents/agent-max-iterations.spec.ts` (`max_iterations` is the Agent's only configurable stop mechanism — no dedicated stop-condition field exists; see #824)
- [x] Agent stops when maximum number of iterations is reached → `core-functionality/llm-agents/agent-max-iterations.spec.ts` (**quarantine lifted, #1264 was a test defect:** the cap IS enforced on 1.12.0.dev23 — `Model call limits exceeded: run limit (1/1)` in 3.3s once the fetch target became one the URL tool can actually reach. The old target was the instance's own SSRF-blocked `/api/v1/version`, which put every run on the tool-error path where LangGraph's `recursion_limit` (`max_iterations * 2 + 5`) fires before the model-call cap — measured on the 2026-08-12 daily as `Recursion limit of 45 reached`, 733,990 tokens over 11 calls and no final message. Both halves of the causal pair are now `@stable`)
- [x] Agent with multiple configured tools executes correctly → `agent-multi-tool-selection.spec.ts`
- [ ] Agent with configured timeout respects the limit (no product surface on 1.12.x — the Agent component exposes no timeout field: its inputs are `max_iterations`, `max_tokens`, `n_messages`, `system_prompt`, `context_id`, `stream`, and tools; Langflow's only configurable per-component timeouts live on the A2A Agent (`timeout`) and MCP tools (`tool_execution_timeout`), not the Agent, and the Language Model / chat models expose none either. The client/transport execution timeout that bounds any run is covered by `ui-ux/execution-error-notification.spec.ts`. Not automatable as written; #825, same class as #824)
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
- [x] Agent executes multiple tools in sequence → `llm-agents/agent-multi-tool-selection.spec.ts` (Test 3 — chained fetch→search, ordered `tool_use` assert; `@stable` since #1449. All three gates it carried are settled: the clean baseline of #818/#827 closed 2026-07-30, the unbounded Web Search payload `langflow-ai/langflow#14469` closed by `#14489` on 2026-08-10 — 17.9× smaller per call from `1.12.0.dev25` — and the missing OpenAI measurement, now 4 clean whole-file runs on `gpt-4o-mini` at `dev25` plus green CI runs on google and anthropic)
- [x] Tool returns error — agent handles it and continues execution → `core-functionality/llm-agents/agent-tool-error-handling.spec.ts`
- [x] Multiple connected tools — agent selects the correct one for each prompt → `agent-multi-tool-selection.spec.ts`
- [x] Tool with invalid name — validation prevents execution with clear message → `core-functionality/llm-agents/agent-tool-name-validation.spec.ts`

#### 6.5 Output and Reasoning
- [-] Inspect tools used by Agent in Playground → `llm-agents/agent-tool-inspection.spec.ts` (UI chip names the tool + persisted `tool_use` input/output; `@stable` gated on the clean baseline #818, per #827)
- [x] Agent returns output in structured JSON format (output_schema) → `agent-structured-output.spec.ts`
- [-] Agent returns output in correctly rendered Markdown → `llm-agents/agent-markdown-output.spec.ts`
- [x] Agent Instructions (system prompt) is respected in the model response → `agent-system-prompt.spec.ts`
- [x] Input via direct field vs handle (ChatInput) — both work → `core-functionality/llm-agents/agent-input-sources.spec.ts`
- [x] Empty response or model refusal — component does not crash → `core-functionality/llm-agents/agent-empty-refusal-response.spec.ts`
- [x] Toggle add_current_date_tool works (enables/disables date tool) → `agent-current-date-tool.spec.ts`
- [~] handle_parsing_errors=False fails explicitly vs True auto-corrects → `agent-parse-error-behavior.spec.ts` (**partially covered on 1.11**: the field is present and togglable, but True/False are behaviorally identical — the field now only toggles `ToolRetryMiddleware`, and component-tool failures are converted to content by the hardcoded `handle_tool_error=True` before the middleware can observe them; the only live trigger (LLM-emitted malformed args) is non-deterministic, so the semantic difference is not deterministically testable — re-scope tracked in #496)
- [x] Image passed via input handle is processed correctly → `core-functionality/llm-agents/agent-multimodal-image-input.spec.ts`
- [x] Image attached in the Playground is processed by the Agent — the attachment renders in the user message and the reply describes it → `core-functionality/llm-agents/general-bugs-agent-images-playground.spec.ts` (`@stable` restored in #992 — the OpenAI quota that caused the #772 quarantine is back)
- [-] A math prompt typed in the Playground reaches the Agent run exactly once — the user message reads `2+2` (never `2+22+2`) and the answer is `4`, never `26` → `core-functionality/llm-agents/general-bugs-agent-sum-duplicate-message-playground.spec.ts` (not `@stable`: #1465 repaired it after it sat broken on `main` unnoticed, so promotion waits for green dailies)

---

### core-functionality/model-provider/ — Provider Management

> ⚠️ Provider configuration tests via Settings use `SettingsPage`.
> See `helpers/provider-setup/` for the setup helpers of each provider.

#### 7.1 Provider Collection and Validation
- [x] Validate API keys of all providers via real call → `collect-models.spec.ts`
- [x] Validate the running build can instantiate each provider's component (registry + build, not just the key) → `collect-models.spec.ts`
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
- [x] Remove API key from existing provider — both paths validated. The UI path was quarantined (#1235) as a Global Variables permission-gate flake and is not one: the deletion already succeeded, and the spec then re-clicked the now-disabled header button through a phantom confirmation step. Fixed by asserting the header action is enabled and scoping the confirmation to a real dialog → `llm-agents/remove-provider-api-key.spec.ts`
- [x] Per-model enable/disable toggle changes immediately and persists across reopen → `llm-agents/model-provider-model-toggle.spec.ts`
- [x] Disabling a model in Settings removes it from a component model dropdown; re-enabling restores it → `llm-agents/model-provider-model-toggle.spec.ts`

#### 7.6 Open-Source Providers
- [x] Configure and execute flow with Ollama (local model) → `model-provider/ollama-provider.spec.ts` (both halves `@stable` again after #931: the `lfx-ollama` packaging gap that broke it on 07-23/24 is fixed upstream, a build-side bundle pre-flight now fails attributed instead of timing out blind for 30 s, the run-completion wait was rebuilt on the `button-stop`/`button-send` signal — the 07-15 failure mode — and the test model is derived from the instance instead of a hardcoded tag that could skip silently. Restored on 4 consecutive green `manual.yml` runs on `1.12.0.dev9`, not on local evidence)
- [-] Configure and execute flow with Groq → `model-provider/groq-provider.spec.ts` (automated but not validatable on the tested image: the Groq component ships in the `lfx-bundles` distribution, which `langflowai/langflow-nightly:latest` does not install, so the spec's availability pre-flight skips it on every run — `@stable` removed, see #1039)
- [-] Configure and execute flow with Mistral → `model-provider/mistral-provider.spec.ts` (automated but not validatable on the tested image: same `lfx-bundles` packaging decision as Groq — `@stable` removed, see #1039)

#### 7.7 Model Parameters (Agent)
- [x] Maximum token count — response truncated as configured → `llm-agents/agent-max-tokens.spec.ts`
- [x] Maximum agent iterations → `core-functionality/llm-agents/agent-max-iterations.spec.ts` (both halves of the causal pair `@stable` since #1264's fix; see §6.2 for the measurement)
- [x] Use of custom `context_id` for memory isolation → `agent-context-id-isolation.spec.ts`
- [x] Output formatting (JSON via output_schema, Markdown, plain text) → `agent-structured-output.spec.ts`

#### 7.8 Unified Provider Setup — 1.11.0 additions
- [x] OpenAI Compatible as a first-class unified model provider: setup with base URL + key, models discovered, usable by a flow → `core-functionality/model-provider/openai-compatible-provider-setup.spec.ts` (6 tests, **all 6 `@stable`**, validated on 1.12.0.dev23 against `https://api.openai.com/v1` — the endpoint the issue itself suggests, so **no new CI secret**: the base URL defaults there and the bearer is the existing `OPENAI_API_KEY`, overridable via `OPENAI_COMPATIBLE_TEST_BASE_URL` / `_API_KEY` / `_MODEL`. Covered: the two-variable form with its asymmetric required/optional Save gate; the live-only catalog — this is the first provider with **no static rows at all**, so unconfigured it contributes 0 models, asserted differentially against Azure AI Foundry's seed catalog in the same run; an unresolvable `.invalid` base URL and a real endpoint with a bogus key both rejected on the `validate-provider` **body** (HTTP 200 + `valid:false`, DNS vs `Authentication failed for the OpenAI-compatible endpoint`) with nothing persisted; live discovery returning **exactly** the endpoint's own `/v1/models` id set, twice over (once per model type), polled on that terminal shape because the catalog is recomputed per request and a stalled endpoint silently costs a whole half of it — 8 of 30 reads a full minute after configuring, discovery's 5 s timeout degrading to `[]` without raising, which is what #1364 measured and what the 2026-08-07 `num_models 248 → 124` red actually was; one discovered id — enabled for the provider by the test itself, since a `default:false` id never reaches the node's dropdown — running a Basic Prompting flow to a sentinel reply, gated on the **persisted** node carrying `{name, provider: "OpenAI Compatible"}` rather than a stored credential name, which upstream [#14311](https://github.com/langflow-ai/langflow/pull/14311) stopped writing (#1334); and configuring the provider through Settings persisting **both** variables — quarantined against [LE-2124](https://datastax.jira.com/browse/LE-2124) (the concurrent `POST /api/v1/variables/` writes dropped the key, silently) and **un-quarantined on 1.12.0.dev19**, where concurrent API writes answer 201/201 3/3 and the test passes 3/3 with its assertions unchanged)
- [x] Azure AI Foundry in the unified provider setup: configuration accepts deployment names, provider appears configured → `core-functionality/model-provider/azure-ai-foundry-provider-setup.spec.ts` (6 tests, all validated against a live Azure resource on 1.12.0.dev15 — 3/3 clean `--retries=0 --workers=1` runs, every test force-failed. 4 of them need **no** Azure account and carry the surface on every lane: the two-variable form, the Foundry-only deployment hint asserted differentially against OpenRouter, the read-only unconfigured panel, an unresolvable endpoint rejected with `valid:false` and nothing persisted, and a deployment name absent from every catalog accepted and stored as `Azure AI Foundry::llm::<name>`. The other two — real credentials configuring the provider through Settings, and a real inference addressed by the deployment name — now run there too: the three `AZURE_AI_FOUNDRY_*` secrets are wired into the daily shard step and `manual.yml`'s Docker job by #1270, proven by a dispatch that reported `6 passed` where the lane had said `4 passed, 2 skipped`. They still skip with the concrete reason wherever the credentials are absent — a local run without the `.env` block, `pr-validation.yml` and the external-URL job, both unwired on purpose: #1216 keeps an unrelated PR off that account's health, and #1055 keeps us from storing our credentials in an instance we do not own)

---

### core-functionality/observability-monitoring/ — Tracing, Logs and Metrics

#### 8.1 Traces
- [x] View execution traces → `core-functionality/observability-monitoring/traces.spec.ts`
- [x] Trace API returns paginated transactions → `core-functionality/observability-monitoring/traces-detail.spec.ts`
- [x] Trace displays latency of each component → `core-functionality/observability-monitoring/traces-latency-tokens.spec.ts` (API `totalLatencyMs`, Flow Activity latency column, per-span latency in the Trace Details modal)
- [x] Trace displays tokens consumed → `core-functionality/observability-monitoring/traces-latency-tokens.spec.ts` (API `totalTokens` + Flow Activity token column)
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
- [-] Attach and send an image on a live LLM flow (Basic Prompting) — the image renders in the chat messages → `core-functionality/llm-agents/chatInputOutputUser-shard-0.spec.ts`
- [-] Custom `sender_name` on Chat Input/Output is applied to a live LLM turn — messages render as `chat-message-<custom name>` after a default-label turn → `core-functionality/llm-agents/chatInputOutputUser-shard-2.spec.ts`

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

#### 9.6 Human-in-the-Loop (1.11.0)
- [x] Human Input suspends the run server-side, decision card renders in the Playground, Approve routes only the approved branch and the run leaves the suspended state; Reject routes only the reject branch → `core-functionality/playground/human-input-pause-resume.spec.ts`
- [ ] A suspended Human Input run is recoverable after a page reload (durable execution outliving the tab)

---

### core-functionality/project-management/ — Project and Folder Management

#### 10.1 Folder CRUD
- [x] Create new folder → `core-functionality/project-management/folder-crud.spec.ts`
- [x] Rename folder → `core-functionality/project-management/folder-crud.spec.ts`
- [x] Delete empty folder → `core-functionality/project-management/folder-crud.spec.ts`
- [x] Delete folder with flows inside → `core-functionality/project-management/folder-crud.spec.ts`
- [x] Integrity after deletion — the deleted folder leaves the sidebar immediately, the page stays functional, and a sibling folder is untouched and still clickable → `core-functionality/project-management/folder-deletion-integrity.spec.ts`
- [x] Create folder after deleting all folders — creating a folder right after a deletion works (no stale-cache collision) → `core-functionality/project-management/folder-deletion-integrity.spec.ts`
- [-] Deleting every folder lands on the empty-project screen (sidebar empty message + `new_project_btn_empty_page`) → `core-functionality/project-management/folder-deletion-integrity.spec.ts` (`@destructive` — account-wide wiper, runs only in the low-concurrency lane via `PW_DESTRUCTIVE=1`, see #1010; stays `[-]` permanently, since `[x]` requires `@stable` and `@destructive` must never carry it — the pair would mean "runs nowhere")
- [-] Upload flow by drag-and-drop to folder — dropping a collection file imports one flow per entry; dropping a single flow file imports exactly one → `flow-functionality/dragAndDrop.spec.ts`
- [-] Move flow to another folder

#### 10.2 Folder Navigation
- [-] Navigate between folders → `core-functionality/project-management/flow-navigation-between-folders.spec.ts`
- [-] Search flow by name filters results correctly
- [-] Folders in navigation sidebar

---

### core-functionality/templates/ — Predefined Flow and Component Models

#### 11.1 Basic Templates

> **Corrected 2026-08-06.** This block listed all 7 entries **twice** — once plain, once
> bold with a `core/integrations/*.spec.ts` reference. That path is **Langflow's own
> upstream test suite**, not this repo, so those references were never automation of ours.
> The duplicates are removed and each entry now carries its real state.
>
> `[~]` here means the template is **instantiated and run** by specs that assert something
> else (33 specs open *Basic Prompting* from the gallery, 20 open *Simple Agent*), so its
> creation path is exercised while nothing asserts the template's own behaviour.

- [~] Basic Prompting (OpenAI) — instantiated from the template gallery by 33 specs as a fixture; no assertion on the template itself
- [ ] Basic Prompting (Anthropic) — the provider variant is never exercised
- [~] Simple Agent (OpenAI) — instantiated by 20 specs as a fixture
- [ ] Simple Agent (Anthropic)
- [ ] Simple Agent with memory
- [ ] Vector Store RAG
- [x] Memory Chatbot → `llm-agents/memory-history-regression.spec.ts`

#### 11.2 Content Generation Templates

- [ ] Blog Writer
- [ ] Instagram Copywriter
- [ ] Twitter Thread Generator
- [ ] SEO Keyword Generator
- [~] Portfolio Website Code Generator — opened from the gallery by `ui-ux/refresh-dropdown-list.spec.ts`; nothing asserts the template
- [ ] SaaS Pricing

#### 11.3 Analysis and Processing Templates

- [ ] Document QA
- [ ] Invoice Summarizer
- [ ] Financial Report Parser
- [ ] Image Sentiment Analysis
- [ ] Text Sentiment Analysis
- [ ] Youtube Analysis

#### 11.4 Agent Templates

- [ ] Dynamic Agent
- [ ] Hierarchical Agent
- [ ] Sequential Task Agent
- [ ] Social Media Agent
- [ ] Travel Planning Agent
- [ ] Market Research
- [~] Research Translation Loop — driven as the fixture of `core-components/loop-component-regression.spec.ts` (ArXiv loop), which asserts the Loop component, not the template
- [ ] Pokedex Agent
- [ ] Price Deal Finder
- [ ] News Aggregator

#### 11.5 Advanced Templates

- [ ] Custom Component Generator
- [ ] Prompt Chaining
- [ ] Decision Flow
- [ ] Similarity
- [x] MCP Server (starter projects) → `mcp/server/mcp-server-starter-projects.spec.ts` (same coverage recorded in §14.1)

---

### core-functionality/a2a/ — Agent-to-Agent Protocol (1.11.0)

> ⚠️ Every bullet below needs `LANGFLOW_A2A_ENABLED=true` on the instance — the flag is off by default (`lfx/services/settings/groups/mcp.py`), and with it off all three `/api/v1/a2a/*` routes answer `404` and the flow editor's Agent tab only renders "A2A is turned off on this server". Surface map, testability decisions and the full out-of-scope list: `docs/core-functionality/a2a/a2a-coverage-scope.md` (scoping issue #1195, upstream `langflow-ai/langflow#13831`, Jira epic `LE-1588`). Numbering starts at 16 because §12–§15 are already taken; the section sits here, with its area, on purpose.

#### 16.1 A2A Server
- [x] Agent card served for a published flow — `GET /api/v1/a2a/{flow_id}/.well-known/agent-card.json` returns `protocolVersion="0.3.0"`, `url` ending in `/api/v1/a2a/{flow_id}/jsonrpc`, `capabilities.streaming=true`, `defaultInputModes=["application/json"]`, `skills[0].id === flow_id`, `skills[0].tags=["langflow"]` and an `inputSchema` object → `core-functionality/a2a/a2a-server-agent-card.spec.ts`
- [x] Card overrides applied — `a2a_card_overrides` (name / version / description / tags / examples) change exactly those card fields and nothing else → `core-functionality/a2a/a2a-server-agent-card.spec.ts`
- [x] Card gated on publication state — `a2a_enabled=false`, `flow_type=workflow` and an unknown flow id each return `404` (indistinguishable from an unmounted route, by design) → `core-functionality/a2a/a2a-server-agent-card.spec.ts`
- [x] Agent discovery list — `GET /api/v1/a2a/agents` lists the published flow with a `cardUrl` that resolves `200`, omits a `flow_type=workflow` flow and an `agent` flow with `a2a_enabled=false`, and drops the row when the flow is unpublished (owner-scoped, not a cross-user directory) → `core-functionality/a2a/a2a-server-discovery.spec.ts`
- [x] JSON-RPC `message/send` round-trip — a per-run sentinel sent to a Chat Input→Chat Output passthrough comes back in the task's artifact text with state `completed` (no LLM involved) → `core-functionality/a2a/a2a-server-jsonrpc-message-send.spec.ts`
- [x] JSON-RPC error envelopes — an unknown method returns `-32601` and a malformed envelope `-32600`/`-32700`, both over **HTTP 200** (JSON-RPC-level errors are not HTTP errors here) → `core-functionality/a2a/a2a-server-jsonrpc-message-send.spec.ts`
- [x] Multi-turn context continuity — the first `message/send` response carries a server-minted `contextId`; reusing it on a second call returns the same `contextId` with a new task id and lands in the same stored session (`session_id` is the composite `<uuid>:<contextId>` in `GET /api/v1/monitor/messages`, carrying both turns as `User`/`Machine` pairs), while a call without it mints a different one → `core-functionality/a2a/a2a-server-multi-turn-context.spec.ts`
- [x] Task lifecycle — `tasks/get` reads the `message/send` task back with the same `artifactId` and `status.timestamp` (a read-back, not a re-run); an unknown id is `-32001 "Task not found"` and a cancel on a finished task `-32002 "Task cannot be canceled"` with the stored state untouched, both over **HTTP 200**; a task id cancelled through another flow's endpoint is `-32001` (never `-32002`, which would confirm it exists); and a `message/stream` run cancelled mid-flight reports `canceled` from both `tasks/cancel` and `tasks/get` → `core-functionality/a2a/a2a-server-tasks-lifecycle.spec.ts`
- [x] API-key auth gate on the JSON-RPC endpoint — with the flow's project set to `auth_type=apikey`, the card advertises the `x-api-key` scheme in `securitySchemes`, a call with no header returns `401 "API key required"`, a wrong key `401 "Invalid API key"`, and the owner's key `200` + `completed` (the gate `LE-2081` lives behind; auth derives from the **project**, not the flow). The same flow is asserted **before and after** it is moved into the restricted project — one id crossing the boundary, so the `401` cannot be blamed on the flow, the graph, the server flag or the environment → `core-functionality/a2a/a2a-server-auth-apikey.spec.ts`
- [x] Agent tab publish flow — a blank flow shows `Unavailable` with the copy "Add a chat input and output to serve this flow." and cannot publish; adding Chat Input + Chat Output (unwired — the two node types are the gate) enables `agent-publish-switch`; publishing shows status `Live` and the `agent-card-url` that `404`d as a draft now fetches `200`; editing Name and adding a tag then pressing `agent-save` updates `agent-card-name` **and** changes `name` / `skills[0].name` / `skills[0].tags` on the card the API serves. The "Agent updated" toast is **not** asserted — measured transient (<3 s), so the durable pair is the status chip plus the served card → `core-functionality/a2a/a2a-server-agent-tab-publish.spec.ts`
- [~] Agent tab "Try it" panel — a sentinel sent from the panel over the live endpoint appears in `agent-transcript` **twice** (user turn + the agent's echo), the state reaches `completed`, the turn counter reads `1 turn` and a `Reset` control is present → `core-functionality/a2a/a2a-server-agent-tab-try-it.spec.ts`. **Partial:** "View JSON-RPC exchange" is not covered because it is not implemented — `agentTab.viewExchange` appears exactly once per locale bundle in the shipped frontend (the dictionary entry) with zero call sites, and the string is absent from the DOM after a completed turn (measured on `1.12.0.dev14`, #1244); pending an upstream question
- [ ] Non-owner cannot publish a flow — `PATCH /api/v1/flows/{id}` flipping `a2a_enabled` returns `403 "Cannot change a2a_enabled of a flow you do not own."` (not automatable: needs two real users, and per-test user isolation is impossible under `AUTO_LOGIN` — measured in #1010)
- [ ] Disabled-server state — all three `/api/v1/a2a/*` routes `404` and the Agent tab renders "A2A is turned off on this server. Set LANGFLOW_A2A_ENABLED=true…" (out of scope by lane decision on #1195: the flag is on in every lane, and an off-lane cannot coexist with it in the same run; revisit only as a dedicated `PW_A2A_OFF=1` lane)
- [ ] Push notification config and delivery — `tasks/pushNotificationConfig/{set,get,list,delete}` (out of reach: proving delivery needs a receiver with an inspectable inbox, which the self-hosted `go-httpbin` echo endpoint does not provide — `LE-1706`)
- [ ] JWS-signed agent cards (`LE-1718`) and rate limiting on the public endpoints (`LE-1701`) (out of reach: no URL-observable surface for the signature; driving the global v1 rate limits would make every parallel lane flaky)

#### 16.2 A2A Client
- [x] A2A Agent component, Internal mode — the `mode=Internal` dropdown lists the locally published agent and a run returns a `Response` containing the sentinel the published passthrough flow echoes (no LLM on either side). The node opens in **External**, so the mode tab must be clicked for the picker to exist at all, and the dropdown is **folder-scoped** (`list_a2a_agents_by_flow_folder`), so both flows live in the same project. Asserted through a wired `Chat Output` in the playground, **not** the node's output modal: `output-inspection-response-a2aagent` reads "No Data Available" even after a successful run whose stream carried `outputs.response.message` (measured 3× on `1.12.0.dev18`, candidate product defect recorded in the spec doc) → `core-functionality/a2a/a2a-client-agent-internal.spec.ts`
- [ ] A2A Agent component, External mode — pointed at this instance's own card URL, the `agent_card` display renders the card chips (name; "Requires an API key" when the project is restricted) and a run returns the echoed sentinel; `@regression` for `LE-1845` (`NameError: name 'call_a2a_agent' is not defined`). Blocked until a loopback self-call is allowed past Langflow's SSRF layer (`LE-1904` class) — if it cannot be, `LE-1845` stays uncovered
- [ ] A2A Agent used as a Tool — an Agent with the `A2AAgent` wired as a tool (`tool_mode`) calls the published agent and the reply reaches the playground; `@regression` for `LE-1963` (`self.user_id is None` → "badly formed hexadecimal UUID string" on tool-approval resume). The only LLM-dependent bullet of the area — `--workers=1` + `models.json`

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
- [-] Import flow with outdated components → `flow-functionality/import-outdated-flow.spec.ts`
- [x] Import invalid JSON — should display error message → `flow-functionality/import-invalid-json.spec.ts`

#### 12.5 Flow Operations
- [x] Lock flow — prevents editing → `flow-functionality/lock-flow.spec.ts`
- [x] Unlock flow → `flow-functionality/flow-lock.spec.ts`
- [x] Move flow between folders via API — quarantine lifted 2026-08-11 (#932). Under concurrent writes `PATCH /api/v1/flows/{id}` answered **500** (`sqlite3.OperationalError: database is locked` on `UPDATE flow SET folder_id`) and the flow did not move (14/24 at 2 clients, 0/30 serial). **Same root cause as #965** — the daily artifact shows the failing assert is `expect(patchRes.status()).toBe(200)` receiving 500, not a stale `folder_id`. Tracked under [LE-2020](https://datastax.jira.com/browse/LE-2020); `api/v1/flows.py` now wraps its update path in `run_with_lock_retry` and `1.12.0.dev23` measures 32/32 `200` with the association persisted at P=4. The `200` assertion is unchanged → `api/flows/api-folders-crud.spec.ts`
- [x] Publish flow → `flow-functionality/publish-flow.spec.ts`
- [x] Save flow components as template → `core-components/saveComponents.spec.ts`

#### 12.6 Flow Execution
- [x] Run Flow component executes another flow — `@stable` restored 2026-08-11 (#966). The upstream `New Flow` dead-click defect ([LE-2019](https://datastax.jira.com/browse/LE-2019)) is fixed by langflow#14349, present on the nightly line; the shared helper still gates on the flows list having rendered. Hardened for #1548 (daily 2026-08-21 flow-selector click intercepted by two overlays): the spec now seeds the assistant-onboarding suppression (#1220) and drags the Run Flow node to the upper-right canvas region so the flow-name popup stays clear of the canvas-controls band; re-validated on `1.12.0.dev33` → `flow-functionality/run-flow.spec.ts`
- [x] Run a flow from the canvas — terminal-node run builds the whole graph; all nodes reach build success and output is produced → `flow-functionality/flow-execution-canvas.spec.ts`
- [x] Stop building flow → `flow-functionality/stop-building.spec.ts`
- [ ] A cyclic graph is refused with a cycle-specific error, and the flow stays editable afterwards (the engine's own contract; a total engine failure is caught indirectly by the 63 `@stable` specs that trigger a run, a subtle one by nothing)
- [ ] Partial failure — when one branch of a multi-branch graph raises, the branches that do not depend on it still produce their output, and the failed node is the one flagged
- [ ] Execution order respects data dependency — a node that consumes another's output never builds first (asserted on the run stream, not on wall-clock timing)
- [ ] A node whose upstream produced no value is skipped rather than run with an empty input
- [!] Playground button disabled with empty flow — needs review → `regression/flow-functionality/generalBugs-shard-3.spec.ts` (**test skipped: assertion was a no-op, current Langflow behavior to confirm**)

---

## mcp/ — Model Context Protocol

> ⚠️ Tests that execute agents via MCP must use `SimpleAgentTemplatePage` and `models.json`.
> See `CLAUDE.md` in this folder for the complete guide.

### mcp/client/ — Tool and Context Consumption

#### 13.1 MCP Client
- [x] Configure connection with external MCP server (stdio or HTTP) → `mcp/client/mcp-client-regression.spec.ts`
- [x] List available tools via MCP protocol → `mcp/client/mcp-client-regression.spec.ts`
- [x] Execute MCP server tool and receive result in flow → `mcp/client/mcp-client-regression.spec.ts`
- [x] MCP server connection error — unreachable server produces empty tool dropdown → `mcp/client/mcp-client-regression.spec.ts`
- [x] Configure connection via HTTP form tab → `mcp/client/mcp-client-regression.spec.ts`
- [-] `configureMcpServer` helper registers an MCP server via the HTTP form → `core-components/configure-mcp-and-custom-component.spec.ts`
- [x] Execute numeric tool with inputs and verify result → `mcp/client/mcp-client-regression.spec.ts`
- [x] Duplicate MCP server registration returns 409 Conflict → `mcp/client/mcp-server-registration-status-codes.spec.ts`
- [x] Deleting a non-existent MCP server returns 404 Not Found → `mcp/client/mcp-server-registration-status-codes.spec.ts`
- [-] Agent uses MCPTools as tool and calls echo via MCP → `mcp/client/mcp-client-agent.spec.ts` (automated, not `@stable` — no lane runs it, so it cannot report a regression; #1371)
- [x] Gemini × MCP tool-calling regression — agent invokes the echo MCP tool (regression for fixed upstream #440) → `mcp/client/mcp-client-agent-gemini-tool-regression.spec.ts`
- [ ] List available resources via MCP protocol (client not-implementable on 1.11.x — MCPTools component and v2 client API expose tools only; server-side resources covered in §14.1 → `mcp/server/mcp-server-resources.spec.ts`)
- [ ] Consume resource URI and inject content into flow (client not-implementable on 1.11.x — no client resource surface; server-side read covered in §14.1 → `mcp/server/mcp-server-resources.spec.ts`)

---

### mcp/server/ — Resource and Tool Provider

#### 14.1 MCP Server
- [x] MCP Server tab in flow → `mcp/server/mcp-server-tab.spec.ts`
- [x] Add MCP server via modal → `mcp/server/mcp-server-tab.spec.ts`
- [x] Starter project with MCP → `mcp/server/mcp-server-starter-projects.spec.ts`
- [x] Flow exposed as MCP server — verify generated endpoint, and that the transport takes an API key: the same `initialize` with no credential is refused `403` (#1522) → `mcp/server/mcp-server-protocol.spec.ts`
- [x] Execute MCP server tool via MCP protocol → `mcp/server/mcp-server-protocol.spec.ts`
- [x] Register an external MCP server through the stdio form — `command` + `args` resolves the server's real tools into the MCPTools node → `mcp/server/mcp-server.spec.ts`
- [x] Add-server modal fields persist across save → reopen-for-edit — stdio (name, command, 4 args, 2 env pairs) and HTTP/SSE (name, URL, 2 headers, 2 env pairs) → `mcp/server/mcp-server.spec.ts`
- [x] Tool list refreshes when a registered server is edited to run a different package → `mcp/server/mcp-server.spec.ts`
- [x] stdio `command` must be a single executable — a command with an embedded argument is refused and the same registration split into `command` + `args` is accepted (upstream hardening `#14073`; #1091) → `mcp/server/mcp-server.spec.ts`
- [x] The project's own Streamable HTTP endpoint registers as an MCP server and exposes its flows as tools → `mcp/server/mcp-server.spec.ts`
- [-] Resource exposed by server is accessible via URI — flow files are exposed as MCP resources: `resources/list` is `@stable`; `resources/read` blocked by a live Langflow regression on 1.12.x (`AttributeError: 'str' object has no attribute 'hex'`, filed upstream **LE-2012**) — kept as a guard, not promoted → `mcp/server/mcp-server-resources.spec.ts`
- [~] Install this project into an MCP client — `GET /{project_id}/installed` reports the current state and the auto-install list reflects it → `mcp/server/mcp-server-install.spec.ts`. **Partial:** `POST /{project_id}/install` is not exercised — it rewrites the real MCP client configuration of whatever machine runs Langflow (a local pip instance means the developer's own `~/.cursor/mcp.json`), and it refuses any non-loopback caller, which every containerised lane is. Needs a disposable lane that calls from inside the container
- [x] `GET /{project_id}/composer-url` returns a URL that resolves — asserted by an MCP handshake against the URL the copy control actually yields — and that URL is rooted at the origin the user is browsing and shares the API's path → `mcp/server/mcp-server-install.spec.ts`
- [x] Per-project MCP configuration — `GET`/`PATCH /{project_id}` selects which flows are exposed as tools, and a de-selected flow both disappears from `tools/list` and is refused by `tools/call` over the protocol (#1408, fixed upstream by langflow#14522) → `mcp/server/mcp-server-project-config.spec.ts`
- [x] A registered server is read back individually via `GET /servers/{name}` with the same fields it was created with, and `PATCH /servers/{name}` updates them — merging per top-level key and refusing to rename (#1397) → `mcp/server/mcp-server.spec.ts`
- [ ] Prompt exposed by server returns correct template (no product surface on 1.11.x — MCP server `prompts/list` returns `[]`; #829)

---

## ui-ux/ — Visual Interface, Canvas and Design System

#### 15.1 Component Sidebar
- [x] Search component by name — matching component listed AND non-matching one hidden, case-insensitive → `ui-ux/sidebar-search-and-filter.spec.ts`
- [~] Hover over component shows tooltip/preview — **no product surface on 1.12.0.dev6**: hovering a sidebar card renders zero `[role="tooltip"]` elements, zero Radix poppers, no `title` and no `aria-describedby`; the only hover affordance is the `+` button, already covered by `core-components/componentHoverAdd.spec.ts` (#937)
- [x] Keyboard search (keyboard shortcut) — `/` focuses the search, Tab reaches a result, Space/Enter add that exact component → `ui-ux/keyboardComponentSearch.spec.ts`
- [x] Filter components by category — disclosure collapse/expand and non-matching categories removed while filtering → `ui-ux/sidebar-search-and-filter.spec.ts`
- [~] Sidebar shows correct provider count — **no count surface on 1.12.0.dev6**: the sidebar renders no numeric badge or count text anywhere (the count lives on Settings → Model Providers, §7). What exists is grouping under `disclosure-bundles-<provider>`, covered by `ui-ux/sidebar-search-and-filter.spec.ts` (#937)

#### 15.2 Add Components to Canvas
- [x] Drag component from sidebar to canvas — node lands at the drop position → `ui-ux/sidebar-add-component.spec.ts`
- [x] Double-click in sidebar adds component to canvas → `ui-ux/sidebar-add-component.spec.ts`
- [x] Hover + click "+" button adds component to canvas → `core-components/componentHoverAdd.spec.ts`
- [x] Added component appears with default settings — every field value compared against the `GET /api/v1/all` catalog template → `ui-ux/sidebar-add-component.spec.ts`

#### 15.3 Component Connections
- [x] Connect two compatible components — clicking the Chat Input source handle then the Chat Output target handle creates exactly one edge, persisted to `data.edges`; repeating the pair does not duplicate it → `flow-functionality/canvas-connect-components.spec.ts`
- [x] Prevent connection between incompatible types — a DataFrame output (Split Text `chunks`) into a Message input (Chat Output) creates no edge, while the Message→Message pair in the same test does (positive control); target-to-target is separately covered as invalid topology → `flow-functionality/canvas-connect-components.spec.ts`
- [x] Delete edge/connection — right-clicking the edge context menu and choosing the destructive item removes the edge from the canvas and from `data.edges` → `flow-functionality/canvas-edge-reconnect.spec.ts`
- [x] Filter edges by data type — clicking an input handle filters the sidebar to compatible sources (`url` → string sources, `headers` → Data sources), and the legacy/beta toggles expand that set → `ui-ux/filterSidebar.spec.ts`
- [x] Reconnect existing edge — after deleting it, clicking the same two handles restores exactly one edge in the canvas and in the flow → `flow-functionality/canvas-edge-reconnect.spec.ts`

#### 15.4 Node Manipulation
- [x] Delete component from canvas via Backspace key → `core-components/componentDelete.spec.ts`
- [x] Delete component from canvas via node options (...) menu → `core-components/componentDelete.spec.ts`
- [x] Copy and paste ChatOutput component (Ctrl+C / Ctrl+V) → `flow-functionality/canvas-copy-paste.spec.ts`
- [x] Copy and paste Prompt Template (component with dynamic ports) (Ctrl+C / Ctrl+V) → `flow-functionality/canvas-copy-paste.spec.ts`
- [x] Canvas keyboard shortcuts — Duplicate/Delete/Copy/Paste/Cut/Undo/Redo each act on the selected node, with the selection re-gated before every keypress → `ui-ux/langflowShortcuts.spec.ts`
- [x] Minimize component on canvas — the options menu collapses the node (every handle gains `no-show`, height shrinks) and persists `data.showNode = false`; the item swaps to Expand, which restores both; four further minimize/expand cycles keep both states correct and the persisted `showNode` in step (#1290) → `ui-ux/minimize.spec.ts`
- [x] Move component within canvas — dragging a node by its title moves it on canvas and the new coordinates reach the backend (`GET /api/v1/flows/{id}` `position` matches the rendered transform) → `flow-functionality/canvas-move-node.spec.ts`
- [x] Select multiple components via box selection — a Shift+drag marquee enclosing two separated nodes takes `.react-flow__node.selected` from 0 to 2, while a marquee drawn away from them selects nothing (negative control) → `flow-functionality/canvas-multiselect.spec.ts`
- [x] Delete multiple selected components (marquee box selection) → `core-components/componentDelete.spec.ts`, `flow-functionality/canvas-multiselect.spec.ts`
- [x] Deselect node by clicking on empty canvas area — clicking `.react-flow__pane` clears a selection asserted present first → `flow-functionality/canvas-deselect-node.spec.ts`
- [x] Deselect node via Escape → `flow-functionality/canvas-deselect-node.spec.ts`

#### 15.5 Canvas Zoom and Navigation
- [x] Zoom in / Zoom out → `ui-ux/canvas-zoom-navigation.spec.ts`
- [x] Fit View centers nodes → `ui-ux/canvas-zoom-navigation.spec.ts`
- [x] Fit View button in toolbar → `ui-ux/canvas-zoom-navigation.spec.ts`
- [x] Scroll to navigate canvas — on 1.12 the wheel zooms anchored at the pointer (no scroll-to-pan surface) → `ui-ux/canvas-zoom-navigation.spec.ts`
- [~] Minimap — feature flag-gated

#### 15.6 Grouping
- [x] Create component group → `core-components/nested-grouping-regression.spec.ts`
- [x] Ungroup components → `core-components/nested-grouping-regression.spec.ts`
- [x] Expand/collapse group → `core-components/nested-grouping-regression.spec.ts`

#### 15.7 Freeze and State
- [x] Freeze component — a frozen component serves its cached output instead of recomputing → `flow-functionality/freeze-and-state.spec.ts`
- [x] Freeze path — freezing a component also freezes every component upstream of it → `flow-functionality/freeze-and-state.spec.ts`
- [x] Unfreeze component — releases the whole path and the component recomputes → `flow-functionality/freeze-and-state.spec.ts`

#### 15.8 Sticky Notes
- [x] Add sticky note — the `canvas-add-note-button` canvas control places a note at the default 280×140 and the flow gains a node with `type: "noteNode"` → `ui-ux/sticky-notes.spec.ts`
- [x] Edit sticky note text → `ui-ux/edit-sticky-note-text.spec.ts`
- [x] Change sticky note color — the picker offers all seven presets; choosing rose repaints the note (`--note-rose` inline style) and persists `template.backgroundColor: "rose"` → `ui-ux/sticky-notes.spec.ts`
- [x] Resize sticky note — dragging the bottom-right resize handle grows the note past 280×140 and the new dimensions persist to the node's `width`/`height` → `ui-ux/sticky-notes.spec.ts`
- [x] Delete sticky note — removed via the options menu and via Backspace, gone from the canvas and from the persisted flow; deleting one of two leaves exactly one → `flow-functionality/canvas-sticky-note-delete.spec.ts`

#### 15.9 Right-Click and Menus
- [~] Context menu via right-click on canvas — **no product surface on 1.12.0.dev8**: a right-click on `.react-flow__pane` dispatches a `contextmenu` event that reaches `document` with `defaultPrevented === false` (so the browser's native menu is what opens) and renders zero `[role="menu"]` / `[role="listbox"]` / Radix popper elements, with or without a node selected — Langflow does not wire ReactFlow's `onPaneContextMenu`. That absence is now guarded negatively (the pane right-click dismisses an open node menu, opens nothing, and leaves the selection intact) → `ui-ux/right-click-dropdown.spec.ts`. Edge menus (`edge-context-menu-trigger`) are a left-click affordance and belong to §15.3 (#945, #1027)
- [x] Context menu via right-click on component — one right-click selects the node AND opens its options menu with the exact ordered item contract (Save/Duplicate/Copy/Docs/Minimize/Freeze/Download/Delete), Escape closes it, and choosing Duplicate from that menu adds the node → `ui-ux/right-click-dropdown.spec.ts`
- [x] Main menu actions — the header account menu lists all nine `menu_*_button` items, its version row matches `GET /api/v1/version`, the four external items carry their documented `href`/`target=_blank`, Escape closes it, and the Settings item routes to `/settings` → `ui-ux/main-menu-actions.spec.ts`

#### 15.10 Settings and UI Configuration
- [x] Access Settings page — profile menu opens Settings, the sidebar lists General/Model Providers/Shortcuts/Messages, and each section renders its own content (General shows the Language + Profile Picture groups) → `ui-ux/settings-navigation.spec.ts`, `ui-ux/settings-general-section.spec.ts`
- [x] Message history settings — Settings → Messages grid keeps the 11-column contract, renders messages oldest-first (1.12 `get_messages` defaults to `order=ASC`) and the sender "Equals User" filter narrows/restores the row set → `ui-ux/settings-message-history.spec.ts`
- [x] Change appearance/theme settings — dark/light toggle updates #body.dark class → `ui-ux/settings-theme-toggle.spec.ts`
- [x] Keyboard shortcuts work in editor — Duplicate/Delete/Copy/Paste/Cut/Undo/Redo each act on the selected node (node count asserted after every keypress) → `ui-ux/langflowShortcuts.spec.ts`
- [~] All documented shortcuts work — all 27 `defaultShortcuts` rows are listed with a non-empty key binding in Settings → Shortcuts (`ui-ux/settings-navigation.spec.ts`), and 7 of them are exercised on canvas (`ui-ux/langflowShortcuts.spec.ts`) plus 1 rebound end-to-end (`ui-ux/settings-shortcuts-edit.spec.ts`); the remaining 20 (API, Docs, Download, Play, Group, Minimize, Freeze, Save, Code, Update, Controls, sidebar search, …) are not exercised yet
- [x] Edit a keyboard shortcut (Duplicate → `Ctrl/Cmd+Alt+U`) persists to the table and the new combination triggers the action on canvas → `ui-ux/settings-shortcuts-edit.spec.ts`
- [x] API Keys table renders `created_at`/`expires_at` in the viewer's local timezone (UTC→local), shows "Never" for unused keys and ∞ for no-expiry keys (PR #13471) → `ui-ux/api-keys-timezone-display.spec.ts`

---

## security/ — Input Validation, SSRF and Secret Exposure

> **New area (2026-08-06).** Opened by the risk analysis in `docs/coverage-heatmap/`, which
> ranked it **1st by residual risk (15.0)** — not because the danger is the highest, but
> because it had **no checklist entry at all** and was therefore invisible to every coverage
> count, including the 76 % headline.
>
> **Scope boundary — this section does not cover authentication or authorization.** Those
> are already covered and counted elsewhere: `api/flows/` (401/403 across flow endpoints,
> API-key expiry) and `core-functionality/auth/` (session expiry, admin password). Every
> bullet here is a surface with **no existing coverage**, each traceable to an upstream
> defect.

#### 17.1 URL Validation and SSRF

- [x] A component that fetches a URL (API Request) rejects a loopback address when it is not
      in `LANGFLOW_SSRF_ALLOWED_HOSTS`, and accepts an address that is — the round trip of the
      guard, not just the rejection (upstream regression: `ensure_url` ignoring the allow-list
      for loopback, `langflow-ai/langflow#14264`). The *accepted* half is asserted on a private
      address rather than on loopback: allow-listing `127.0.0.1` on the shared instance would
      disarm `core-functionality/llm-agents/agent-tool-error-handling.spec.ts`, whose error
      generator is an SSRF-blocked loopback fetch → security/ssrf-url-validation.spec.ts
- [x] A private RFC-1918 address is rejected by the same guard unless allow-listed — asserted
      through the cloud-metadata address (`169.254.169.254`), the blocked-range address no lane
      allow-lists, since all three RFC-1918 ranges are allow-listed on every lane
      → security/ssrf-url-validation.spec.ts
- [x] The rejection surfaces to the user as an error in the UI, not as a silent empty result
      → security/ssrf-url-validation.spec.ts
- [x] `LANGFLOW_SSRF_ALLOWED_HOSTS` with a CIDR entry admits the whole range
      (the mechanism `.github/actions/resolve-echo-endpoint` already depends on, previously
      asserted nowhere) → security/ssrf-url-validation.spec.ts

#### 17.2 Code Execution Endpoints

- [-] `POST /api/v1/validate/code` rejects a payload crafted to execute on validation
      (**recurring upstream defect — reported in 2023 as #696 and again in 2026 as #13336,
      three years apart on the same endpoint**, which is the strongest recurrence signal in
      the whole bug corpus). "Rejects" means *refuses to execute*: a fixed instance answers
      `200` with empty error lists, so the assertion is the absence of the side effect, never
      a status code → security/code-execution-endpoints.spec.ts
- [-] The custom-component endpoint rejects the same class of payload
      (`langflow-ai/langflow#7900` — the boundary restored there is authentication; the
      authenticated build still executes posted code by design)
      → security/code-execution-endpoints.spec.ts
- [-] A rejected payload leaves no partial component created
      → security/code-execution-endpoints.spec.ts

#### 17.3 Secret Exposure

- [x] A flow run using a Credential-type global variable does **not** render the secret value
      in the trace detail (`langflow-ai/langflow#7313` — TracingService exposing secrets)
      → security/credential-secret-exposure.spec.ts
- [!] The same secret is absent from the exported flow JSON
      → security/credential-secret-exposure.spec.ts
- [x] The same secret is absent from the API response of a run
      → security/credential-secret-exposure.spec.ts

#### 17.4 Tweaks Injection

- [x] Tweak values passed to `POST /api/v1/run/{id}` cannot reach template fields as
      executable input (`langflow-ai/langflow#9319`, `#8672`)
      → security/tweaks-injection.spec.ts
- [-] The floor holds on the **graph run path** — `POST /api/v2/workflows` `mode=stream` refuses a
      `global_imports` and a `python_code` tweak on a code-execution node, and the refusal is
      **named** in the stream (an `event: "error"` frame carrying `TweakRefusedError` and the
      refused key) rather than being a bare failure. Both failure directions are asserted because
      they are opposite: acceptance is caught causally (the author's code branches on whether the
      widened module is in scope) and an unattributable refusal by requiring the frame to name the
      key. This is the path `langflow-ai/langflow#14538` says previously accepted tweaks the sync
      mode refused → security/tweaks-graph-path-floor.spec.ts
- [-] The same on `mode=background`, read from `GET /api/v2/workflows/{job_id}/events` — kept as
      its own bullet because `#14538` names both modes and they can regress independently
      → security/tweaks-graph-path-floor.spec.ts
- [-] `mode=sync` refuses a protected tweak **without ever answering 2xx**, and the refused request
      leaves the flow still running the author's code. Asserted shape-agnostically on purpose: the
      status body is a generic `500` on `1.12.0.dev37` where `POST /api/v1/run` returns
      `422 TWEAKS_REFUSED` naming the field, and the property pinned here holds under both, while
      still catching the failure that matters — a refusal answering `200` because the tweak took
      effect or was dropped and the run proceeded anyway. The shape difference is recorded in the
      spec doc → security/tweaks-graph-path-floor.spec.ts

---

## i18n/ — Interface Language and Localization

> **New area (2026-08-06).** Also opened by the risk analysis (residual risk **6.0**, 6th),
> and also absent from the checklist until now. Every one of the 5 upstream defects behind it
> is from **2026** — this is a surface that only started failing this year.
>
> **Not a duplicate of `#### 15.10`.** `ui-ux/settings-general-section.spec.ts` (`@stable`)
> asserts that the **Language group renders** with its description. Nothing asserts that
> **changing** the language works, and that is exactly where the reported failures are.
>
> **The prerequisite has landed.** `CONTRIBUTING.md` used to pin the context locale to
> `en-US` for every test with no sanctioned override, which made these bullets unwritable
> — the exact parameterisation issue it asked for is #1400 (`tests/fixtures/locale.ts`,
> `withLocale()`), merged 2026-08-11. The batch below is written against it.

#### 18.1 Language Selection

- [x] Changing the display language in Settings → General actually re-renders the interface
      in the selected language (the seam immediately past `settings-general-section.spec.ts`)
      → i18n/language-selection.spec.ts
- [x] The selected language persists across a reload and a new session — a reload and a
      second tab of the same browser context; a fresh context correctly does **not**
      inherit it (the preference is `localStorage`, not server state)
      → i18n/language-selection.spec.ts
- [x] Every language offered in the selector has a locale bundle that loads
      (`langflow-ai/langflow#12738`, `#12740` — shipped selector entries with missing `ru`
      and `ko` bundles; the options are enumerated at run time so a new entry is covered
      the day it appears, and English is asserted as the inverse case — no chunk at all)
      → i18n/language-selection.spec.ts

#### 18.2 Locale Resilience

- [x] The application boots without a blank screen when the browser language is one Langflow
      does not ship a bundle for — **the product's known total-failure mode**: a missing
      Chinese bundle (`#12923`, `#13477`) and Norwegian Bokmål `nb-NO` (`#13196`) each render
      a black screen, so the product does not open at all for those users. Covered on both
      axes: the stored `languagePreference` (nine-seed normaliser table) and the browser
      locale under `withLocale("nb-NO")`, which also pins that `navigator.language` never
      becomes a preference
      → i18n/locale-resilience.spec.ts
- [x] A locale bundle missing individual keys falls back to English for those keys instead of
      failing the render — asserted in the Create Memory modal under `pt`, on the two
      `memory.dbProvider*` keys only `en` carries (`shortcuts.modifierOnly` is a decoy: its
      call site passes an inline `defaultValue`, so it renders English even with the
      fallback broken)
      → i18n/locale-resilience.spec.ts

---

## memory/ — Memory Base Registration (1.12)

> **New area (2026-08-06).** The `Memories` panel inside the flow editor
> (`sidebar-nav-memories`) and the `Create Memory` modal that registers a memory
> base against `/api/v1/knowledge_bases` — 13 routes, none of them covered.
>
> **Not the Agent's conversation memory.** Searching the checklist for "memory"
> returns 10 bullets and every one is about Message History, session isolation or
> `context_id` (§6.3). Those are unrelated to this surface despite the shared word
> — the fourth naming collision found in this audit, after `template`, `language`
> and `deployment`.
>
> **Scope:** registration only. Ingestion (`POST /{kb}/ingest`), chunk preview, run
> history, cancellation, connectors and the five routes guarded by
> `_check_memory_base_association` are a separate item.
>
> Selectors below were harvested from a live 1.12.0 instance — see
> `docs/core-functionality/memory/memory-base-registration.md`.

#### 20.1 Memories Panel

- [x] The Memories panel opens from the flow editor (`sidebar-nav-memories`) and shows its empty state rather than a blank panel — asserted by element id (`#no-memory-selected-title` / `#no-memory-selected-description`), not by the i18n text, which moves under a locale change (§18) → `core-functionality/memory/memory-base-panel.spec.ts`
- [x] The panel offers registration (`Create`, asserted **enabled** — it renders disabled without a `currentFlowId`) and a `Search memories...` field; neither carries a `data-testid`, so both resolve by role/placeholder → `core-functionality/memory/memory-base-panel.spec.ts`

#### 20.2 Create Memory Modal

- [x] The modal is **scoped to the flow**, proving a memory base belongs to a flow rather than being global — heading `Create Memory` plus the **description** `Create a memory for "<flow name>"` (measured: the flow-scoped string is the description, not the title, and `Create Memory` is also the submit label) naming the exact flow the test created → `core-functionality/memory/memory-base-panel.spec.ts`
- [x] It exposes its five controls: Name (`#memory-name`), Embedding Model (`#memory-embedding-model`), Vector Database (`#memory-db-provider`), Batch Size (`#memory-batch-size`) and the LLM Preprocessing toggle (`#llm-preprocessing-switch`), with the preprocessing branch's two extra required fields absent while the toggle is off → `core-functionality/memory/memory-base-panel.spec.ts`
- [x] Vector Database defaults to `Chroma Local` (bundled, so no external vector service is needed) and Batch Size to `1`; Embedding Model has **no** default — covered by three tests, one per state of the shared model widget, since its collapse needs **both** no options **and** no enabled provider (`!hasEnabledProviders && !showEmptyState && optionCount === 0`, where `hasEnabledProviders` is `some(p => p.is_enabled || p.is_configured)` — any provider, not an embeddings-capable one): with a provider exposing embeddings the picker renders unset and no `Provider:` line shows (asserted against the real instance, `GET /api/v1/models`); with providers enabled but **none** exposing embeddings the picker **still renders**, unset; with nothing configured it is replaced by an **enabled** provider-setup button (`#memory-embedding-model-setup-provider-label`, `Select embedding model`) whose click opens the **Model providers** dialog. The last two serve that payload per page (derived from the live response, never fabricated), so they run on every lane instead of skipping on all of them (#1569). **The previously recorded product gap is withdrawn:** measured on `1.12.0.dev37`, the empty state is an escape hatch, not a dead end — the Knowledge Base modal's `showEmptyState: true` (`No Models Enabled` + `Manage Model Providers`) is a different rendering of the same intent → `core-functionality/memory/memory-base-panel.spec.ts`
- [x] `Create Memory` is disabled with an empty form **and stays disabled with only the Name filled** — the gate, not just the initial render (the required Embedding Model is what holds it, since Vector Database and Batch Size carry defaults) → `core-functionality/memory/memory-base-panel.spec.ts`
- [x] Cancelling closes the modal and creates nothing, asserted against the API rather than against the UI alone — **`GET /api/v1/memories?flow_id=<id>` → `total: 0`**, which is the endpoint the panel actually lists from (measured: opening it fires exactly that one request); `GET /api/v1/knowledge_bases` is a different resource this surface never calls, kept only as a secondary check that the flow's name is absent → `core-functionality/memory/memory-base-panel.spec.ts`

#### 20.3 Registration End-to-End (item 1 of 2)

- [x] Completing the form creates a memory base that is present **both** in the panel and in the API — asserted against **`GET /api/v1/memories?flow_id=<id>`** (the endpoint the panel lists from) with the server-assigned `id` and `kb_name` (`<sanitized name>_<8 hex>`), plus the panel re-read **after a full page reload**, which is what separates persisted state from an optimistic local render. Needs a provider exposing an **embedding** model; with none the test skips naming that state, never passing silently. **Measured correction:** a configured key is not the whole precondition — every embeddings model ships **disabled** in `GET /api/v1/models/enabled_models` (which is what the picker lists from), so the picker reads `No Models Enabled` until one is enabled; the test enables one via `POST /api/v1/models/enabled_models` before the page loads (an additive merge) and restores the flag in cleanup → `core-functionality/memory/memory-base-registration.spec.ts`
- [x] A registered memory base is exposed through the Memory Base API and **not** through the generic knowledge-base list — its `kb_name` is absent from `GET /api/v1/knowledge_bases`. This is the shipped design (`list_knowledge_bases` skips KBs managed by a Memory Base), so the presence check the wave item asked for would fail forever; the absence is the falsifiable form. Provider-free, so this half has coverage even on an instance where the registration test skips → `core-functionality/memory/memory-base-registration.spec.ts`

#### 20.4 Ingestion (item 2 of 2 — separate wave item)

> **Tracked separately from registration by team decision (2026-08-07).** Registration
> and ingestion are one product surface but two pieces of work, and the evidence points
> the other way from the bullets above: **all three of Memory Base's real upstream defects
> are ingestion**, while the registration surface §20.1–20.3 cover has none reported yet.
>
> Routes confirmed against the running instance: `POST /{kb}/ingest`,
> `POST /preview-chunks`, `GET /{kb}/chunks`, `GET /{kb}/runs`, `GET /{kb}/runs/{id}`,
> `POST /{kb}/cancel`, `GET /connectors`, `POST /test-connection`.
>
> **One connector ships today** — `folder` ("Ingest every matching file from a server-side
> folder", `requires_credentials: false`), measured on 1.12.0. A test needs no external
> service, but it does need a server-side path the instance can read.

- [ ] Chunk settings chosen in the UI are the ones actually applied to the ingested chunks — `@regression` for `langflow-ai/langflow#13884` (*"the initial chunk settings are not properly set"*, `jira`)
- [ ] `POST /preview-chunks` previews with the same settings the ingestion will use, so the preview is not a different code path from the run
- [ ] Ingesting from the `folder` connector produces chunks readable back via `GET /{kb}/chunks`
- [ ] An ingestion run is observable while it happens: `GET /{kb}/runs` lists it and `GET /{kb}/runs/{id}` reports its state
- [ ] `POST /{kb}/cancel` stops an in-flight ingestion and the run reports the cancellation rather than silently completing
- [ ] An embedding provider that cannot be reached fails the ingestion **with the provider named** — `@regression` for the two reported cases: an unreachable Ollama endpoint (`langflow-ai/langflow#13883`, `jira`) and Google embedding models rejected outright (`langflow-ai/langflow#12277`)
- [ ] A knowledge base bound to a memory base refuses ingestion through the `_check_memory_base_association` guard, which the API declares on five routes and nothing asserts

---

## governance/ — Catalog and Provider Policy (1.12)

> **New area (2026-08-19).** Catalog governance shipped in the **OSS** build, not
> only in Enterprise. Measured on `langflowai/langflow-nightly:latest`
> (`1.12.0.dev32`) against an Enterprise image built from
> `IBM-Langflow@release-1.12.0`: of the EE build's 55 governance routes, **25 are
> in OSS** — `catalog-policy/{components,templates,usage,usage/flows}`,
> `model-provider-policy`, `policy-bundle{,/history,/rollback}` and the `authz`
> CRUD — and the block is **enforced**, not merely stored.
>
> **What Enterprise still owns** (all `404` on the nightly, so out of scope here):
> `sso/*`, `authz/status`, `authz/check`, `authz/admin/*`, `authz/share-targets`,
> `authz/shared-with-me`, `enterprise-admin/catalog`, plus the admin **UI** (the
> OSS frontend bundle references none of these endpoints) and the ability to
> declare a policy from the environment — OSS `Settings` exposes no
> `LANGFLOW_CATALOG_COMPONENT_BLOCKLIST`, and an instance started with one reports
> `source: "migration"` with nothing blocked.
>
> **RBAC is present but pass-through in OSS**, so it is deliberately uncovered
> here: with `LANGFLOW_AUTHZ_ENABLED=true` the nightly logs *"the OSS pass-through
> authorization service is registered (no enforcement plugin found). Every
> enforce() call will return True"*. Asserting a role restriction there would
> assert nothing.
>
> **Every bullet below is `@destructive`.** The policy is instance-global — no
> per-user or per-project scope — so a blocked component is blocked for every
> worker sharing the Langflow. `daily-stable.yml` has no destructive lane, so none
> of these can be `@stable` (#1010); they run in `pr-validation.yml`'s destructive
> step when the import graph selects them.

#### 21.1 Component Blocklist

- [-] A blocked component leaves `GET /api/v1/all` while an unblocked control stays, and `GET /api/v1/config` flips `catalog_governance_enabled` — the derived flag is the cheapest proof the policy was adopted rather than merely persisted → `governance/catalog-policy/component-blocklist-enforcement.spec.ts`
- [-] Saving a flow that carries the blocked component is refused `400` with the component **named** (`Flow build blocked: catalog policy blocks components: …`), and a flow saved **before** the block stays readable with its nodes unmodified — the read/write pairing is the point, since a component hidden from the palette that still saves is the LE-1933 defect class → `governance/catalog-policy/component-blocklist-enforcement.spec.ts`
- [-] The blocked component is not findable in the flow-editor sidebar, asserted against a control search that still matches. Target is `DynamicCreateData` because it is `legacy: false` — `CombineText`, the obvious pick, is `legacy: true` and already absent from the sidebar, so that assertion would have passed with the policy doing nothing → `governance/catalog-policy/component-blocklist-enforcement.spec.ts`
- [-] Clearing the policy restores the catalog and the config flag — verified, not assumed: a failed restore leaves the shared instance short a component for the rest of the lane → `governance/catalog-policy/component-blocklist-enforcement.spec.ts`

#### 21.2 Template Blocklist

- [-] A template blocked by its `name_key` leaves **both** listings that serve templates — `GET /api/v1/flows/basic_examples/` (26 items, what the New Flow modal reads) and `GET /api/v1/starter-projects/` (5) — the key being read from the listing itself rather than hardcoded → `governance/catalog-policy/template-blocklist-enforcement.spec.ts`
- [-] Blocking by **display name** is accepted `200`, persists into the bundle and enforces **nothing** — an operator using the name they see in the UI gets no enforcement and no error (measured on `1.12.0.dev32`: `"Basic Prompting"` inert, `"basic_prompting"` effective) → `governance/catalog-policy/template-blocklist-enforcement.spec.ts`
- [-] `GET /api/v1/starter-projects/?include_blocked=true` returns the blocked template for a superuser, which is what separates *filtered* from *absent from the image* → `governance/catalog-policy/template-blocklist-enforcement.spec.ts`

#### 21.3 Model Provider Allowlist

- [-] An allowlist narrows `GET /api/v1/models/providers` to exactly the approved provider **and** removes the excluded provider's `ext:<id>:` components from `/api/v1/all`, while `registered_providers` still lists it — the last clause is the control that separates policy from packaging (`docs/component-distribution-policy.md`) → `governance/model-provider-policy/provider-allowlist-and-bundle-revisioning.spec.ts`
- [-] Clearing the allowlist restores the provider list and the catalog size → `governance/model-provider-policy/provider-allowlist-and-bundle-revisioning.spec.ts`
- [ ] The `get_llm` / `get_embeddings` runtime gate (LE-1955) — the bypass-proof half: a non-approved provider must be refused at execution, not only hidden. Needs a real provider key and a run, so it belongs with the credential-bearing specs, not the keyless policy file

#### 21.4 Policy Bundle Revisioning

- [-] Every accepted policy write mints a new revision with `source: "api"` and `GET /api/v1/policy-bundle/history` lists them newest-first (a fresh instance starts at revision 1, `source: "migration"`) → `governance/model-provider-policy/provider-allowlist-and-bundle-revisioning.spec.ts`
- [-] `POST /api/v1/policy-bundle/rollback/{revision}` is optimistically concurrent: a stale `expected_revision` is refused `409` with a body naming both `expected_revision` and `active_revision` → `governance/model-provider-policy/provider-allowlist-and-bundle-revisioning.spec.ts`
- [-] An accepted rollback **appends** rather than rewinds — new higher revision, `source: "rollback"`, `rollback_of_revision` pointing at the target, `reason` echoed — and the restored content is enforced, not just recorded → `governance/model-provider-policy/provider-allowlist-and-bundle-revisioning.spec.ts`
- [ ] `GET /api/v1/catalog-policy/usage` and `usage/flows` report the blast radius of a block (which flows use the component) before an operator applies it

## enterprise/ — Enterprise-only Surfaces (EE)

> **New area (2026-08-19).** The remainder § 21 names as Enterprise-owned: a
> policy the **operator** declares in the deployment, which EE reads at boot
> through `EnvironmentCatalogPolicyService`. OSS has no setting for it — an OSS
> instance started with `LANGFLOW_CATALOG_COMPONENT_BLOCKLIST` reports
> `source: "migration"` with nothing blocked — so this cannot live in § 21.
>
> Runs only in the `@enterprise` lane, against an instance started by
> `scripts/start-langflow-enterprise.sh`. Enforcement itself is **not** re-tested
> here; § 21 proves it. What is tested is **authority**: whether a runtime write
> can undo what the deployment declared.
>
> **No `@stable`** while no scheduled Enterprise lane exists (#1010).
>
> Spec docs: `docs/enterprise/`.

#### 22.1 Environment-Declared Policy

- [!] A policy whose source is the deployment is reported as externally managed, and a runtime write can neither clear it nor survive into the palette — **expected red on current Enterprise builds**, tracked outside this repo; needs a fresh container per run → `enterprise/governance/environment-policy-authority.spec.ts`
- [!] The same authority question for the other three knobs, each on the surface a user would notice — template blocklist on the template listing, provider allowlist on the provider listing, model blocklist on the bundle — **expected red on current Enterprise builds**, tracked outside this repo → `enterprise/governance/environment-policy-authority.spec.ts`
- [-] The admin inventory is the palette **plus exactly** what policy blocks: a blocked component stays listed there (or it could not be unblocked from the screen that blocked it), every placeable component is governable, and nothing is hidden that the declared policy does not account for → `enterprise/governance/admin-catalog-inventory.spec.ts`
- [-] Every declared blocklist key resolves through `policy_candidates` to a component the inventory lists — a key that resolves to nothing is accepted at boot, echoed by the bundle and enforces nothing → `enterprise/governance/admin-catalog-inventory.spec.ts`
- [-] The admin screen honours `managed_externally`: read-only banner, the bundle naming the external source, and the **Edit Catalog Policy** control disabled — asserted with the field intercepted, because on current builds the read-only path is unreachable from a real instance and would otherwise be a dead gate → `enterprise/governance/admin-ui-read-only-policy.spec.ts`
- [!] The same three surfaces with **no interception**, against a deployment-declared policy — **expected red on current Enterprise builds**: the operator is offered an editable screen. Paired with the intercepted test on purpose: mocked-pass + live-fail says the UI is correct and the API misreports the field, mocked-fail would say the UI dropped the contract → `enterprise/governance/admin-ui-read-only-policy.spec.ts`
- [ ] Whether the model blocklist should also filter `GET /api/v1/models` — measured today that it does not, there or through a runtime write, because that listing filters by provider only; the per-model predicate is consumed solely by the component dropdown's option builder
- [~] Provenance survives a restart: environment and API policy cannot silently disagree — **measured, and they DO** (#1559), verified by measurement rather than automated. On an instance declaring `CombineText`, one `PUT /catalog-policy/components {"blocked": ["Prompt"]}` takes the bundle from `revision: 2, source: "environment"` to `revision: 3, source: "api"`, and a `docker restart` with the same env leaves it at revision 3 — the environment is consulted at **initialization only**, so a single admin write permanently retires the declared policy while the deployment config still says otherwise, and no field reports the disagreement (`policy-bundle/history` records it, but only to somebody already suspicious). Not expressible as a spec: the restart has to happen between two assertions and a spec cannot restart the process it is testing. The acceptance half stays covered as an expected red by `environment-policy-authority.spec.ts`
- [~] Readiness stays unhealthy rather than serving permissively when the declared policy cannot be loaded — **fail-closed, verified by measurement, not automated**. With `LANGFLOW_CATALOG_COMPONENT_BLOCKLIST=CombineText,,Prompt` (an empty CSV entry) the instance raises `EnvironmentPolicyConfigurationError: Invalid LANGFLOW_CATALOG_COMPONENT_BLOCKLIST: entry 2 is empty`, logs `Application startup failed. Exiting.` and exits `3` after ~35 s — it never serves. Note the error names the **variable and position, never the value**, which the parser is written for deliberately. Not expressible as a spec: the instance under test never comes up, so a Playwright run against it dies in `globalSetup` and reports an unattributed preflight timeout instead of the property. The two ways to make a policy unloadable are an empty CSV entry (all four knobs) and invalid identifier syntax (`MODEL_PROVIDER_ALLOWLIST`, `MODEL_BLOCKLIST`)

#### 22.2 Credential Lifecycle

- [-] The forced-rotation gate is an **allowlist**: identity and discovery stay reachable (`users/whoami`, `account/password-status`, `auth/methods`, `config`) while product and admin surfaces are refused `403 must_change_password` — **`api_key/` among them**, so an account under a pending rotation cannot mint a key and walk around the gate → `enterprise/auth/credential-lifecycle.spec.ts`
- [-] Rotating refuses a wrong current password and a new password below the minimum, and accepts the correct pair → `enterprise/auth/credential-lifecycle.spec.ts`
- [-] After rotating, `account/password-status` stops reporting a pending rotation, a refused surface answers, and the token that performed the rotation is rejected (`401`) → `enterprise/auth/credential-lifecycle.spec.ts`
- [!] The **self-service** reset (`PATCH /users/{id}/reset-password`) enforces the same minimum as the forced path — **expected red** (#1558): the forced route declares `new_password` with `minLength: 8` and refuses anything shorter, while this one declares no minimum and accepts a **one-character** password, so any user can downgrade their own credential below the policy every bootstrapped account is put through → `enterprise/auth/self-service-password-reset.spec.ts`
- [-] The self-service reset requires proof of possession (`400 Current password is incorrect`), and a user cannot reset **another** user's password — `404 You can't change another user's password`, absent rather than forbidden, with the target's original credential still authenticating afterwards, which is what separates a refusal from one that was half-applied → `enterprise/auth/self-service-password-reset.spec.ts`
- [ ] Whether a **self-service** password reset should also invalidate previously minted tokens — measured that it does **not**, unlike the forced path (the performing token still answers `whoami`); recorded in #1558 and asserted in neither direction, because keeping the current session alive while revoking others is a legitimate product choice and pinning today's answer would settle it by assertion
#### 22.3 CLI Sign-in (authorization code + PKCE)

- [-] A correct exchange issues a token that **authenticates** a subsequent call — not merely a token-shaped payload → `enterprise/auth/cli-login-pkce.spec.ts`
- [-] The code is bound to its `code_verifier`, its `state` and its `redirect_uri`; each is refused on its **own** authorization, because a failed exchange consumes the code and reusing one would make later assertions pass for the wrong reason → `enterprise/auth/cli-login-pkce.spec.ts`
- [-] An authorization code cannot be spent twice → `enterprise/auth/cli-login-pkce.spec.ts`
- [-] The consent step confines its form (`form-action` restricted to the requested redirect, `frame-ancestors 'none'`, `no-store`) and refuses a bad CSRF token or a foreign origin → `enterprise/auth/cli-login-pkce.spec.ts`
- [-] Authorization code **expiry**, and the property is **indistinguishability** rather than the word "expired": a lapsed code, one that was never issued, and one already spent all answer `400` with the byte-identical `Invalid, expired, or already used CLI authorization code`, so the endpoint is not an oracle separating "never existed" from "lapsed". Splitting those messages would read as better developer experience and hand out exactly that oracle. TTL is 120 s by default (cap 300, floor 1, `LANGFLOW_CLI_LOGIN_CODE_TTL_SECONDS`), so the test costs ~2 min of wall clock on a stock instance and seconds on one started with a short TTL → `enterprise/auth/cli-login-code-expiry.spec.ts`

#### 22.4 Login Surface and Break-glass

- [-] Password login survives SSO being switched on but unusable: `auth/methods` still offers the local form, and the advertised form actually works — the invariant that an SSO mistake must never lock an organisation out → `enterprise/auth/login-surface.spec.ts`
- [-] Break-glass ships disabled and unused, while still naming its account → `enterprise/auth/login-surface.spec.ts`
- [-] Enabling break-glass is explicit and reflected, and arming it does **not** stamp `break_glass_last_used_at` → `enterprise/auth/login-surface.spec.ts`
- [ ] Actually using break-glass records the use — needs an SSO-only state, which needs a connection, which is entitlement-gated
- [ ] A created SSO connection is disabled by default, plan limits are enforced server-side, and the client secret is masked on read — all blocked without a licence (issue #1501)

#### 22.5 Entitlement Fail-Closed (no licence)

- [-] The gated read and the gated write both answer `503` with **one** message, asserted exactly and carrying a `detail` and nothing else — a licence failure is where a stack trace, an internal host or a key identifier would escape, and no other test here would notice → `enterprise/auth/entitlement-fail-closed.spec.ts`
- [-] The refusal is **total**: creation is refused, so no connection comes into existence and none is left half-created for a later request to find — this is the assertion that separates "unavailable" from "open" → `enterprise/auth/entitlement-fail-closed.spec.ts`
- [-] Authentication is answered **before** entitlement: an anonymous caller gets `403`, never the `503`, so the licence gate cannot be used to enumerate which Enterprise surfaces a deployment has → `enterprise/auth/entitlement-fail-closed.spec.ts`
- [-] The blast radius is bounded — flows, the component catalog, projects and identity all answer `200`. An unlicensed Enterprise is missing its entitled features, not broken → `enterprise/auth/entitlement-fail-closed.spec.ts`
- [ ] The entitled behaviour itself (a valid licence unlocks exactly the entitled surfaces and nothing else; an invalid, expired or wrong-signature licence is refused, naming which of the three) — blocked on a licence key

#### 22.6 RBAC / Authorization (`@authz`)

> Needs the RBAC container variant: `LANGFLOW_EE_RBAC=1 ./scripts/start-langflow-enterprise.sh`
> — a second container with its own Postgres on port 7891, because RBAC is a property of the
> database as much as of the process. Two corrections to the original design notes, both
> measured: **Redis is not required** (only multi-replica convergence needs one), and three
> variables the notes omitted are load-bearing (`LANGFLOW_AUTHZ_AUDIT_ENABLED`,
> `LANGFLOW_RBAC_BOOTSTRAP_ENABLED`, `LANGFLOW_RBAC_BOOTSTRAP_ADMIN_USERNAME`).

- [-] The instance is configured to enforce — `authz_enabled` true, **`superuser_bypass` false**, a non-zero policy rule count and the three built-in roles. Bypass is the half that gets forgotten: with it on, the only account this lane has is exempt and a whole deny matrix would pass against an instance that never denied anything → `enterprise/authz/rbac-instance-baseline.spec.ts`
- [-] A role-less user is denied a write **and the refusal leaves nothing behind** — a `403` that still created the resource is not an authorization control, and the caller sees the same status either way → `enterprise/authz/rbac-instance-baseline.spec.ts`
- [-] Granting `developer` flips the identical call to allowed — the load-bearing pair, since a lone `403` is equally consistent with "authorization works" and "this instance is broken" → `enterprise/authz/rbac-instance-baseline.spec.ts`
- [-] The audit log carries both the deny and the allow, attributed to the actor → `enterprise/authz/rbac-instance-baseline.spec.ts`
- [-] The deny matrix over one subject walked through states — no role / viewer / developer / admin / direct share / revoked — asserting the per-resource verdict rather than only creation, which is where `viewer` and `developer` finally differ (`403` against `200` on modifying an existing flow; on creation both are refused) → `enterprise/authz/deny-matrix-and-decision-api.spec.ts`
- [-] A forbidden resource is **indistinguishable from an absent one** — both `404`. A `403` here would confirm the resource exists to somebody who may not know it, an existence leak that costs nothing to introduce and nothing to notice → `enterprise/authz/deny-matrix-and-decision-api.spec.ts`
- [-] Revocation is real in both flavours: removing the role assignments and deleting the share each return the subject to the no-access row. A grant that cannot be taken back is not a grant → `enterprise/authz/deny-matrix-and-decision-api.spec.ts`
- [-] `POST /authz/check` agrees with enforcement for the **resource-scoped** question, and `matched_policy` names the grant that produced the answer. `obj` is a casbin object PATTERN, not a resource type: `flow:*` asks about flows in general and is answered from role policy alone, while `flow:<id>` also accounts for shares — asking the first about a specific resource produces a confident wrong answer that reads exactly like a product defect → `enterprise/authz/deny-matrix-and-decision-api.spec.ts`
- [-] An unknown object pattern is **denied rather than rejected** (`200`, `allowed: false`, empty `matched_policy`) — failing closed on a typo is right, and that empty match is the only signal separating a mis-encoded question from a real refusal → `enterprise/authz/deny-matrix-and-decision-api.spec.ts`
- [-] **Ownership outlives the role it was created under** — a user granted `developer`, who creates a flow and then loses the assignment, still reads it, modifies it and sees it listed. Almost certainly intended, and a governance fact nothing stated before: an operator who removes a role has **not** removed access to what was created under it → `enterprise/authz/ownership-team-and-api-key.spec.ts`
- [-] A team share grants like a direct one, and **either** revocation lever takes it back — deleting the share, or removing the membership with the share intact. Re-adding the membership restores it → `enterprise/authz/ownership-team-and-api-key.spec.ts`
- [-] An **API key carries its owner's permissions and never exceeds them**: through the key alone, with no bearer token, the owner's flow reads `200`, a foreign flow `404`, creating a flow `403`, an RBAC admin route `403`. A key answering otherwise would be an escalation path around the whole model, mintable by any user and invisible to every test that authenticates with a token → `enterprise/authz/ownership-team-and-api-key.spec.ts`
- [-] The three refusal messages are three **guards**, not three spellings of one ladder, and the ladder is not monotone: a holder of the global `admin` role passes resource policy and the RBAC admin route yet is still refused role administration (`Superuser required to administer roles.`, and `…role assignments.` on the sibling route), so the role cannot escalate itself; a superuser stripped of its assignment fails resource policy while passing both guards above it. Each subject passes a guard the other fails, which is why one subject could name the messages but never separate them → `enterprise/authz/guard-ladder-and-superuser-bypass.spec.ts`
- [-] `LANGFLOW_AUTHZ_SUPERUSER_BYPASS` switches **exactly one cell** — the superuser's resource-policy answer, `403` → `201` — while every non-superuser answer on the same instance is unchanged, so it is an escape hatch scoped to one principal and one guard rather than an authorization off-switch. Asserted from both ends, on the two containers that can each answer half: with the flag off the superuser stripped of its role is refused, which is what makes the `false` this whole area gates on mean something → `enterprise/authz/guard-ladder-and-superuser-bypass.spec.ts`
- [-] The bypass variant, `LANGFLOW_EE_BYPASS=1 ./scripts/start-langflow-enterprise.sh` — a third container on port 7892, differing from the RBAC one in that single knob so a difference in the answers is attributable to it. The two halves of the A/B are separate runs and each **skips** naming the container it needs; they cannot share a process, and on an 8 GB Docker VM they cannot even share a machine (the kernel `SIGKILL`s one, `Exited (137)`) → `enterprise/authz/guard-ladder-and-superuser-bypass.spec.ts`
- [-] **Inherited access**: a role assignment scoped to a project (`domain_type: "project"`) reaches the flows inside it — no role `404`/`404`, project-scoped `viewer` `200`/`403`, `developer` `200`/`200`, and revoking returns the subject to `404`. Inheritance is not a weaker grant, it is the same grant reached through the project, and it is the scope an operator actually uses → `enterprise/authz/inherited-access-and-deploy.spec.ts`
- [-] `GET /authz/flows/{id}/inherited-access` names every assignment that reaches the flow — the scope it came from, the role, and the resolved actions — and is superuser-scoped: asked by the subject it describes it answers `404`, so it cannot confirm a flow's existence to the very user it is about. Asserted by membership, never by list length → `enterprise/authz/inherited-access-and-deploy.spec.ts`
- [-] The deployment route refuses a `viewer` and a role-less user with `Permission denied`, and does **not** refuse an `admin` — asserted as "not `403`" rather than as a status, so configuring a control plane would not redden it. `developer` is deliberately unasserted: it reaches the same unconfigured-plane `503` as `admin` while the model does not list `deploy` for it, and a `503` cannot separate "authorized" from "authorized here, re-checked by a configured plane" → `enterprise/authz/inherited-access-and-deploy.spec.ts`
- [!] The decision APIs agree with enforcement about an **inherited** grant — **expected red** (#1532): enforcement answers `200` to both `GET` and `PATCH` while `check` with `obj: "flow:<id>"` answers `allowed: false, matched_policy: []` and `me/permissions` answers `[]`. `check` with `obj: "project:<pid>"` answers correctly, so the pattern vocabulary is not the problem — and `me/permissions` takes no pattern at all → `enterprise/authz/inherited-access-and-deploy.spec.ts`
- [!] The model does not contradict itself about `deploy` — **expected red** (#1532): `inherited-access` lists `deploy` among an `admin` assignment's resolved actions while `check` denies that action for the same subject and scope → `enterprise/authz/inherited-access-and-deploy.spec.ts`
- [-] **Policy reconciliation is an honest read**: `POST /authz/policy/reconcile` without repair is repeatable (same `revision` and counts twice) and writes nothing (`inserted_count`/`deleted_count` `0`) — a read that repaired silently would make the drift an operator is chasing vanish between two calls neither of which claimed to change anything. `policy/sync` returns identical counts on repeat → `enterprise/authz/policy-reconcile-and-repair.spec.ts`
- [-] The `revision` is a deterministic hash of policy: it moves when a project-scoped grant is written and returns to the **exact** baseline value when that grant is revoked, with the resource set held constant — `expected_count` tracks resources too, so comparing across a project's creation compares two different policies → `enterprise/authz/policy-reconcile-and-repair.spec.ts`
- [-] `?repair=true` reports what it changed and is **idempotent** — a `repaired` verdict carries a write, a `clean` one carries none, and a second repair on an untouched instance reports `clean` with every delta `0`. **`repair` is a QUERY parameter**: sent in the body it is silently ignored, the response echoes `repair: false`, and the same drift is reported call after call — which reads exactly like a dead knob → `enterprise/authz/policy-reconcile-and-repair.spec.ts`
- [-] The reconciliation surface is superuser-only, refusing with `Superuser required for authz admin endpoints` — a **fourth** distinct guard message beside the three separated above, asserted exactly so two gates cannot collapse onto one string → `enterprise/authz/policy-reconcile-and-repair.spec.ts`
- [-] **The recipient's side of a share**: a `read` share appears in `GET /authz/shared-with-me` carrying the owner and the permission level, and disappears when it is revoked — a share that never surfaces is one nobody uses, and one that lingers is a dead link → `enterprise/authz/share-discovery.spec.ts`
- [-] **The share picker cannot enumerate the directory**: `search` is a **required** query parameter with a two-character minimum (`?search=` → `422`), and a caller who cannot manage the resource's shares gets `404` rather than a list. A regression making `search` optional would turn the endpoint into a user-directory dump and would look like a more helpful picker → `enterprise/authz/share-discovery.spec.ts`
- [-] `share-targets/capability` answers `200 {can_manage_shares: false}` to the same caller `share-targets` answers `404` — coherent rather than inconsistent: the flag is a question about the **caller** (safe to answer, and a client needs it to render), the target list is a question about the **resource** → `enterprise/authz/share-discovery.spec.ts`
- [-] `GET /authz/me/rbac-admin` — the flag a client renders the admin screens from — tracks the admin route in **both** directions: false/`403`, then true/`200` under a global `admin` assignment, then false/`403` again after revocation. A signal that only latches true leaves a revoked user looking at admin screens → `enterprise/authz/admin-signal-and-grant-paths.spec.ts`
- [-] The **second grant path** converges on one assignment: `POST /authz/users/{id}/roles` grants by role **name**, its `assignment_id` appears in the admin listing and is revocable through the id-keyed route. A subject granting **itself** `admin` through it is refused by the **superuser** guard, not the weaker admin-role one → `enterprise/authz/admin-signal-and-grant-paths.spec.ts`
- [-] The admin twins (`admin/role-assignments`, `admin/assignment-scopes`) sit behind `RBAC administrator role required` while the operator routes (`siem/status`, `policy/reconcile*`) sit behind `Superuser required for authz admin endpoints` — adjacent routes, both `403`, asserted **by message** because the status cannot tell them apart → `enterprise/authz/admin-signal-and-grant-paths.spec.ts`
- [-] A **scoped** reconcile reports itself as narrowed (`scope: "entities"`, `trigger: "operator:targeted"`) rather than silently widening to an instance-wide pass, validates its `entity_type` enum, and is superuser-only. `entity_key` is the **casbin** key (`role:viewer`), not the entity's UUID → `enterprise/authz/operator-surfaces.spec.ts`
- [!] An unknown entity key is a client error rather than a server error — **expected red** (#1555): a role's UUID, its bare name and any unmatched key all answer `500` with a `message` envelope instead of the `detail` every other refusal here uses → `enterprise/authz/operator-surfaces.spec.ts`
- [-] The **audit filters actually filter**: `?result=deny` returns rows and **every** row is a deny, asserted over an event the run itself produced. An accepted-but-ignored filter returns a populated list that looks exactly like a filtered one. (An **invalid** filter value answers `200` with an empty envelope, indistinguishable from a clean log — recorded in #1555 and deliberately not pinned, since `422`-versus-empty is a product choice) → `enterprise/authz/operator-surfaces.spec.ts`
- [-] `siem/status` is **coherently** disabled with no adapter — `enabled`, `active`, `adapter_configured` and `capture_ready` all false together, since a mixed state reads as "audit is being exported" while nothing leaves the instance → `enterprise/authz/operator-surfaces.spec.ts`
- [-] Directory membership sync is guarded by the **age** of the snapshot: a fresh `observed_at` is accepted with a report (`snapshot_age_seconds`, `propagation`), `2020-01-01` is refused `409 … stale`, and the route is admin-gated — asserted with a **valid** body, because this route validates before it authorizes and an empty one answers `422` to anybody → `enterprise/authz/operator-surfaces.spec.ts`
- [-] **The operator screen is under Settings, not under `/admin-ee`** — `/admin-ee/access-control` redirects to `/admin-ee/users-groups` and that tab list has no Access Control tab at all; the three tabs live at `/settings/access-control{,/assignments,/teams}`, reached from `sidebar-nav-Access Control` → `enterprise/authz/access-control-ui.spec.ts`
- [-] A **system role offers no way to change it, on the screen and at the API**: the `System` row carries only `View` while a custom row carries `View` `Edit` `Delete`, and `PATCH`/`DELETE` on a system role both answer `400` leaving it unchanged. The badge is a label — the absent controls are what stop the edit, and the custom row is asserted positively because a screen rendering no action buttons at all would satisfy both absences → `enterprise/authz/access-control-ui.spec.ts`
- [-] The Assignments tab lists a grant held by **another user**, with its user, role, scope and `Manual` source. The screen reads `/authz/admin/role-assignments`; the caller-scoped sibling returns only the caller's own grants and is byte-identical on a single-admin instance, so a regression onto it would show the operator their own row and hide everyone else's access — a helper in this repo shipped with exactly that misreading → `enterprise/authz/access-control-ui.spec.ts`
- [-] **Assigning at project scope through the dialog creates a project-scoped assignment** — `domain_type: "project"` with `domain_id` equal to the id of a project the test created, asserted at the API rather than from the row's text. Scope is the axis the deny matrix turns on, and a picker submitting `global` regardless would hand instance-wide access to an operator who asked for one project. The test owns its project because two stock projects are both named `Starter Project`, told apart in the picker only by a ` — <owner>` suffix → `enterprise/authz/access-control-ui.spec.ts`
- [-] **Revoking on the screen removes the assignment at the API** — the confirm dialog names the role and the user losing it, and the state is read from the admin listing afterwards rather than from the row disappearing. Both buttons are named exactly `Revoke`, so the row's and the dialog's are addressed separately → `enterprise/authz/access-control-ui.spec.ts`
- [ ] Cross-replica convergence — needs Redis and a second replica: without one `invalidation.listener_connected` is `false` while the policy still resolves `active`, so a single-container assertion would measure nothing. **Recipe measured out; blocked only on machine memory** (a second Langflow replica costs ~1.1 GiB against an 8 GiB local Docker VM already holding six): the variable is `LANGFLOW_AUTHZ_REDIS_URL` (`src/authz/policy_invalidation.py`), so it takes a `redis:7-alpine` on `langflow-ee-net`, the RBAC container recreated with `LANGFLOW_AUTHZ_REDIS_URL=redis://redis-ee:6379/0`, and a second replica on another port sharing the same `LANGFLOW_DATABASE_URL`. The assertions are then `listener_connected: true` on both, and a grant written through replica A flipping replica B's enforcement with no restart, `seen_revision` / `observed_revision` converging

---

---

## Coverage Summary — Test Automation Coverage

> **Validated** = test carries the `@stable` tag.
> **Needs validation** = automated but not yet `@stable` (bug, flake under investigation, or pending team review).

| Module | Total | Validated `[x]` | Needs validation `[-]` | Partial `[~]`/`[!]` | Not automated `[ ]` |
|--------|-------|-----------------|------------------------|---------------------|---------------------|
| `api/flows/` — REST API | 33 | 28 | 4 | 1 | 0 |
| `core-components/` — Component Config | 27 | 24 | 3 | 0 | 0 |
| `core-components/` — Core Components | 91 | 87 | 3 | 0 | 1 |
| `core-functionality/auth/` | 23 | 21 | 2 | 0 | 0 |
| `core-functionality/knowledge-ingestion/` | 8 | 8 | 0 | 0 | 0 |
| `core-functionality/llm-agents/` | 40 | 33 | 3 | 1 | 3 |
| `core-functionality/model-provider/` | 34 | 32 | 2 | 0 | 0 |
| `core-functionality/observability-monitoring/` | 24 | 24 | 0 | 0 | 0 |
| `core-functionality/playground/` | 52 | 47 | 3 | 1 | 1 |
| `core-functionality/project-management/` | 12 | 6 | 6 | 0 | 0 |
| `core-functionality/templates/` | 34 | 2 | 0 | 4 | 28 |
| `core-functionality/a2a/` | 18 | 11 | 0 | 1 | 6 |
| `flow-functionality/` | 32 | 26 | 1 | 1 | 4 |
| `mcp/client/` | 13 | 9 | 2 | 0 | 2 |
| `mcp/server/` | 16 | 13 | 1 | 1 | 1 |
| `ui-ux/` — Canvas | 44 | 40 | 0 | 4 | 0 |
| `ui-ux/` — Settings | 7 | 6 | 0 | 1 | 0 |
| `security/` — Validation, SSRF, Secrets | 14 | 7 | 6 | 1 | 0 |
| `i18n/` — Language and Localization | 5 | 5 | 0 | 0 | 0 |
| `memory/` — Memory Base Registration | 16 | 9 | 0 | 0 | 7 |
| `governance/` — Catalog and Provider Policy | 14 | 0 | 12 | 0 | 2 |
| `enterprise/` — Enterprise-only Surfaces | 71 | 0 | 56 | 9 | 6 |
| **TOTAL** | **628** | **438 (70%)** | **104 (17%)** | **25 (4%)** | **61 (10%)** |

> Note: `Validated [x]` counts checklist bullets, not `test()` calls. The
> `@stable` tag is per-`test()`, and a single `@stable` test may map to
> several bullets via `test.step()` (e.g. the agent suite covers 7
> bullets). The canonical list of `@stable` `test()` calls is in
> **Phase 0 — Validated** below.

---

## Implementation Roadmap

---

### 🟢 Phase 0 — Validated

> 519 `test()` calls carrying the `@stable` tag, distributed across 202 spec
> files. Run weekly by the stable workflow. New specs are merged with all
> tests tagged `@stable`; the tag is removed per-test during weekly triage
> when a failure is classified as a test bug — so a spec may end up with a
> mix of tagged and untagged tests over time.

#### api/flows/
- [x] direct event_delivery streams build events inline (no job_id) and echoes the input → `api-build-direct-response.spec.ts`
- [x] direct is distinct from the job_id path: streaming delivery returns a job_id → `api-build-direct-response.spec.ts`
- [x] polling is the two-step path: POST returns a job_id shell (no inline events) → `api-build-polling-response.spec.ts`
- [x] the poll loop drains the build to completion across repeated GET /events calls → `api-build-polling-response.spec.ts`
- [x] API Request component — include_httpx_metadata=true adds request headers to output → `api-component-regression.spec.ts`
- [x] API Request component — timeout error returns status_code 500 with error field → `api-component-regression.spec.ts`
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
- [x] API Request component — POST method executes POST verb and returns 200 → `api-request-component-regression.spec.ts`
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
- [x] Data Operations Text mode returns the Case Conversion result as a Message → `data-operations-component.spec.ts`
- [x] Data Operations Word Count switches the Text-mode output to JSON and counts the text → `data-operations-component.spec.ts`
- [x] Data Operations JSON mode selects a single key from an upstream JSON output → `data-operations-component.spec.ts`
- [x] Data Operations Table mode filters the rows of an upstream Table output → `data-operations-component.spec.ts`
- [x] All three legacy operations components name Data Operations as their replacement → `data-operations-legacy-link.spec.ts`
- [x] The legacy banner link filters the sidebar to Data Operations → `data-operations-legacy-link.spec.ts`
- [x] Searching a legacy operations name surfaces Data Operations with legacy components hidden → `data-operations-legacy-link.spec.ts`
- [x] A legacy operations component still builds and returns its result → `data-operations-legacy-link.spec.ts`
- [x] two API Request nodes expose the same field without duplicating its DOM id → `duplicate-dom-ids-regression.spec.ts`
- [x] two Agent nodes expose the same field without duplicating its DOM id → `duplicate-dom-ids-regression.spec.ts`
- [x] user should be able to edit name and description of a node → `edit-name-description-node.spec.ts`
- [x] user can edit a URL tool action in Tool Mode and the edits persist → `edit-tools.spec.ts`
- [x] a full custom component built from code exposes its declared interface → `full-custom-component.spec.ts`
- [x] the system must delete the handles from advanced fields when the code is updated → `general-bugs-delete-handle-advanced-input.spec.ts`
- [x] any changes on the node must be saved on user interaction → `general-bugs-save-changes-on-node.spec.ts`
- [x] Human Input renders the default Approve and Reject branch handles when added to the canvas → `human-input-node-config.spec.ts`
- [x] the configured branch handles persist after save and reload → `human-input-node-config.spec.ts`
- [x] If-Else routes matching input through the True branch and skips the False branch → `if-else-component-regression.spec.ts`
- [x] If-Else routes non-matching input through the False branch and skips the True branch → `if-else-component-regression.spec.ts`
- [x] If-Else operator=contains routes a substring match through the True branch → `if-else-component-regression.spec.ts`
- [x] If-Else operator=regex routes a valid pattern match through the True branch → `if-else-component-regression.spec.ts`
- [x] If-Else operator=regex hides the case_sensitive advanced field → `if-else-component-regression.spec.ts`
- [x] If-Else case_sensitive defaults to ON — mixed-case inputs route to the False branch → `if-else-component-regression.spec.ts`
- [x] If-Else with case_sensitive=OFF treats mixed-case inputs as a match (True branch) → `if-else-component-regression.spec.ts`
- [x] If-Else operator=greater than routes a numeric match (10 > 5) through the True branch → `if-else-component-regression.spec.ts`
- [x] If-Else operator=less than routes a numeric match (2.5 < 10) through the True branch → `if-else-component-regression.spec.ts`
- [x] If-Else operator=less than or equal routes an equal-operands match (5 <= 5) through the True branch → `if-else-component-regression.spec.ts`
- [x] If-Else operator=greater than or equal routes an equal-operands match (5 >= 5) through the True branch → `if-else-component-regression.spec.ts`
- [x] Show Legacy Components toggle controls visibility of legacy components in the sidebar → `legacy-components-toggle-regression.spec.ts`
- [x] Loop component — renders correctly with all handles and output inspection buttons → `loop-component-regression.spec.ts`
- [x] Loop component — run without connections shows build failed notification → `loop-component-regression.spec.ts`
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
- [x] input list field edit persists → `parameters-panel-field-types.spec.ts`
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
- [x] Webhook component — flow is saved to database and contains the Webhook node → `webhook-component-regression.spec.ts`
- [x] Webhook component — cURL command in inspector shows valid POST URL with flow ID → `webhook-component-regression.spec.ts`
- [x] Webhook component — empty data field returns empty Data object → `webhook-component-regression.spec.ts`
- [x] Webhook component — endpoint field renders the actual webhook URL → `webhook-component-regression.spec.ts`
- [x] Webhook component — copy button copies the endpoint URL to clipboard → `webhook-component-regression.spec.ts`
- [x] Webhook component — POST to non-existent flow name returns 404 → `webhook-component-regression.spec.ts`
- [x] Webhook component — valid JSON payload is propagated as structured Data output → `webhook-component-regression.spec.ts`
- [x] Webhook component — invalid JSON payload is encapsulated in {payload: ...} → `webhook-component-regression.spec.ts`
- [x] GET /api/v1/monitor/messages returns 200 with array response → `webhook-component-regression.spec.ts`

#### core-functionality/a2a/
- [x] the Internal dropdown lists a locally published agent and calling it runs that flow → `a2a-client-agent-internal.spec.ts`
- [x] published agent flow serves a spec-valid card → `a2a-server-agent-card.spec.ts`
- [x] card overrides change exactly what the card advertises → `a2a-server-agent-card.spec.ts`
- [x] card is 404 while the flow is not published → `a2a-server-agent-card.spec.ts`
- [x] card is 404 for an unknown flow id → `a2a-server-agent-card.spec.ts`
- [x] a flow without chat input and output cannot be published → `a2a-server-agent-tab-publish.spec.ts`
- [x] publishing from the Agent tab serves a card at the advertised URL → `a2a-server-agent-tab-publish.spec.ts`
- [x] the card editor changes what the API serves → `a2a-server-agent-tab-publish.spec.ts`
- [x] the Try it panel round-trips a sentinel over the published endpoint → `a2a-server-agent-tab-try-it.spec.ts`
- [x] the api-key gate follows the project the flow lives in → `a2a-server-auth-apikey.spec.ts`
- [x] discovery lists only agent-typed, A2A-enabled flows → `a2a-server-discovery.spec.ts`
- [x] unpublishing removes the flow from discovery → `a2a-server-discovery.spec.ts`
- [x] message/send runs the flow and echoes the sentinel back → `a2a-server-jsonrpc-message-send.spec.ts`
- [x] each call produces its own task → `a2a-server-jsonrpc-message-send.spec.ts`
- [x] protocol errors come back as JSON-RPC errors over HTTP 200 → `a2a-server-jsonrpc-message-send.spec.ts`
- [x] a conversation keeps its thread only while the caller quotes the contextId → `a2a-server-multi-turn-context.spec.ts`
- [x] a task can be read back and refuses a cancel it cannot honour → `a2a-server-tasks-lifecycle.spec.ts`
- [x] a task id is invisible to another flow → `a2a-server-tasks-lifecycle.spec.ts`
- [x] cancelling a running task moves it to canceled → `a2a-server-tasks-lifecycle.spec.ts`

#### core-functionality/auth/
- [x] admin changes user password — user can log in with new password → `admin-password-change.spec.ts`
- [x] admin changes user password — old password no longer works after change → `admin-password-change.spec.ts`
- [x] admin creates a user inactive by default — the inactive user cannot log in → `admin-user-management.spec.ts`
- [x] activation and deactivation flip the same credentials between refused and accepted → `admin-user-management.spec.ts`
- [x] renaming a user moves the login to the new username → `admin-user-management.spec.ts`
- [x] the OSS build offers no Admin Page — menu and route both → `admin-user-management.spec.ts`
- [x] when auto_login is off, users sign in through the form and see only their own flows → `auto-login-off.spec.ts`
- [x] auto_login sign in → `autoLogin.spec.ts`
- [x] auto_login block_admin → `autoLogin.spec.ts`
- [x] login with invalid credentials must show error and stay on login page → `login-invalid-credentials.spec.ts`
- [x] login with empty credentials must not redirect to main page → `login-invalid-credentials.spec.ts`
- [x] logout must redirect user to login page → `logout-flow.spec.ts`
- [x] after logout, navigating to root must redirect to login → `logout-flow.spec.ts`
- [x] after logout, reload must stay on login page → `logout-flow.spec.ts`
- [x] API request with invalid token returns 401 or 403 → `session-expired.spec.ts`
- [x] API request with no token returns 401 or 403 → `session-expired.spec.ts`
- [x] UI shows login page when auto_login is unavailable (session cannot be established) → `session-expired.spec.ts`
- [x] valid token grants access to protected resources → `session-expired.spec.ts`

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
- [x] agent stop button must halt execution mid-run → `agent-component-regression.spec.ts`
- [x] Agent settings survive save and reopen → `agent-config-persistence.spec.ts`
- [x] context-scoped retrieval returns all turns of the context and not the untagged control → `agent-context-id-continuity.spec.ts`
- [x] agent run persists every session message tagged with the custom context_id → `agent-context-id-continuity.spec.ts`
- [x] mirrored context-scoped retrievals return only their own context's messages → `agent-context-id-isolation.spec.ts`
- [x] switching the agent's context_id re-tags new turns without touching previous ones → `agent-context-id-isolation.spec.ts`
- [x] toggle ON (default): agent's date tool returns today's date → `agent-current-date-tool.spec.ts`
- [x] toggle OFF: the date tool is removed from the agent's toolkit → `agent-current-date-tool.spec.ts`
- [x] model refusal does not crash the component → `agent-empty-refusal-response.spec.ts`
- [x] empty response does not crash the component → `agent-empty-refusal-response.spec.ts`
- [x] input via ChatInput handle drives the agent response → `agent-input-sources.spec.ts`
- [x] input via the Agent's direct field drives the agent response → `agent-input-sources.spec.ts`
- [x] causal control — a high max iterations does not hit the limit → `agent-max-iterations.spec.ts`
- [x] max_tokens=50 caps the response's output tokens → `agent-max-tokens.spec.ts`
- [x] causal control — unset max_tokens generates freely → `agent-max-tokens.spec.ts`
- [x] selecting 'Connect other models' clears the previously selected model → `agent-model-connection-isolation.spec.ts`
- [x] agent selects the URL tool for a fetch prompt → `agent-multi-tool-selection.spec.ts`
- [x] agent selects the Web Search tool for a search prompt → `agent-multi-tool-selection.spec.ts`
- [x] agent runs the URL then Web Search tools in sequence for a chained prompt → `agent-multi-tool-selection.spec.ts`
- [x] image via input handle is described by the agent → `agent-multimodal-image-input.spec.ts`
- [x] negative control — no image, no image-specific description → `agent-multimodal-image-input.spec.ts`
- [x] a small n_messages truncates retrieval to the most recent messages → `agent-n-messages-limit.spec.ts`
- [x] causal control — a large n_messages retrieves the full seeded history → `agent-n-messages-limit.spec.ts`
- [x] output_schema fields come back as typed JSON keys on the structured response → `agent-structured-output.spec.ts`
- [x] a multiple (As List) schema row returns an array of the row's type → `agent-structured-output.spec.ts`
- [x] Agent Instructions are respected in the model response → `agent-system-prompt.spec.ts`
- [x] negative control — sentinel is absent without the instruction → `agent-system-prompt.spec.ts`
- [x] agent handles a tool error and continues execution → `agent-tool-error-handling.spec.ts`
- [x] an invalid tool name blocks execution with a clear message → `agent-tool-name-validation.spec.ts`
- [x] causal control — a valid custom tool name executes normally → `agent-tool-name-validation.spec.ts`
- [x] user must be able to send images in the playground with the agent component → `general-bugs-agent-images-playground.spec.ts`
- [x] language model must respond with OpenAI provider → `language-model-regression.spec.ts`
- [x] language model provider switch from OpenAI to Google must persist → `language-model-regression.spec.ts`
- [x] model provider dialog opens from the Language Model node → `language-model-regression.spec.ts`
- [x] playground shows error when LLM run endpoint returns 500 (mocked invalid API key) → `llm-invalid-api-key-ui.spec.ts`
- [x] playground input remains usable after API error (mocked) → `llm-invalid-api-key-ui.spec.ts`
- [x] memory chatbot template loads with correct node structure → `memory-history-regression.spec.ts`
- [x] session isolation: new session has no context from previous session → `memory-history-regression.spec.ts`
- [x] OpenAI provider is listed in Model Providers settings → `model-provider-api-key.spec.ts`
- [x] Anthropic provider is listed in Model Providers settings → `model-provider-api-key.spec.ts`
- [x] a configured provider exposes the key edit surface (Replace, no raw input) → `model-provider-api-key.spec.ts`
- [x] page opens with its description and the available provider count → `model-provider-modal-actions.spec.ts`
- [x] an invalid API key is rejected and does not enable the provider → `model-provider-modal-actions.spec.ts`
- [x] selecting another provider switches the visible detail panel → `model-provider-modal-actions.spec.ts`
- [x] model toggle changes immediately and persists across reopen → `model-provider-model-toggle.spec.ts`
- [x] disabling a model removes it from a component model dropdown → `model-provider-model-toggle.spec.ts`
- [x] the Language Model node renders its model selector → `modelInputComponent.spec.ts`
- [x] opening the model dropdown lists model options → `modelInputComponent.spec.ts`
- [x] the model dropdown exposes the Manage Model Providers entry → `modelInputComponent.spec.ts`
- [x] the trigger shows the model the user selects → `modelInputComponent.spec.ts`
- [x] provider list renders with the known providers → `modelProviderModal.spec.ts`
- [x] selecting a provider opens its API key configuration detail → `modelProviderModal.spec.ts`
- [x] a configured provider shows its model selection panel → `modelProviderModal.spec.ts`
- [x] should display error message when using invalid authentication for provider <provider> → `provider-invalid-auth-error.spec.ts`
- [x] a provider credential variable can be removed through the Global Variables UI → `remove-provider-api-key.spec.ts`
- [x] DELETE /api/v1/variables/{id} removes a provider API key variable → `remove-provider-api-key.spec.ts`

#### core-functionality/memory/
- [x] the Memories panel opens with its empty state, a Create action and a search field → `memory-base-panel.spec.ts`
- [x] the Create Memory modal is scoped to the current flow → `memory-base-panel.spec.ts`
- [x] the Create Memory modal exposes its five controls → `memory-base-panel.spec.ts`
- [x] Vector Database defaults to Chroma Local and Batch Size to 1 → `memory-base-panel.spec.ts`
- [x] Embedding Model carries no default model when a provider offers embeddings → `memory-base-panel.spec.ts`
- [x] the Embedding Model picker is replaced by a provider-setup affordance when no provider is configured → `memory-base-panel.spec.ts`
- [x] the Embedding Model picker still renders when the configured providers expose no embeddings model → `memory-base-panel.spec.ts`
- [x] Create Memory stays disabled with an empty form and with only the Name filled → `memory-base-panel.spec.ts`
- [x] cancelling the Create Memory modal creates no memory base → `memory-base-panel.spec.ts`
- [x] a registered memory base is exposed through the Memory Base API, never through the knowledge-base list → `memory-base-registration.spec.ts`

#### core-functionality/model-provider/
- [x] Anthropic API key is configured via Settings → Model Providers → `anthropic-provider.spec.ts`
- [x] configured Anthropic selects a Claude model in the Agent and executes the flow → `anthropic-provider.spec.ts`
- [x] switches between Claude model families (Haiku → Sonnet → Opus) → `anthropic-provider.spec.ts`
- [x] Azure AI Foundry is offered with a two-variable form and a Foundry-only deployment surface → `azure-ai-foundry-provider-setup.spec.ts`
- [x] an unconfigured Azure AI Foundry panel is read-only: no enable toggle, no add-deployment control → `azure-ai-foundry-provider-setup.spec.ts`
- [x] credentials that do not validate are rejected and nothing is persisted → `azure-ai-foundry-provider-setup.spec.ts`
- [x] a portal deployment name absent from every catalog is accepted and rendered → `azure-ai-foundry-provider-setup.spec.ts`
- [x] real credentials configure the provider and enable a portal deployment through the UI → `azure-ai-foundry-provider-setup.spec.ts`
- [x] the configured deployment answers a real inference through the Language Model component → `azure-ai-foundry-provider-setup.spec.ts`
- [x] Google API key is configured via Settings → Model Providers → `google-provider.spec.ts`
- [x] configured Google selects a Gemini model in the Agent and executes the flow → `google-provider.spec.ts`
- [x] Ollama base URL is configured via Settings → Model Providers → `ollama-provider.spec.ts`
- [x] the provider is offered with two variables and a live-only, empty catalog → `openai-compatible-provider-setup.spec.ts`
- [x] an unreachable base URL is rejected and nothing is persisted → `openai-compatible-provider-setup.spec.ts`
- [x] a reachable endpoint with a bogus key is rejected as an authentication failure → `openai-compatible-provider-setup.spec.ts`
- [x] the configured provider discovers exactly the models its endpoint serves → `openai-compatible-provider-setup.spec.ts`
- [x] a discovered model runs a flow through the OpenAI Compatible provider → `openai-compatible-provider-setup.spec.ts`
- [x] saving a base URL and an API key through Settings persists BOTH variables → `openai-compatible-provider-setup.spec.ts`
- [x] OpenAI API key is configured via Settings → Model Providers → `openai-provider.spec.ts`
- [x] configured OpenAI selects a GPT model in the Agent and executes the flow → `openai-provider.spec.ts`

#### core-functionality/observability-monitoring/
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
- [x] approving a Human Input pause routes only the approved branch → `human-input-pause-resume.spec.ts`
- [x] rejecting a Human Input pause routes only the reject branch → `human-input-pause-resume.spec.ts`
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
- [x] Playground run is delivered over an SSE (text/event-stream) response → `playground-response-streaming-sse.spec.ts`
- [x] clear-chat removes all messages from Default Session → `playground-session-clear.spec.ts`
- [x] a session renamed in the playground is the session its messages are stored under → `playground-session-id.spec.ts`
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

#### core-functionality/project-management/
- [x] user should be able to select flows with different methods and perform bulk actions → `bulk-actions.spec.ts`
- [x] user should be able to edit flow name and see it reflected in the main page listing → `edit-flow-name.spec.ts`
- [x] flow settings enforce character limits and persist name & description → `flowSettings.spec.ts`
- [x] creates, renames and deletes an empty project folder via the UI → `folder-crud.spec.ts`
- [x] deleting a folder that contains a flow removes the flow with it → `folder-crud.spec.ts`
- [x] deleting a folder should update the folder list immediately → `folder-deletion-integrity.spec.ts`
- [x] deleting one folder should not affect other folders → `folder-deletion-integrity.spec.ts`
- [x] creating a new folder after deletion should work correctly → `folder-deletion-integrity.spec.ts`
- [x] getting-started progress increments as onboarding steps complete → `user-progress-track.spec.ts`

#### flow-functionality/
- [x] API access modal opens from the Publish dropdown exposing the Python, JavaScript and cURL tabs → `api-access-modal-regression.spec.ts`
- [x] API access modal switches the displayed snippet when changing language tabs → `api-access-modal-regression.spec.ts`
- [x] API access modal embeds the current flow ID in the generated run endpoint URL → `api-access-modal-regression.spec.ts`
- [x] API access modal closes cleanly via Escape and via the close button → `api-access-modal-regression.spec.ts`
- [x] user should be able to manually save a flow when the auto_save is off → `auto-save-off.spec.ts`
- [x] connecting two compatible components creates exactly one edge → `canvas-connect-components.spec.ts`
- [x] connecting the same compatible pair twice does not duplicate the edge → `canvas-connect-components.spec.ts`
- [x] a type-incompatible pair does not connect → `canvas-connect-components.spec.ts`
- [x] clicking the same target handle twice does not create an edge → `canvas-connect-components.spec.ts`
- [x] copy and paste ChatOutput component via Ctrl+C / Ctrl+V → `canvas-copy-paste.spec.ts`
- [x] copy and paste Prompt Template (component with dynamic ports) via Ctrl+C / Ctrl+V → `canvas-copy-paste.spec.ts`
- [x] clicking empty canvas area deselects a selected node → `canvas-deselect-node.spec.ts`
- [x] pressing Escape deselects a selected node → `canvas-deselect-node.spec.ts`
- [x] deleting an edge from its context menu removes it from the canvas and the flow → `canvas-edge-reconnect.spec.ts`
- [x] an edge can be recreated after it is deleted → `canvas-edge-reconnect.spec.ts`
- [x] dragging a component moves it on the canvas and persists the new position → `canvas-move-node.spec.ts`
- [x] a Shift+drag marquee selects every component it encloses → `canvas-multiselect.spec.ts`
- [x] deleting a box selection clears the selected components → `canvas-multiselect.spec.ts`
- [x] deleting a sticky note from its options menu removes it everywhere → `canvas-sticky-note-delete.spec.ts`
- [x] deleting a sticky note with Backspace removes it everywhere → `canvas-sticky-note-delete.spec.ts`
- [x] deleting one of two sticky notes leaves the other in place → `canvas-sticky-note-delete.spec.ts`
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
- [x] user must be able to stop a building from the canvas → `stop-building.spec.ts`
- [x] flow state should be properly cleaned up between user sessions → `user-flow-state-cleanup.spec.ts`

#### i18n/
- [x] changing the display language re-renders the interface → `language-selection.spec.ts`
- [x] the selected language survives a reload and a second tab of the same session → `language-selection.spec.ts`
- [x] every language the selector offers loads a translation bundle → `language-selection.spec.ts`
- [x] the application boots into a shipped language for every unsupported or regional preference → `locale-resilience.spec.ts`
- [x] the application boots in English and never adopts the browser locale as a preference → `locale-resilience.spec.ts`
- [x] a missing key falls back to English beside siblings the bundle translates → `locale-resilience.spec.ts`

#### mcp/client/
- [x] Gemini invokes the echo MCP tool (regression for fixed upstream #440) → `mcp-client-agent-gemini-tool-regression.spec.ts`
- [x] configures MCP server via JSON, selects echo tool, runs it, and verifies output → `mcp-client-regression.spec.ts`
- [x] configures MCP server via HTTP form tab and verifies registration → `mcp-client-regression.spec.ts`
- [x] selects get-sum tool, provides numeric inputs, and verifies sum in output → `mcp-client-regression.spec.ts`
- [x] registering an already-existing MCP server returns 409 Conflict → `mcp-server-registration-status-codes.spec.ts`
- [x] deleting a non-existent MCP server returns 404 Not Found → `mcp-server-registration-status-codes.spec.ts`

#### mcp/server/
- [x] the URL the UI copies is rooted at the user's own origin, agrees with the API, and resolves → `mcp-server-install.spec.ts`
- [x] the auto-install list reflects the install state the page was given → `mcp-server-install.spec.ts`
- [x] a client reported as available is offered, while the others stay disabled → `mcp-server-install.spec.ts`
- [x] project MCP settings round-trip through GET and PATCH → `mcp-server-project-config.spec.ts`
- [x] an exposed flow is served over the protocol, and de-selecting withdraws it → `mcp-server-project-config.spec.ts`
- [x] generated endpoint advertises the project and lists the enabled flow → `mcp-server-protocol.spec.ts`
- [x] execute the exposed tool over the MCP protocol echoes the input → `mcp-server-protocol.spec.ts`
- [x] resources/list surfaces the uploaded flow file as a resource → `mcp-server-resources.spec.ts`
- [x] user must be able to see starter projects for mcp servers → `mcp-server-starter-projects.spec.ts`
- [x] user must not be able to add duplicate mcp servers from starter projects → `mcp-server-starter-projects.spec.ts`
- [x] user should be able to manage MCP server tools and configuration → `mcp-server-tab.spec.ts`
- [x] user must be able to add and delete MCP server from sidebar → `mcp-server.spec.ts`
- [x] STDIO MCP server fields should persist after saving and editing → `mcp-server.spec.ts`
- [x] HTTP/SSE MCP server fields should persist after saving and editing → `mcp-server.spec.ts`
- [x] mcp server tools should be refreshed when editing a server → `mcp-server.spec.ts`
- [x] Streamable HTTP MCP server with server-everything should load tools correctly → `mcp-server.spec.ts`
- [x] stdio command with an embedded argument is refused, and command plus args is accepted → `mcp-server.spec.ts`
- [x] a registered MCP server is read back individually with the fields it was created with → `mcp-server.spec.ts`
- [x] PATCH updates a registered server, merges at the top level, and refuses to rename it → `mcp-server.spec.ts`

#### security/
- [x] the trace detail masks the credential whatever the secret field is called → `credential-secret-exposure.spec.ts`
- [x] the run resolves the credential without echoing it → `credential-secret-exposure.spec.ts`
- [x] a loopback address is refused, and the refusal names the allow-list → `ssrf-url-validation.spec.ts`
- [x] a blocked address the allow-list does not cover is refused the same way → `ssrf-url-validation.spec.ts`
- [x] an address inside a blocked range is admitted when a CIDR entry covers it → `ssrf-url-validation.spec.ts`
- [x] the refusal surfaces in the editor as an error, not a silent empty result → `ssrf-url-validation.spec.ts`
- [x] a code tweak is refused with a 422 naming the field, and the flow is left untouched → `tweaks-injection.spec.ts`
- [x] the refusal is field-scoped: an unprotected field on the same node still applies → `tweaks-injection.spec.ts`
- [x] a protected field on a code-execution component refuses the whole request, and the benign tweak sent with it does not land → `tweaks-injection.spec.ts`

#### ui-ux/
- [x] select and delete a flow → `actionsMainPage-shard-1.spec.ts`
- [x] serializes created_at/expires_at with UTC offset and no microseconds → `api-keys-timezone-display.spec.ts`
- [x] renders API key timestamps in the viewer's local timezone → `api-keys-timezone-display.spec.ts`
- [x] zoom in and zoom out step the canvas scale and clamp at the React Flow bounds → `canvas-zoom-navigation.spec.ts`
- [x] Fit View centers every node inside the canvas viewport → `canvas-zoom-navigation.spec.ts`
- [x] Fit View is reachable from the canvas controls toolbar → `canvas-zoom-navigation.spec.ts`
- [x] wheel scroll navigates the canvas anchored at the pointer → `canvas-zoom-navigation.spec.ts`
- [x] user can edit the text of an existing sticky note and the canvas reflects only the new text → `edit-sticky-note-text.spec.ts`
- [x] executing flow with network error shows error feedback → `execution-error-notification.spec.ts`
- [x] executing flow with server error shows error feedback → `execution-error-notification.spec.ts`
- [x] user must see on handle click the possibility connections → `filterSidebar.spec.ts`
- [x] create a Generic global variable from Settings page → `global-variable-edit.spec.ts`
- [x] edit existing global variable by clicking its row → `global-variable-edit.spec.ts`
- [x] create a Generic type global variable → `global-variables-crud.spec.ts`
- [x] delete a global variable removes it from the list → `global-variables-crud.spec.ts`
- [x] Credential variable value is hidden from the variable list → `global-variables-crud.spec.ts`
- [x] user can search and add components using keyboard shortcuts → `keyboardComponentSearch.spec.ts`
- [x] LangflowShortcuts → `langflowShortcuts.spec.ts`
- [x] the main menu lists every item, reports the running version and links out → `main-menu-actions.spec.ts`
- [x] the main menu's Settings action navigates to the Settings page → `main-menu-actions.spec.ts`
- [x] user must be able to minimize and expand a component → `minimize.spec.ts`
- [x] User should be able to interact notifications tab → `notifications.spec.ts`
- [x] right-clicking a component selects it and opens its options menu → `right-click-dropdown.spec.ts`
- [x] an item picked from the right-click menu acts on that component → `right-click-dropdown.spec.ts`
- [x] right-clicking the canvas background opens no menu and dismisses an open one → `right-click-dropdown.spec.ts`
- [x] Settings General section loads and shows its header → `settings-general-section.spec.ts`
- [x] Settings Messages section is accessible → `settings-general-section.spec.ts`
- [x] Settings Shortcuts section is accessible and lists shortcuts → `settings-general-section.spec.ts`
- [x] Settings > Messages displays sent messages in correct order with working filters → `settings-message-history.spec.ts`
- [x] user can access Settings page from the profile menu → `settings-navigation.spec.ts`
- [x] Settings page shows all main sections in sidebar navigation → `settings-navigation.spec.ts`
- [x] Settings Shortcuts section lists keyboard shortcuts → `settings-navigation.spec.ts`
- [x] Settings Model Providers section loads with provider configuration → `settings-navigation.spec.ts`
- [x] dark and light mode toggle correctly updates the body class → `settings-theme-toggle.spec.ts`
- [x] double-click on a sidebar component adds it to the canvas → `sidebar-add-component.spec.ts`
- [x] dragging a sidebar component drops the node at the pointer → `sidebar-add-component.spec.ts`
- [x] an added component arrives with its catalog default settings → `sidebar-add-component.spec.ts`
- [x] searching by name lists the matching component and hides the others → `sidebar-search-and-filter.spec.ts`
- [x] a query with no match shows the empty state and clearing restores the tree → `sidebar-search-and-filter.spec.ts`
- [x] a provider query groups its components under the provider bundle → `sidebar-search-and-filter.spec.ts`
- [x] category disclosures collapse and expand their component list → `sidebar-search-and-filter.spec.ts`
- [x] adding a sticky note places it on the canvas and in the flow → `sticky-notes.spec.ts`
- [x] changing a sticky note colour repaints it and persists the choice → `sticky-notes.spec.ts`
- [x] resizing a sticky note grows it and persists the new size → `sticky-notes.spec.ts`

---

### 🔵 Phase 1 — Next Delivery

> Validate (`[-]`) and create (`[ ]`) in the modules below. See details in Part II.

| Module | Validate (`[-]`) | Create (`[ ]`) |
|--------|-----------------|---------------|
| `api/flows/` — REST API | 4 | 0 |
| `core-components/` — Component Config | 3 | 0 |
| `core-components/` — Core Components | 3 | 1 |
| `core-functionality/auth/` | 2 | 0 |
| `core-functionality/llm-agents/` | 3 | 3 |
| `core-functionality/model-provider/` | 2 | 0 |
| `core-functionality/playground/` | 3 | 1 |
| `mcp/client/` | 2 | 2 |
| `mcp/server/` | 1 | 1 |
| `ui-ux/` — Canvas | 0 | 0 |

---

### 🟡 Phase 2 — Next Delivery

> Remaining modules after Phase 1 completion. See details in Part II.

| Module | Validate (`[-]`) | Create (`[ ]`) |
|--------|-----------------|---------------|
| `core-functionality/observability-monitoring/` | 0 | 0 |
| `core-functionality/knowledge-ingestion/` | 0 | 0 |
| `flow-functionality/` | 1 | 4 |
| `core-functionality/project-management/` | 6 | 0 |
| `core-functionality/templates/` | 0 | 28 |
| `ui-ux/` — Settings | 0 | 0 |
