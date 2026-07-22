# MCP Client – Agent Using MCPTools

**Last validated:** Langflow 1.12.x

---

## What this test validates *(required)*

Validates that an LLM agent can discover and call an MCP tool mid-conversation via the MCPTools component. The agent receives a prompt instructing it to call the `echo` tool and the test verifies the echoed value appears in the Playground response. This is the primary real-world use case for MCP client: a user builds a flow where the agent has access to external tools via MCP.

---

## Tags *(required)*

`@mcp` `@agents` `@regression`

---

## Step by step *(required)*

1. Load Simple Agent template via `SimpleAgentTemplatePage` (parameterized by `models.json`)
2. Delete any existing `everything` MCP server via API, then register via JSON tab
3. Poll `GET /api/v2/mcp/servers?action_count=true` until `toolsCount` is non-null
4. Add MCPTools component to canvas
5. Enable tool mode on MCPTools (`tool-mode-button`) — verify "toolset" label appears
6. Connect MCPTools toolset output handle → Agent tools input handle
7. Open Playground and send: `"Use the 'echo' tool to echo: hello mcp"`
8. Wait for agent to finish (Stop button disappears), best-effort expand any collapsed "Agent Steps" accordion
9. **Proof #1** — the Playground shows a tool-invocation block (`div-tools_tools_metadata`): the agent actually called a tool, it did not hallucinate a text-only answer
10. **Proof #2** — the invoked tool is `echo` (`tool_echo` testid, rendered "ECHO")
11. **Proof #3** — the last AI chat message (`[data-testid^="chat-message-AI-"]`) contains `"hello mcp"` — the echoed payload made the full round-trip and was surfaced to the user

---

## Validation criterion *(required)*

- The Playground renders a tool-invocation block for the `echo` tool (Proofs #1–#2) AND the agent's final response contains `"hello mcp"` (Proof #3) — together confirming the MCP echo tool was called and its result returned to the user.

> **1.12 rendering (why the locators changed).** Through ~1.11 the tool call surfaced as a `.cursor-pointer` accordion row reading `"Called tool ECHO"`; on 1.12 the Playground renders it as a **testid** `tool_echo` inside `div-tools_tools_metadata` under an **"Agent Steps"** block, and the AI message container moved from `div-chat-message` to `chat-message-AI-<text>`. The tool round-trip itself is unchanged and healthy — verified on `1.12.0.dev0` via `GET /api/v1/monitor/messages` (`content_blocks: ["tool_use|text|text"]`, `tool_use name=echo`, `text="Echo: hello mcp"`). The old text-based selectors were stale drift (#894), not a product regression.

---

## External dependencies *(required)*

- `src/frontend/src/pages/FlowPage/components/flowSidebarComponent/components/McpSidebarGroup.tsx` — `sidebar-add-mcp-server-button` and MCP component list
- `src/frontend/src/modals/addMcpServerModal/index.tsx` — JSON tab; testids `json-tab`, `json-input`, `add-mcp-server-button`
- `src/backend/base/langflow/api/v2/mcp.py` — `GET /api/v2/mcp/servers?action_count=true` and `DELETE /api/v2/mcp/servers/{name}`
- `src/frontend/src/components/core/parameterRenderComponent/components/mcpComponent/index.tsx` — tool mode toggle and toolset handle
- `src/frontend/src/components/core/chatComponents/ContentBlockDisplay.tsx` (+ the Playground tool-metadata renderer) — emits the `div-tools_tools_metadata` / `tool_<name>` testids and the "Agent Steps" block asserted by Proofs #1–#2
- npm package `@modelcontextprotocol/server-everything` — launched via `npx`
- `tests/pages/SimpleAgentTemplatePage.ts` — loads Simple Agent template with configured provider/model
- `tests/helpers/provider-setup/` — provider env key validation and model parameterization

---

## What this test does not cover *(optional)*

- Multiple agents using different MCP servers simultaneously
- MCP resources and prompts (not exposed in MCPTools UI)

---

## Preconditions *(optional)*

- Langflow running at `PLAYWRIGHT_BASE_URL`
- `npx` available on the system PATH
- LLM provider API key configured (any provider in `models.json`)
- `tests/collect-models.spec.ts` run beforehand to populate `models.json`

---

## Notes *(optional)*

- `SimpleAgentTemplatePage.load()` deletes all existing flows before loading the template. MCP server registration must happen after the template loads, as server data lives in a separate DB table and survives the cleanup.
- The test is parameterized: one describe block is generated per active provider in `models.json`. Run with `--workers=1` to prevent parallel workers from deleting each other's flows.
- Handle testids for the connection step: `handle-mcp-shownode-toolset-right` (MCPTools output — normalized to `mcp`, not `mcp tools`) and `handle-agent-shownode-tools-left` (Agent tools input).
