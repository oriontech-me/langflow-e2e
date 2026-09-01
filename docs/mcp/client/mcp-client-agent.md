# MCP Client – Agent Using MCPTools

**Last validated:** Langflow 1.12.x (1.12.0.dev19)

---

## What this test validates *(required)*

Validates that an LLM agent can discover and call an MCP tool mid-conversation via the MCPTools component. The agent receives a prompt instructing it to call the `echo` tool and the test verifies the echoed value appears in the Playground response. This is the primary real-world use case for MCP client: a user builds a flow where the agent has access to external tools via MCP.

---

## Tags *(required)*

`@mcp` `@agents` `@regression`

---

## Step by step *(required)*

1. Load the Simple Agent template with this spec's **own** `loadAgent` (parameterized by `models.json`) — *not* `SimpleAgentTemplatePage.load()`, for the reason in *Why this spec loads the agent itself* below — then block until the Agent node's persisted **provider binding** has settled
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
- **Precondition, asserted rather than assumed:** before the Playground is opened, the persisted Agent node names the **provider** of the requested model. A failure here is reported with the shared verdict taxonomy (`settled` / `default-provider` / `no-model` / `read-failed` / …) rather than a bare mismatch, so a run that never managed to read the flow is not reported as a wrong binding (#1371, the `read-failed` distinction #1261 needed).

> **1.12 rendering (why the locators changed).** Through ~1.11 the tool call surfaced as a `.cursor-pointer` accordion row reading `"Called tool ECHO"`; on 1.12 the Playground renders it as a **testid** `tool_echo` inside `div-tools_tools_metadata` under an **"Agent Steps"** block, and the AI message container moved from `div-chat-message` to `chat-message-AI-<text>`. The tool round-trip itself is unchanged and healthy — verified on `1.12.0.dev0` via `GET /api/v1/monitor/messages` (`content_blocks: ["tool_use|text|text"]`, `tool_use name=echo`, `text="Echo: hello mcp"`). The old text-based selectors were stale drift (#894), not a product regression.

---

## External dependencies *(required)*

- `src/frontend/src/pages/FlowPage/components/flowSidebarComponent/components/McpSidebarGroup.tsx` — `sidebar-add-mcp-server-button` and MCP component list
- `src/frontend/src/modals/addMcpServerModal/index.tsx` — JSON tab; testids `json-tab`, `json-input`, `add-mcp-server-button`
- `src/backend/base/langflow/api/v2/mcp.py` — `GET /api/v2/mcp/servers?action_count=true` and `DELETE /api/v2/mcp/servers/{name}`
- `src/frontend/src/components/core/parameterRenderComponent/components/mcpComponent/index.tsx` — tool mode toggle and toolset handle
- `src/frontend/src/components/core/chatComponents/ContentBlockDisplay.tsx` (+ the Playground tool-metadata renderer) — emits the `div-tools_tools_metadata` / `tool_<name>` testids and the "Agent Steps" block asserted by Proofs #1–#2
- npm package `@modelcontextprotocol/server-everything` — launched via `npx`
- `tests/helpers/flows/agent-credential-settle.ts` — the shared probe, verdict taxonomy and failure formatter this spec's load guard settles on (#1274/#1371). Only the pure functions are shared; the wait loop is this spec's own
- `tests/helpers/flows/load-template-by-name.ts` — loads the Simple Agent template and returns the created flow id
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

- MCP server registration happens after the template loads; server data lives in a separate DB table and survives flow teardown.
- The test is parameterized: one describe block is generated per active provider in `models.json`. Run with `--workers=1` to prevent parallel workers from deleting each other's flows.

### Why this spec loads the agent itself, and what its guard settles on (#1371)

This spec does **not** call `SimpleAgentTemplatePage.load()`, and until #1371 this
document said three times that it did — in step 1, in the dependency list and here.
That staleness is part of how the defect below survived two sweeps: a reader checking
whether this spec used the shared, already-migrated guard would read the doc, see the
page object named, and conclude it did.

**Why it loads the agent itself.** `SimpleAgentTemplatePage.load()` always runs
`providerSetupMap[provider]`, which opens the Model Providers panel and enables *every*
model of the provider — each enable is a live synchronous credential validation that
blocks the single-worker backend for ~35 s when the provider throttles it (#922/#927).
This spec's `selectPinnedModel` picks the pinned model straight from the Agent dropdown
and falls back to the shared setup only when the model is not offered. Adopting `load()`
outright would delete the divergence at the cost of that, so the guard is re-pointed onto
the shared axis while the cheap load path stays.

**What the guard settles on.** The **provider of the persisted model**
(`model.value[0].provider`), never `template.api_key.value`. Upstream
[#14311](https://github.com/langflow-ai/langflow/pull/14311) (*"stop automatic provider
field binding"*, on the 1.12 line since 2026-08-04) deleted the block that wrote the
credential variable name into `api_key`; measured on `1.12.0.dev18`/`dev19` it reads
`{value: "", load_from_db: false}` from mount onward on **every** build, for every
provider. A guard waiting for that transition cannot settle — it can only spend its
budget and fail. This spec carried the last surviving assertion on that field, missed by
#1274 (which migrated the shared helper and 19 `@stable` specs with it) and by #1334
(whose sweep grepped `credential:`, a spelling this copy does not use).

The provider is not a weaker proxy for the credential: with `api_key` empty the runtime
resolves the key **from** it — `instantiation.py` reads `model.value[0].provider` and
calls `get_api_key_for_provider`, which falls through to
`get_provider_secret_variable_key(provider)`. #1334 proved that causally: dropping only
that provider's own credential turns the run into `401 … Incorrect API key provided:
EMPTY` while the binding is unchanged.

The race #751 exists for is unchanged and still real, which is why the guard is
re-pointed rather than deleted: a freshly mounted Agent node carries the selector's
default (`claude-opus-5` / Anthropic) and only later flips to the requested model, so a
caller that reaches the Playground in between runs the wrong provider's model.

- **Test title changed in #1184 when `MODEL_TEST_ID` is set.** This spec used to carry its own copy of the target resolver, and that copy labelled the pinned target `model:<id>` rather than `<provider> / <id>`. Under the shared `resolveTestTargets()` it matches every other parametrized spec:

  | | Describe title with `MODEL_TEST_ID=gpt-4o-mini` |
  |---|---|
  | Before | `MCP Client – Agent using MCPTools [model:gpt-4o-mini]` |
  | After | `MCP Client – Agent using MCPTools [openai / gpt-4o-mini]` |

  The new title is the better one — it names the provider, which the old one hid — but it is a **change of test identity**, and identity is the key for `results.json` and `spec-durations.json`. So this test's history on the pinned lanes starts fresh: `pr-validation.yml` pins today (#1169), and `daily-stable.yml` will once #1185 lands. Recorded here rather than discovered later from a duration outlier or a reset flake rate.
- Handle testids for the connection step: `handle-mcp-shownode-toolset-right` (MCPTools output — normalized to `mcp`, not `mcp tools`) and `handle-agent-shownode-tools-left` (Agent tools input).
