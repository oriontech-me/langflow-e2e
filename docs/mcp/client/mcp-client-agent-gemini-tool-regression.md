# MCP Client – Gemini Tool-Calling Regression (#440)

**Last validated:** Langflow 1.11.x
**Tracking issue:** oriontech-me/langflow-e2e #858 · **Upstream bug:** langflow-ai/langflow #440

---

## What this test validates *(required)*

Guards the **Gemini × MCP tool-calling** path in isolation: a Google/Gemini
agent connected to an MCP tool must actually **invoke** that tool, not answer
from memory. This is the exact behavior broken by upstream bug **#440** — on
1.11.0 `gemini-2.5-flash` calls native Langflow tools (URL, Web Search,
Calculator) but silently does **not** call MCP tools (`echo`).

The behavior was invisible to the existing suite for three compounding reasons,
all confirmed against `reports/daily-history.jsonl`:

1. **Serial-skip cascade.** `mcp-client-agent.spec.ts` runs its three provider
   variants (openai → anthropic → google) under a single file-scope
   `mode: "serial"` group. The OpenAI variant runs first and flakes almost
   daily on an unrelated `toBeHidden` (Stop button) timeout; in serial mode a
   failure **skips every later test**, so the Gemini variant — the only one that
   exercises #440 — is skipped before it runs (matches the 46–53 daily skips).
2. **No provider label in the signal.** The daily history records only the bare
   `test()` title (no `[provider/model]`), so even the one day the true #440
   signature fired (2026-07-13, `"agent answered without invoking any tool"`) it
   was indistinguishable from a generic/OpenAI failure.
3. **Signal drowned in flake noise.** The same test fails most days with a
   different (`toBeHidden`) signature, so the real #440 line reads as "that
   flaky MCP test again."

This guard neutralizes all three: its own file (no shared serial group),
Gemini pinned and named in the test title (self-attributing signal), and a
unique assertion read from the monitor API (backend truth, immune to frontend
selector drift and to the `toBeHidden` flake).

**Direction of the assert.** While #440 is **open upstream**, the test asserts
the **currently-broken** behavior — the agent runs and answers but invokes **no**
`echo` MCP tool — and therefore **passes** today. It **flips red the moment
Langflow fixes #440** (an `echo` tool_use block starts being persisted): a red
here is the promote signal — remove this guard and fold Gemini back into
`mcp-client-agent`'s coverage.

`test.fail()` was deliberately **rejected**. It converts *any* failure (a broken
bootstrap, a down instance, an unregistered MCP server) into a green "expected
failure" — proven live during authoring, where the test went green without ever
reaching the #440 assertion because the template load timed out. That reproduces
the very signal-masking this guard exists to escape. Instead, all setup asserts
stay **loud** (infra breakage goes genuinely red), and only the final monitor-API
check encodes the expected #440 state.

---

## Tags *(required)*

`@mcp` `@agents` `@regression` `@model-provider`

> **No `@stable` yet (intentional).** The test genuinely passes while #440 is
> open (it asserts the broken state), so it is `@stable`-eligible in principle —
> but it is held out of `@stable` until team-validated against a nightly with the
> UI served, since authoring could only validate it statically (typecheck + lint)
> against an API-only local instance. Promote after one green nightly run.
> Absence tracked by upstream #440.

---

## Step by step *(required)*

1. Pin the Gemini model via `resolveGeminiModel()`; `test.skip` on
   `MODEL_NOT_AVAILABLE` or missing Google env key. All setup steps below use
   loud asserts — infra breakage fails the test genuinely.
2. Load Simple Agent template via `SimpleAgentTemplatePage` with
   `{ provider: "google", model: <resolved gemini> }`.
3. Delete any existing `everything` MCP server via API, then register via the
   JSON tab; poll `GET /api/v2/mcp/servers?action_count=true` until `toolsCount`
   is non-null.
4. Add MCPTools to canvas; enable tool mode (`tool-mode-button`) — verify a new
   "toolset" badge appears.
5. Connect MCPTools toolset output handle → Agent tools input handle.
6. Open Playground and send `"Use the 'echo' tool to echo: hello mcp (<nonce>)"`
   (atomic set-value + send, per the #226 prefill-race hardening).
7. Wait for the agent to finish; poll `GET /api/v1/monitor/messages` until the
   agent turn for this session (keyed by the nonce) is persisted.
8. Assert (pipeline ran): the final reply contains the echoed payload
   (`hello mcp`).
9. Assert (**the #440 flip**): the count of persisted `tool_use` blocks named
   `/echo/i` for the session is **0** — Gemini invoked no `echo` MCP tool.

---

## Validation criterion *(required)*

- **While #440 open:** step 8 passes (a reply with `hello mcp` is produced) **and**
  step 9's `echoToolUseCount === 0` holds → the test **passes**, documenting the
  bug. A false pass — the count reading 0 because the pipeline never ran — is
  prevented by step 8 (the persisted reply proves the agent completed a turn, so
  a tool call was genuinely possible) and by the loud setup asserts (a broken
  bootstrap / MCP registration fails before reaching step 9).
- **When #440 is fixed:** an `echo` `tool_use` block is persisted →
  `echoToolUseCount > 0` → step 9 **fails loudly**, signalling that the guard
  must be removed and Gemini folded back into `mcp-client-agent` coverage.

---

## External dependencies *(required)*

- `tests/pages/SimpleAgentTemplatePage.ts` — loads Simple Agent template with configured provider/model
- `tests/helpers/provider-setup/resolve-gemini-model.ts` — pins a deterministic Gemini flash model
- `tests/helpers/provider-setup/` — provider env-key validation (`hasProviderEnvKeys`)
- `src/frontend/src/modals/addMcpServerModal/index.tsx` — JSON tab; testids `json-tab`, `json-input`, `add-mcp-server-button`
- `src/backend/base/langflow/api/v2/mcp.py` — `GET /api/v2/mcp/servers?action_count=true`, `DELETE /api/v2/mcp/servers/{name}`
- `src/frontend/src/components/core/parameterRenderComponent/components/mcpComponent/index.tsx` — tool mode toggle and toolset handle
- `GET /api/v1/monitor/messages` — persisted session messages; `content_blocks[].contents[]` with `type: "tool_use"` is the #440 observable
- npm package `@modelcontextprotocol/server-everything` — launched via `npx` (provides `echo`)
- **Upstream bug #440** — Langflow: Gemini does not invoke MCP tools (the behavior under guard)

---

## What this test does not cover *(optional)*

- Native tool calling with Gemini (URL / Web Search / Calculator) — already green
  in `agent-multi-tool-selection.spec.ts`; #440 is MCP-specific.
- Other providers × MCP (OpenAI, Anthropic) — covered by `mcp-client-agent.spec.ts`.
- Whether the Langflow fix is model-side or integration-side — the guard only
  asserts the observable (tool invoked).

---

## Preconditions *(optional)*

- `npx playwright test tests/collect-models.spec.ts` has populated
  `models.json` with at least one Google/Gemini model.
- `GOOGLE_API_KEY` present in the environment (daily provides it).
- Run with `--workers=1` (agent specs create named flows).
