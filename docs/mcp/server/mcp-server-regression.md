# MCP Server – A Flow Is Exposed as an MCP Tool, End to End

**Last validated:** Langflow 1.13.x (nightly `1.13.0.dev8`)

---

## What this test validates *(required)*

One test, four observables, walking the whole path from "a flow exists" to "an MCP
client can talk to the project that exposes it":

1. **The flow is created MCP-enabled.** `setupPlayground` posts
   `mcp_enabled: true` explicitly, because the SPA's `createNewFlow` hardcodes it
   while the column defaults to `false` — a flow created over the API without it is
   never exposed as a tool, and this spec is what catches that on a clean instance.
2. **The MCP Server tab lists THIS flow by name.** The assertion is built from the
   flow's own unique name, not from a `count > 0` on the tools list, which would
   pass for any unrelated pre-existing flow.
3. **The connection config advertises the project endpoint.** The JSON tab must
   render a URL matching `mcp/project/<project id>/streamable`.
4. **That endpoint actually answers the MCP handshake.** A JSON-RPC `initialize`
   against `POST /api/v1/mcp/project/{project_id}/streamable` returns `200`.

**The credential on step 4 is the assertion, not plumbing (#1522).** This POST used
to carry no credential at all and assert `200`, which `1.12.0.dev31` answered — that
build served the transport to anyone, so the assertion passed while exercising no
auth whatsoever. Since `1.12.0.dev33` a keyless caller is refused `403`. The test
therefore mints a real API key, sends it as `x-api-key` (the only credential the
transport accepts — a JWT is also refused), and deletes the key in `finally`.

---

## Tags *(required)*

`@stable` `@mcp` `@regression`

---

## Step by step *(required)*

1. Create a wired `ChatInput → ChatOutput` flow with `setupPlayground(page)`, which
   returns its id. **No `awaitBootstrapTest` here, deliberately** (#988): the helper
   creates the flow over the API and navigates straight to its canvas, whereas
   entering through the home page would have the "New Flow" entry point eagerly
   create a throwaway flow that nothing in this path disposes of. That decision is
   why this file is the only one of the four in #1788 that leaks **zero** flows.
2. Read the flow back (`GET /api/v1/flows/{id}`) and capture its server-assigned
   name — `E2E Playground <16 hex>`. Assert the name is non-empty: an empty name
   would turn every text assertion below into a match against anything.
3. Go to `/`, open the MCP Server tab (`mcp-btn`) and assert its title
   (`mcp-server-title`) is visible.
4. Assert the tools container (`div-mcp-server-tools`) is visible and contains the
   flow's slug — see *How the slug is derived* below.
5. Click the **JSON** tab and assert the rendered config contains a URL matching
   `/mcp\/project\/.+\/streamable/`.
6. Resolve the project id from `GET /api/v1/projects/`, normalising both response
   shapes (a bare array, or `{ folders: [...] }`), and assert at least one project
   exists.
7. Mint an API key (`createApiKey`, prefix `e2e-mcp-regression`), `POST` a JSON-RPC
   `initialize` (protocol `2024-11-05`) to the project's `streamable` route with
   `x-api-key`, and assert `200`.
8. **Cleanup:** the API key is deleted in `finally`; the flow is deleted id-scoped
   in `afterEach` through `deleteFlow`.

---

## Validation criterion *(required)*

The test fails if any of these does not hold: the created flow's name never appears
in the MCP Server tab's tools list; the JSON config carries no project `streamable`
URL; or the `initialize` handshake against that endpoint answers anything but
`200` while carrying a valid `x-api-key`.

---

## External dependencies *(required)*

- REST API: `POST`/`GET`/`DELETE /api/v1/flows/` (with `mcp_enabled`),
  `GET /api/v1/projects/`, `GET`/`PATCH /api/v1/mcp/project/{project_id}` (the tool
  metadata this spec reads through the UI), `POST /api/v1/mcp/project/{project_id}/streamable`
  (Streamable HTTP transport, `x-api-key` only), and the API-key endpoints behind
  `createApiKey` / `deleteApiKey`.
- UI testids: `mcp-btn`, `mcp-server-title`, `div-mcp-server-tools`, and the
  **JSON** tab addressed by role/name.
- `src/backend/base/langflow/api/v1/mcp_projects.py` — the project-scoped MCP
  server: the `/{project_id}/streamable` route this spec handshakes against, and
  the `GET`/`PATCH /{project_id}` tool metadata the tab renders.
- `src/lfx/src/lfx/base/mcp/util.py` — `sanitize_mcp_name`, which derives the tool
  name from the flow name (see *How the slug is derived* below).
- `src/backend/base/langflow/api/v1/api_key.py` — the API-key endpoints behind
  `createApiKey` / `deleteApiKey`; the transport accepts `x-api-key` and nothing
  else (#1522).
- `src/frontend/src/pages/MainPage/pages/homePage/components/McpServerTab.tsx` —
  the MCP Server tab: the tools list (`div-mcp-server-tools`), the title
  (`mcp-server-title`) and the JSON config panel.
- Helpers: `tests/helpers/flows/setup-playground.ts`,
  `tests/helpers/flows/delete-flow.ts`,
  `tests/helpers/auth/create-api-key.ts`,
  `tests/helpers/auth/get-auth-token.ts`.
- No LLM or provider API key required — the flow is never run, only exposed.

---

## How the slug is derived *(optional)*

`sanitize_mcp_name(name, max_length=46)` strips emoji and diacritics, replaces every
run of spaces **and hyphens** with a single `_`, collapses repeats, trims leading and
trailing `_`, **lowercases**, and truncates at 46 characters. Measured on
`1.13.0.dev8`: a flow named `E2E Slug Probe abcdef0123456789` is exposed with
`action_name: "e2e_slug_probe_abcdef0123456789"`.

The test builds its expectation as `flowName.toUpperCase().replace(/\s+/g, "_")` and
matches it with `getByText(slug, { exact: false })`, which is **case-insensitive**
and whitespace-normalising — that, not an uppercase rendering, is why an uppercase
expectation matches a lowercase tool name. The discriminating part of the slug is the
16 hex digits, which is what makes the assertion about this flow and no other.

Two constraints on the name follow from the same function and are already honoured by
`setupPlayground`: hyphens normalise exactly like spaces, so a raw UUID would make the
slug ambiguous (it strips them), and the 46-character truncation means the whole name
has to stay well under it.

---

## What this test does not cover *(optional)*

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
- At least one project must exist — the default `Starter Project` satisfies this, and
  step 6 asserts it rather than assuming it.
