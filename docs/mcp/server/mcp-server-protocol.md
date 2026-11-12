# MCP Server — flow-as-server endpoint & tool execution over the MCP protocol

**Last validated:** Langflow 1.14.x (nightly `1.14.0.dev25`, #2412) · first
promoted on 1.12.x

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

### Scope decision — resource-by-URI split out; prompt-template not covered

- §14.1 **"Resource exposed by server is accessible via URI"** IS covered — a
  later scout found that a flow's **uploaded files** are exposed as MCP
  resources. That dimension lives in the sibling `mcp-server-resources.spec.ts`
  (`resources/list` + `resources/read`). On 1.12.x `resources/read` hits a live
  Langflow regression (LE-2012) and is kept as a guard, not promoted; see that
  spec's doc.
- §14.1 **"Prompt exposed by server returns correct template"** — **no product
  surface**: the MCP server's `prompts/list` returns `[]`; left `[ ]` with a
  note (asserting emptiness was rejected — it would be a false regression the
  moment Langflow implements the primitive).

---

## Tags *(required)*

`@stable` `@regression` `@api` `@mcp`

**`@stable` — promoted under #948** after repeated clean `--workers=1
--retries=0` runs on nightly 1.12.0.dev4 and a per-assertion force-failure check. `@api` — the MCP protocol is exercised over HTTP JSON-RPC; `@mcp` — MCP
server area; `@regression` — guards a server-exposure/execution regression.

---

## Preconditions *(optional)*

- Langflow running at `PLAYWRIGHT_BASE_URL`; auto-login superuser.
- **An API key is the transport credential.** The specs mint one with
  `createApiKey` (`tests/helpers/auth/create-api-key.ts`) and send it as
  `x-api-key`; the `auto_login` session JWT is refused with `403` by
  `/api/v1/mcp/project/{id}/streamable` (measured on 1.12.0.dev33, on a project
  with no `auth_settings` — the table in
  `tests/tests-automations/regression/mcp/CLAUDE.md` → *Authenticating against the
  MCP transport*; on an `apikey` project a call without `x-api-key` is refused
  `401` at the project gate, whatever else it carries). The key is deleted in
  teardown. No lane sets `LANGFLOW_SKIP_AUTH_AUTO_LOGIN`, on purpose.
- **The spec owns its project** — created with `createProjectViaApi` and an
  **explicit** `auth_settings: { auth_type: "apikey" }`; its id is the MCP project
  id. Until #2412 the spec took the first entry of `GET /api/v1/projects/` (the
  "Starter Project"). That broke twice: the list has no `ORDER BY`, so "first" was
  never a contract; and the default project's auth changed under it (see *Notes*).
  An explicit `apikey` project gives the keyless refusal the same answer on every
  build: the project gate's `401` is identical on `1.13.1`, `1.14.0.dev22` and
  `1.14.0.dev25`.
- Passthrough fixture `tests/assets/flows/chat-io-ok-trace-fixture.json`
  (ChatInput → ChatOutput; echoes its input). No provider key / LLM required.
- Parallel-safe: the project, the flow and the action name are all the spec's own,
  so no other spec shares its MCP tool namespace.

---

## Step by step *(required)*

**Setup (API only)**

1. Create the spec's project (`createProjectViaApi`,
   `authSettings: { auth_type: "apikey" }`); its id is `projectId`.
2. Mint an API key (`createApiKey`) — every call to the streamable transport below
   carries it as `x-api-key`, and it is deleted in `afterAll`.
3. Create a passthrough runnable flow **in that project** via
   `createRunnableChatFlowViaApi(request, headers, { folderId: projectId })` —
   ChatInput → ChatOutput, echoes `input_value`.
4. Expose it as an MCP tool: `PATCH /api/v1/mcp/project/{projectId}` with
   `{ settings: [{ id: <flowId>, mcp_enabled: true, action_name: <unique>, action_description }] }`.
   The action name is unique per run (`e2e_echo_<suffix>`).

---

**Test 1 — generated endpoint exposes the enabled flow** (§14.1)

1. `GET /api/v1/mcp/project/{projectId}/composer-url`.
2. **Validation:**
   - `streamable_http_url` equals `${baseURL}/api/v1/mcp/project/{projectId}/streamable`
     and `legacy_sse_url` ends with `/api/v1/mcp/project/{projectId}/sse` (the
     endpoint is generated for this project).
   - MCP `initialize` on the streamable endpoint returns
     `serverInfo.name === "langflow-mcp-project-{projectId}"`.
   - The **same `initialize` carrying no credential is refused with `401`**, and
     the body is the project gate's `API key required for this project`. The
     negative half of the credential assertion: 1.12.0.dev31 answered `200` to a
     keyless caller, so every other assertion here passed on a transport that
     authenticated nobody. On a build that predates the gate this step fails —
     that is the finding it exists to report, not a false positive.
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
- **The credential is asserted in both directions.** The positive assertions
  key on an API key sent as `x-api-key`; the paired keyless `initialize` must be
  `401` with the project gate's body. Either half alone is passable by an endpoint
  that asks for nothing — which is exactly what the transport did until
  1.12.0.dev33 (#1522).
- **Force-failure check** (CONTRIBUTING §2) is run during VERIFY on each hard
  assertion.

---

## What this test does not cover *(optional)*

- §14.1 resource-by-URI and prompt-template — no product surface (see Scope
  decision above).
- The MCP Server **UI** tab / add-server modal — covered by
  `mcp/server/mcp-server*.spec.ts`.
- MCP server **auth** settings beyond the one this spec sets: the `none` (public)
  and OAuth/composer paths, and the superuser fallback a project with no
  `auth_settings` falls to.
- Executing a flow that requires an LLM as an MCP tool (kept out for determinism).
- The legacy SSE transport execution path (only its URL shape is asserted; the
  streamable-HTTP transport carries the protocol interaction).

---

## External dependencies *(required)*

- `src/backend/base/langflow/api/v1/mcp.py` — the MCP server routes
  (`/api/v1/mcp/project/{id}`, `/composer-url`, `/streamable`, `/sse`) and the
  protocol handlers.
- `src/backend/base/langflow/api/v1/mcp_projects.py` — the per-project generated
  endpoint this spec calls, **and its credential gate**: on an `apikey` project a
  caller with no `x-api-key` (header or query param) is refused `401`
  `API key required for this project`; a project with no `auth_settings` instead
  falls to the superuser fallback, which refuses `403` unless
  `LANGFLOW_SKIP_AUTH_AUTO_LOGIN` is set. A change here is what turned these specs
  red in #1522.
- `src/backend/base/langflow/api/v1/auth_helpers.py` — `get_default_project_auth_settings`,
  which since `1.14.0.dev23` makes a project created under `AUTO_LOGIN=true`
  default to `apikey` (#2412). The spec no longer depends on the default, since it
  sets its project's auth explicitly; listed because this is what turned the old
  `403` assertion red.
- `src/backend/base/langflow/api/v1/mcp_utils.py` — the shared request/response
  plumbing both routers use.
- `src/lfx/src/lfx/services/mcp_composer/` (or equivalent) — the MCP server
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
- **No shared state since #2412:** the spec's project is its own, so its MCP
  settings and tool namespace are too. The unique `action_name` stays as a
  readable marker.
- **Cleanup:** in `afterAll`, the flow is deleted by id
  (`RunnableChatFlow.deleteFlow`), then the project (`deleteProject`, which also
  sweeps the API key the backend mints for an `auth_settings` project), then the
  spec's own API key.
- **Why the keyless refusal is `401` and not `403` (#2412).** The step used to
  assert `403`, the body of the superuser fallback a project with no
  `auth_settings` reaches under `AUTO_LOGIN=true`.
  - **What changed.** From `1.14.0.dev23` (also `release-1.13.2` / `1.13.3`),
    upstream #16186 + #16151 make every project `apikey` there, the default
    included: new ones at creation, existing ones on the MCP startup pass. The
    keyless call now stops one gate earlier, at the project's `401`.
  - **Not a security finding.** The daily triage read the change as "a keyless
    caller is admitted". Measured on `1.14.0.dev25`, it is still refused; only the
    gate that refuses it moved.
  - **The assertion now.** The spec states which gate it means, by giving its
    project `apikey` explicitly.
