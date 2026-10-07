# MCP Server – A Flow Is Exposed as an MCP Tool, End to End

**Last validated:** Langflow 1.13.x (nightly `1.13.0.dev34`)

---

## What this test validates *(required)*

One test, four observables, walking the whole path from "a flow exists" to "an MCP
client can talk to the project that exposes it". The flow lives in a **project of
its own**, created for the test, so every observable is about that project and that
flow and nothing else on the instance:

1. **The backend lists the flow as an MCP-enabled tool of its project.**
   `GET /api/v1/mcp/project/{project_id}` reports exactly one tool — the created
   flow — with `mcp_enabled: true` and the `action_name` derived from its name. The
   flow is posted with `mcp_enabled: true` explicitly, because the column defaults to
   `false` (the SPA's `createNewFlow` hardcodes `true`): a flow created over the API
   without it is never exposed as a tool.
2. **The MCP Server tab of that project shows THIS flow's badge.** The badge is
   addressed by its own testid, `tool_<action name>`, built from the flow's unique
   name, and the tab shows **exactly one** tool badge — not a `count > 0` that would
   pass for any unrelated flow.
3. **The connection config advertises this project's endpoint.** The JSON tab must
   render a URL containing `mcp/project/<this project's id>/streamable`.
4. **That endpoint actually answers the MCP handshake.** A JSON-RPC `initialize`
   against `POST /api/v1/mcp/project/{project_id}/streamable` — the same project —
   returns `200`.

**The credential on step 4 is the assertion, not plumbing (#1522).** This POST used
to carry no credential at all and assert `200`, which `1.12.0.dev31` answered — that
build served the transport to anyone, so the assertion passed while exercising no
auth whatsoever. Since `1.12.0.dev33` a keyless caller is refused `403`. The test
therefore mints a real API key, sends it as `x-api-key` (the only credential the
transport accepts — a JWT is also refused), and deletes the key in `finally`.

---

## Tags *(required)*

`@stable` `@mcp` `@regression`

`@stable` was removed together with a `test.fixme` at triage of #2198 and is restored
by the fix that made the precondition deterministic (see *Why a dedicated project*).

---

## Step by step *(required)*

1. Create a project of its own with `createProjectViaApi` (prefix `e2e-mcp-regression`,
   no `auth_settings`, so the backend mints no key for it).
2. Create a wired `ChatInput → ChatOutput` flow inside it with `createFlow`, from the
   fixture `tests/assets/flows/chat-io-ok-trace-fixture.json`, named
   `E2E MCP <16 hex>`, with `folder_id` = the project and `mcp_enabled: true`.
3. Read the project's tool listing back,
   `GET /api/v1/mcp/project/{project_id}?mcp_enabled=false` (the request the tab
   itself makes), and assert it holds exactly one tool: this flow's id, with
   `mcp_enabled: true` and `action_name` equal to the expected slug — see *How the
   slug is derived*. Polled for up to 10 s, so a slow write reads as "not listed yet"
   rather than as a UI failure; if it never lists, the failure names the backend
   half, not the tab.
4. Open the project's flows view (`/all/folder/{project_id}`), click `mcp-btn`, and
   assert the MCP Server title (`mcp-server-title`) is visible.
5. Assert the tools container (`div-mcp-server-tools`) is visible, that the badge
   `tool_<slug>` inside it is visible, and that the container holds exactly one
   `tool_*` badge.
6. Click the **JSON** tab and assert the rendered config contains
   `mcp/project/<project_id>/streamable` for this project's id.
7. Mint an API key (`createApiKey`, prefix `e2e-mcp-regression`), `POST` a JSON-RPC
   `initialize` (protocol `2024-11-05`) to this project's `streamable` route with
   `x-api-key`, and assert `200`.
8. **Cleanup:** the API key is deleted in `finally`; `afterEach` deletes the flow
   id-scoped through `deleteFlow`, then the project through the helper's
   `deleteProject` (which retries the #965 contention `500`), and fails the test if
   either one is left behind.

---

## Validation criterion *(required)*

The test fails if any of these does not hold, on a project that contains only the
created flow:

- `GET /api/v1/mcp/project/{project_id}?mcp_enabled=false` does not list exactly that
  flow with `mcp_enabled: true` and `action_name` = `e2e_mcp_<16 hex>`;
- the MCP Server tab of that project does not render the badge
  `tool_e2e_mcp_<16 hex>` inside `div-mcp-server-tools`, or renders any number of
  `tool_*` badges other than one;
- the JSON config does not carry `mcp/project/<project_id>/streamable` for this
  project's id;
- the `initialize` handshake against that endpoint answers anything but `200` while
  carrying a valid `x-api-key`.

---

## External dependencies *(required)*

- REST API: `POST /api/v1/projects/` and `DELETE /api/v1/projects/{project_id}`,
  `POST`/`DELETE /api/v1/flows/` (with `folder_id` and `mcp_enabled`),
  `GET /api/v1/mcp/project/{project_id}` (the tool listing the tab renders),
  `POST /api/v1/mcp/project/{project_id}/streamable` (Streamable HTTP transport,
  `x-api-key` only), and the API-key endpoints behind `createApiKey` /
  `deleteApiKey`.
- UI testids: `mcp-btn`, `mcp-server-title`, `div-mcp-server-tools`,
  `tool_<action name>`, and the **JSON** tab addressed by role/name. Route
  `/all/folder/{project_id}`.
- `src/backend/base/langflow/api/v1/mcp_projects.py` — the project-scoped MCP
  server: the `/{project_id}/streamable` route this spec handshakes against, and
  `_build_project_tools_response`, which lists a project's flows with **no
  `ORDER BY`** (insertion order on SQLite — measured).
- `src/backend/base/langflow/api/v1/projects.py` — project create/delete; deleting
  the project also removes the `lf-<project>` entry it registers under MCP servers
  (measured on `1.13.0.dev34`).
- `src/lfx/src/lfx/base/mcp/util.py` — `sanitize_mcp_name`, which derives the tool
  name from the flow name.
- `src/backend/base/langflow/api/v1/api_key.py` — the API-key endpoints behind
  `createApiKey` / `deleteApiKey`; the transport accepts `x-api-key` and nothing
  else (#1522).
- `src/frontend/src/pages/MainPage/pages/homePage/components/McpServerTab.tsx` —
  the MCP Server tab: resolves the project from the route's `folderId`, falling back
  to the default project; renders the title (`mcp-server-title`) and the JSON
  config panel.
- `src/frontend/src/pages/MainPage/pages/homePage/components/McpFlowsSection.tsx`
  and `src/frontend/src/components/core/parameterRenderComponent/components/ToolsComponent/index.tsx`
  — the tools list (`div-mcp-server-tools`): one `tool_<action name>` badge per
  enabled tool, **capped at 20**, the rest summarised as `+N more`.
- `src/frontend/src/pages/MainPage/pages/homePage/utils/mcpServerUtils.tsx` —
  `mapFlowsToTools`: a badge's name is the listing's `action_name`, and only
  `mcp_enabled` flows count.
- Helpers: `tests/helpers/flows/create-project-via-api.ts`,
  `tests/helpers/flows/create-flow.ts`, `tests/helpers/flows/delete-flow.ts`,
  `tests/helpers/auth/create-api-key.ts`, `tests/helpers/auth/get-auth-token.ts`.
- Asset: `tests/assets/flows/chat-io-ok-trace-fixture.json`.
- No LLM or provider API key required — the flow is never run, only exposed.

---

## Why a dedicated project (#2198) *(optional)*

Until #2198 the flow was created in the superuser's **default** project and the test
asserted its name was visible in that project's tools list. That holds only while the
default project has fewer than 20 MCP-enabled flows ahead of the new one, and nothing
in the test controlled that:

- **The tab renders at most 20 badges.** `ToolsComponent` slices the enabled tools to
  `visibleActionsQt = isAction ? 20 : 4` and summarises the rest as `+N more`. The
  full list is only in the *Edit tools* modal. This is a design choice, not a defect.
- **The listing has no order, and on SQLite it is insertion order** — the newest flow
  comes last. Measured on `1.13.0.dev34`: with 22 MCP-enabled flows seeded in the
  default project before the test's own, the tab rendered `SEED_2198_01` …
  `SEED_2198_20` and `+4 more`, and the test failed with exactly the signature the
  VM dailies recorded — `getByTestId('div-mcp-server-tools').getByText('E2E_PLAYGROUND_<id>')`,
  `element(s) not found`, container visible.
- **The default project is shared.** Every flow a parallel spec creates without a
  `folder_id` lands there, and so does every flow the "New Flow" entry point creates,
  all of them MCP-enabled. On a backend serving a full shard the count crosses 20
  whenever enough of them are alive at once — which is also why the retry passed:
  by then some of those specs had cleaned up.

A project of its own makes the precondition a constant (one flow, one badge) instead
of a function of what else the instance is running, and it lets steps 6 and 7 assert
against **the project that exposes the flow** instead of `projects[0]` of a listing
whose order is not specified either. Raising the 30 s timeout could not have helped:
the badge is not slow, it is never rendered.

---

## How the slug is derived *(optional)*

`sanitize_mcp_name(name, max_length=46)` strips emoji and diacritics, replaces every
run of spaces **and hyphens** with a single `_`, collapses repeats, trims leading and
trailing `_`, **lowercases**, and truncates at 46 characters. The badge's testid is
`testIdCase("tool_" + action_name)` — lowercased, whitespace to `_` — which leaves an
already-sanitised name unchanged.

The flow is named `E2E MCP <16 hex>`: letters, digits and single spaces only, so the
expected slug is simply the name lowercased with spaces turned into `_`
(`e2e_mcp_<16 hex>`, 24 characters). The test derives that expectation itself and
asserts the listing's `action_name` against it, so a backend that derived a different
name would fail at step 3 rather than silently render a badge the test then looks up
by the same wrong name. The name stays well under both cuts that apply to it (46 in
the listing, 30 in `tools/list`), and the 16 hex digits are what make the badge about
this flow and no other.

---

## What this test does not cover *(optional)*

- The default project's tools list, and the `+N more` summary past 20 badges.
- Executing the exposed tool over the protocol (`tools/list`, `tools/call`) and the
  keyless-`403` assertion in isolation — `mcp-server-protocol.spec.ts`.
- Registering an **external** MCP server (stdio / HTTP / SSE forms) —
  `mcp-server.spec.ts`.
- Selecting **which** flows a project exposes (`GET`/`PATCH /{project_id}`) —
  `mcp-server-project-config.spec.ts`.
- Flow files exposed as MCP **resources** — `mcp-server-resources.spec.ts`.
- MCP prompts (`prompts/list`) — no product surface; the server returns `[]` (#829).

---

## Preconditions *(optional)*

- A running Langflow instance at `PLAYWRIGHT_BASE_URL`, in auto-login mode or with
  the superuser credentials configured.
