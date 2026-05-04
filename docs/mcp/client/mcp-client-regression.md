# MCP Client – Configure and Execute Tool

**Last validated:** Langflow 1.10.x

---

## What this test validates *(required)*

Validates the full MCP client configuration and tool execution path — without an LLM agent. Covers four scenarios: JSON-based server config with echo tool execution, unreachable HTTP server producing an empty tool dropdown, HTTP form tab server registration, and numeric tool execution (`get-sum`). If these tests fail, users cannot connect external MCP servers or run their tools from within a Langflow flow.

---

## Tags *(required)*

`@mcp` `@regression`

---

## Step by step *(required)*

**Test 1 — JSON config → echo tool**

1. Open a blank flow
2. Delete any existing `everything` MCP server via API
3. Open add-server modal → JSON tab; fill config for `npx @modelcontextprotocol/server-everything`
4. Save and poll `GET /api/v2/mcp/servers?action_count=true` until `toolsCount` is non-null
5. Add MCPTools component; open dropdown and select `echo-0-option`
6. Fill `popover-anchor-input-message` with `"oi"`; click Run
7. Open output inspection and verify result contains `"oi"`

**Test 2 — Unreachable HTTP server → empty tool dropdown**

1. Open a blank flow; delete any existing `bad-server` via API
2. Open add-server modal → HTTP tab; set name `bad-server`, URL `http://localhost:1/mcp`
3. Save and confirm `add-component-button-bad-server` appears in sidebar
4. Add MCPTools component; wait 5s for backend connection attempt
5. Open tool dropdown and verify zero options are listed

**Test 3 — HTTP form tab registration**

1. Open a blank flow; delete any existing `http-form-server` via API
2. Open add-server modal → HTTP tab; set name `http-form-server`, URL `http://localhost:1/mcp`
3. Save; confirm modal closes and `add-component-button-http-form-server` appears
4. Call `GET /api/v2/mcp/servers` and confirm entry with name `http-form-server` exists

**Test 4 — Numeric tool (`get-sum`)**

1. Open a blank flow; register `everything` server via JSON and poll `toolsCount` non-null
2. Add MCPTools component; open dropdown and select `get-sum-6-option`
3. Fill `float_float_a=3` and `float_float_b=5`; click Run
4. Open output inspection and verify dialog contains `"The sum of 3 and 5 is 8."`

---

## Validation criterion *(required)*

- Test 1: output popover contains `"oi"` after echo tool execution
- Test 2: tool dropdown has zero options after unreachable server is registered
- Test 3: `add-component-button-http-form-server` visible and API confirms server persisted
- Test 4: output dialog contains `"The sum of 3 and 5 is 8."`

---

## External dependencies *(required)*

- `src/frontend/src/pages/FlowPage/components/flowSidebarComponent/components/McpSidebarGroup.tsx` — `sidebar-add-mcp-server-button` and component list in sidebar
- `src/frontend/src/modals/addMcpServerModal/index.tsx` — JSON tab, HTTP tab, and save flow; testids `json-tab`, `http-tab`, `http-name-input`, `http-url-input`, `add-mcp-server-button`
- `src/frontend/src/components/core/parameterRenderComponent/components/mcpComponent/index.tsx` — `dropdown_str_tool` on the canvas node
- `src/backend/base/langflow/api/v2/mcp.py` — `GET /api/v2/mcp/servers?action_count=true` and `DELETE /api/v2/mcp/servers/{name}` endpoints
- npm package `@modelcontextprotocol/server-everything` — external dependency launched via `npx`

---

## What this test does not cover *(optional)*

- MCP client usage with an LLM agent (covered in `mcp-client-agent.spec.ts`)
- MCP stdio form tab (JSON config covers the same backend path)
- MCP resources and prompts (not currently exposed in MCPTools component UI)

---

## Preconditions *(optional)*

- Langflow running at `PLAYWRIGHT_BASE_URL`
- `npx` available on the system PATH where Langflow runs
- No LLM or API key required — all tools are synchronous

---

## Notes *(optional)*

- The npx process takes 5–30 seconds to start. Tests 1 and 4 poll `GET /api/v2/mcp/servers?action_count=true` (up to 90s) until `toolsCount` is non-null before interacting with the canvas node.
- Tool dropdown interactions use `page.evaluate((el) => el.click())` instead of Playwright's `.click()` to avoid viewport and overlay constraints.
- The `get-sum` tool option testid is `get-sum-6-option` — index 6 reflects its position in `server-everything`'s tool list and may shift if the package reorders tools in a future release.
- Test 2 uses `page.waitForFunction` to confirm the dropdown is genuinely open before asserting zero options, preventing a false-positive where the evaluate click fails silently.
