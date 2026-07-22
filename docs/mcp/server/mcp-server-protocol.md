# MCP Server — flow-as-server endpoint & tool execution over the MCP protocol

**Last validated:** Langflow 1.11.x

---

## What this test validates *(required)*

Covers the two **coverable** items of QA-CHECKLIST §14.1 that concern a Langflow
**project exposed as an MCP server** (flow-as-server), exercised over the real
**MCP protocol** (JSON-RPC over the streamable-HTTP transport), not the UI:

1. **Flow exposed as MCP server — generated endpoint** (§14.1). A flow enabled as
   an MCP tool in a project is reachable at the project's generated MCP server
   endpoint, which correctly advertises itself and lists the enabled flow.
2. **Execute MCP server tool via MCP protocol** (§14.1). Calling that tool via
   `tools/call` runs the flow and returns its output through the protocol.

The tool under test is a **ChatInput → ChatOutput passthrough** flow (no LLM, no
provider key), so its output is a deterministic **echo** of the input — the test
sends a unique sentinel and asserts the tool result echoes exactly that sentinel.
This makes the execution assertion deterministic and proves the call actually
round-tripped through the MCP server (not a cached or canned response).

**Distinct from the existing `mcp/server/mcp-server*.spec.ts`**, which drive the
**UI** for *registering an external MCP server as a tool* (client-side, the
"Add MCP server" modal / MCP tab). This spec is the **server-side, protocol-level**
counterpart: Langflow *is* the MCP server and a client speaks the protocol to it.

If this fails, Langflow no longer exposes project flows as MCP-server tools, or no
longer executes them over the protocol — a core MCP-server regression.

### Scope decision — §14.1 items 667/668 are NOT covered (no product surface)

Scouted live on **1.11.0.dev49**: the project MCP server **advertises**
`resources` and `prompts` capabilities on `initialize`, but `resources/list` and
`prompts/list` both return **`[]`** — Langflow's MCP server exposes flows only as
**tools**; there is no UI or API to expose a resource-by-URI or a prompt template.
Therefore:

- §14.1 "Resource exposed by server is accessible via URI" — **no product surface**;
  left `[ ]` with a note (not a hollow test).
- §14.1 "Prompt exposed by server returns correct template" — **no product surface**;
  left `[ ]` with a note.

A comment recording this is posted on issue #829. Writing an assertion that these
lists are empty was rejected: it would be a false regression the moment Langflow
implements either primitive.

---

## Tags *(required)*

`@regression` `@api` `@mcp`

**`@stable` intentionally withheld (promotion gated — issue #829).** MCP is in the
current flaky cluster (#773) and the issue also flags MCP surface-health
dependencies (#809 / #643); promote only after the Wave 3 clean baseline.
`@api` — the MCP protocol is exercised over HTTP JSON-RPC; `@mcp` — MCP server
area; `@regression` — guards a server-exposure/execution regression.

---

## Preconditions *(optional)*

- Langflow running at `PLAYWRIGHT_BASE_URL`; auto-login superuser.
- A default project exists (`GET /api/v1/projects/` → the "Starter Project"); its
  id is the MCP project id.
- Passthrough fixture `tests/assets/flows/chat-io-ok-trace-fixture.json`
  (ChatInput → ChatOutput; echoes its input). No provider key / LLM required.
- Parallel-safe **per created flow** (unique flow name + unique action name), but
  the project MCP settings are shared state — see Notes; run `--workers=1` if the
  suite ever adds a second project-MCP spec.

---

## Step by step *(required)*

**Setup (API only)**

1. Resolve the default project id (`GET /api/v1/projects/`).
2. Create a passthrough runnable flow via `createRunnableChatFlowViaApi(request, headers)`
   — ChatInput → ChatOutput, echoes `input_value`.
3. Expose it as an MCP tool: `PATCH /api/v1/mcp/project/{projectId}` with
   `{ settings: [{ id: <flowId>, mcp_enabled: true, action_name: <unique>, action_description }] }`.
   The action name is unique per run (`e2e_echo_<suffix>`) to avoid colliding with
   other tools in the shared project.

---

**Test 1 — generated endpoint exposes the enabled flow** (§14.1)

1. `GET /api/v1/mcp/project/{projectId}/composer-url`.
2. **Validation:**
   - `streamable_http_url` equals `${baseURL}/api/v1/mcp/project/{projectId}/streamable`
     and `legacy_sse_url` ends with `/api/v1/mcp/project/{projectId}/sse` (the
     endpoint is generated for this project).
   - MCP `initialize` on the streamable endpoint returns
     `serverInfo.name === "langflow-mcp-project-{projectId}"`.
   - `tools/list` includes a tool whose `name` equals the unique `action_name`
     just enabled — the flow is exposed by the generated server.

---

**Test 2 — execute the exposed tool over the MCP protocol** (§14.1)

1. MCP handshake (`initialize` → `notifications/initialized`) on the streamable
   endpoint.
2. `tools/call` the unique `action_name` with
   `arguments: { input_value: "<unique sentinel>" }`.
3. **Validation:** the JSON-RPC result has `isError === false` and
   `content[0].text === "<the same sentinel>"` — the passthrough flow ran and
   echoed the exact input back through the protocol.

---

## Validation criterion *(required)*

- **Endpoint (T1):** the project's composer-url yields the correctly-shaped
  streamable/SSE URLs for `{projectId}`, `initialize` reports
  `serverInfo.name = langflow-mcp-project-{projectId}`, and `tools/list` contains
  the just-enabled unique action name.
- **Execute (T2):** `tools/call <action_name> { input_value: S }` returns
  `isError:false` and `content[0].text === S` for a unique sentinel `S` — proving
  the flow executed over the MCP protocol and returned its output.

## Guarding against false positives *(how)*

- **Unique sentinel echo:** the execute assertion keys on a per-run random
  sentinel, so a canned/empty/cached response cannot pass — the exact string must
  survive the round-trip through the passthrough flow.
- **Unique action name:** T1 asserts the *specific* enabled tool appears (not
  merely "some tool"), so a stale `simple_agent` in the shared project can't
  satisfy it.
- **Deterministic tool (no LLM):** the passthrough flow removes model
  non-determinism entirely, so a failure is a real protocol/exposure regression.
- **Force-failure check** (CONTRIBUTING §2) is run during VERIFY on each hard
  assertion.

---

## What this test does not cover *(optional)*

- §14.1 resource-by-URI and prompt-template — no product surface (see Scope
  decision above).
- The MCP Server **UI** tab / add-server modal — covered by
  `mcp/server/mcp-server*.spec.ts`.
- MCP server **auth** settings (`auth_settings`) and the OAuth/composer path.
- Executing a flow that requires an LLM as an MCP tool (kept out for determinism).
- The legacy SSE transport execution path (only its URL shape is asserted; the
  streamable-HTTP transport carries the protocol interaction).

---

## External dependencies *(required)*

- `src/backend/base/langflow/api/v1/mcp*` (MCP server routes:
  `/api/v1/mcp/project/{id}`, `/composer-url`, `/streamable`, `/sse`) — the
  generated endpoint and the protocol handlers.
- `src/backend/base/langflow/services/mcp*` (or equivalent) — the MCP server
  implementation that maps enabled flows to tools and executes `tools/call`.
- ChatInput / ChatOutput components — the passthrough must keep echoing its input.
- `tests/assets/flows/chat-io-ok-trace-fixture.json` — the passthrough fixture.

---

## When to review this test *(optional)*

- If the MCP server endpoint scheme (`/api/v1/mcp/project/{id}/streamable|sse`) or
  the `composer-url` payload changes.
- If the `serverInfo.name` convention changes.
- If Langflow starts exposing **resources** or **prompts** via the MCP server —
  then items 667/668 become coverable and this spec should be extended.
- On promotion to `@stable` once the #773 baseline is clean (issue #829 gate).

---

## Notes *(optional)*

- **Mechanism scouted on 1.11.0.dev49:** `GET .../composer-url` →
  `{ streamable_http_url, legacy_sse_url, uses_composer:false }`. `initialize` over
  the streamable transport is **stateless here** (no `mcp-session-id` header
  required); the response is an SSE frame `event: message\ndata: {json}`. The tool
  input schema for a flow is `{ input_value, session_id }`. Enabling a flow:
  `PATCH /api/v1/mcp/project/{id}` with `settings:[{id,mcp_enabled,action_name,action_description}]`
  (merges, does not wipe other enabled tools). `tools/call` returns
  `{ content:[{type:"text", text:<output>}], isError:false }`.
- **Shared-state caveat:** the project's MCP settings and its tool namespace are
  shared across the instance. The spec uses a unique `action_name` per run and
  deletes its own flow in teardown; it does not reset the whole project settings.
- **Cleanup:** the created flow is deleted by id in `afterAll`
  (`RunnableChatFlow.deleteFlow`); disabling it from the project follows from the
  flow no longer existing.
