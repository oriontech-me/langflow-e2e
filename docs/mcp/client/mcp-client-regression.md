# MCP Client – Configure and Execute Tool

**Last validated:** Langflow 1.10.x

---

## What this test validates *(required)*

Validates that a user can configure an MCP client connection via JSON, select a tool from the connected server, execute it directly on the canvas (without an LLM agent), and verify the result in the output inspection modal. If this test fails, users cannot connect external MCP servers or run their tools from within a Langflow flow.

---

## Tags *(required)*

`@mcp` `@regression`

---

## Step by step *(required)*

1. Open a blank flow
2. Delete any existing `everything` MCP server via API to ensure a fresh start
3. Navigate to the MCP sidebar (`sidebar-nav-mcp`) and open the add-server modal
4. Switch to the JSON tab and fill in the config: `npx @modelcontextprotocol/server-everything`
5. Save the server and wait for modal to close and `add-component-button-everything` to appear
6. Poll `GET /api/v2/mcp/servers?action_count=true` until `toolsCount` is non-null — confirms the npx process started and tools are available
7. Add the MCPTools component to the canvas
8. Open `dropdown_str_tool` via `page.evaluate` and select the `echo` tool
9. Fill `popover-anchor-input-message` with `"oi"`
10. Click Run on the MCPTools node
11. Click the output inspection button and verify the result contains `"oi"`

---

## Validation criterion *(required)*

- `add-component-button-everything` appears after saving, confirming the server was registered
- `echo-0-option` appears in the tool dropdown after `toolsCount` is confirmed non-null
- After running, the output popover contains `"oi"`, confirming the tool executed and echoed the input

---

## External dependencies *(required)*

- `src/frontend/src/pages/FlowPage/components/flowSidebarComponent/components/McpSidebarGroup.tsx` — `sidebar-add-mcp-server-button` and component list in sidebar
- `src/frontend/src/modals/addMcpServerModal/index.tsx` — JSON tab and save flow; testids `json-tab`, `json-input`, `add-mcp-server-button`
- `src/frontend/src/components/core/parameterRenderComponent/components/mcpComponent/index.tsx` — `mcp-server-dropdown` on the canvas node
- `src/backend/base/langflow/api/v2/mcp.py` — `GET /api/v2/mcp/servers?action_count=true` and `DELETE /api/v2/mcp/servers/{name}` endpoints
- npm package `@modelcontextprotocol/server-everything` — external dependency launched via `npx`

---

## What this test does not cover *(optional)*

- MCP server configuration via the stdio or HTTP form-based tabs (only JSON is tested)
- MCP client usage with an LLM agent
- MCP resources and prompts
- Error handling when the server is unreachable

---

## Preconditions *(optional)*

- Langflow running at `PLAYWRIGHT_BASE_URL`
- `npx` available on the system PATH where Langflow runs
- No LLM or API key required — the `echo` tool is synchronous

---

## Notes *(optional)*

- The npx process takes 5–30 seconds to start. The test polls `GET /api/v2/mcp/servers?action_count=true` (up to 90s) waiting for `toolsCount` to be non-null before interacting with the canvas node. Without this wait, the tool dropdown is empty because the backend has not yet connected to the server process.
- Tool dropdown interactions use `page.evaluate((el) => el.click())` instead of Playwright's `.click()` to avoid viewport and overlay constraints that prevent the click from reaching the element.
- The `echo` tool option testid is `echo-0-option` (pattern: `{toolName}-{index}-option`).
- The message input testid is `popover-anchor-input-message` (rendered as a popover input, not a textarea).
