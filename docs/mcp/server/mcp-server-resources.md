# MCP Server – List and Read Flow-File Resources

**Last validated:** Langflow 1.14.x (`1.14.0.dev25`, #2426)

---

## What this test validates *(required)*

Validates that a flow which holds an uploaded file and is **exposed to the
project's MCP server** surfaces that file as an **MCP resource** over the MCP
protocol, that a client can read the resource by its URI and receive the file's
content, and that a flow of the same project which is **not** exposed stays
invisible on both primitives. Exercises the two `resources/*` primitives of the
MCP protocol against Langflow's project-scoped server endpoint
(`/api/v1/mcp/project/{project_id}/streamable`):

1. **`resources/list`** — a file uploaded into an exposed project flow appears in
   the resource list with the expected `name` and a URI of the form
   `.../api/v1/files/download/{flow_id}/{filename}`; a file uploaded into an
   unexposed flow of the same project does not.
2. **`resources/read`** — reading the exposed file's URI returns its content,
   matching the per-run sentinel that was uploaded; reading the unexposed file's
   URI is refused.

If the positive half fails, external MCP clients (Claude Desktop, IDE agents, …)
cannot discover or consume files that a Langflow flow exposes — the **resource**
half of Langflow's MCP-server contract is broken. If the negative half fails, a
project MCP server hands its clients the attachments of flows the owner never
published to it — the exposure langflow-ai/langflow#16127 closed.

### Why this is the companion of `mcp-server-protocol.spec.ts`

`mcp-server-protocol.spec.ts` covers §14.1 **tools** (endpoint + `tools/call`)
and notes that `resources/list` returns `[]` — true for a flow with **no
files**: Langflow exposes each flow as a *tool*, not as a resource. A live scout
of nightly `1.11.0` refined that: **flow files are exposed as resources**. When a
project flow has an uploaded file, it appears in `resources/list` and is readable
via `resources/read`. This spec covers exactly that dimension.

### Resource visibility follows tool visibility (langflow-ai/langflow#16127)

Until upstream #16127 the project server listed and served the files of **every**
flow in the project, whether or not the flow was `mcp_enabled` — resources were
file-scoped, tools were flow-scoped. #16127 (*"honor MCP flow visibility for
project resources"*, merged 2026-11-04) added `Flow.mcp_enabled == True` to the
project-scoped query of both `handle_list_resources` and `handle_read_resource`
(`# Legacy NULL flags stay excluded, matching project tool visibility.`). The
global, non-project server is unchanged and still lists every owner-scoped flow.

A flow created through `POST /api/v1/flows/` is `mcp_enabled: false`, so since
#16127 its files are invisible to the project server until it is exposed with
`PATCH /api/v1/mcp/project/{project_id}` — the same call that publishes it as a
tool. That is what turned Test 1 red (#2426): it uploaded into a flow it never
exposed. Measured on `1.14.0.dev25`: `resources/list` answered `[]`; after the
PATCH the same file was listed under the unchanged URI shape and
`resources/read` returned its content, while the file of a sibling flow PATCHed
to `mcp_enabled: false` stayed unlisted and its read answered
`{"code":0,"message":"Resource not found or access denied"}`.

Which builds carry it is decided from the **version the instance declares**,
never from the response (the reasoning in `tests/helpers/other/served-version.ts`):

| Line | First build with #16127 | Evidence |
|---|---|---|
| 1.14 | `1.14.0.dev23` | reached `release-1.14.0` in the merge of 2026-11-10 20:23Z; tag `v1.14.0.dev22` does not contain the commit, `v1.14.0.dev23` does — and the daily went red on exactly `dev23` |
| 1.13 | `1.13.2rc0` | committed on `release-1.13.2` 2026-11-04, after the bump to 1.13.2 (2026-11-03); `1.13.2rc0` (published 2026-11-08) is the first 1.13.2 build on PyPI, and `v1.13.2` contains it |

Exposing the flow is correct on every build, so the positive assertions run
everywhere. The negative assertions run only on a build that carries #16127: on
an older one the unexposed file is listed by design, and asserting its absence
there would redden a lane for a contract that build never had.

### Scope note — re-scoped from §13.1 (client) to §14.1 (server)

Issue #828 was filed under §13.1 (MCP **Client**). A live scout proved the client
does not expose resources: the MCPTools component and the v2 client API surface
only ever deal with **tools** (no resource UI, endpoint, or schema field). The
`list_resources`/`read_resource` capability exists **only on the server side**
(`@server.list_resources()` / `@server.read_resource()` in `api/v1/mcp_projects.py`),
so this spec validates the surface that actually implements the behavior. The
§13.1 client-resource bullet stays open/not-implementable.

---

## Tags *(required)*

Both tests: `@api` `@mcp` `@regression` — pure MCP-protocol (JSON-RPC over HTTP);
no UI page, no LLM/agent. Mirrors the tag set of the direct sibling
`mcp-server-protocol.spec.ts`.

- **T1 `resources/list`** — `@stable` (promoted under #948 on `1.12.0.dev4`;
  quarantined for #2426 on 2026-11-12 and restored by the fix of #2426 after
  repeated clean `--workers=1 --retries=0` runs and force-failure checks).
- **T2 `resources/read`** — **not `@stable`.** It was kept out of the daily
  because `resources/read` raised `AttributeError: 'str' object has no attribute
  'hex'` on 1.12.x (upstream **LE-2012**,
  `docs/upstream-bugs/UPSTREAM-BUG-mcp-resources-read-uuid-hex.log`). The read
  passes on `1.14.0.dev25` (measured for #2426), but promoting it is outside
  #2426's scope, which only lifts its quarantine; T2 stays a non-stable
  regression guard until a promotion issue takes it.

---

## Step by step *(required)*

Setup (`beforeAll`): resolve the auth header via `getAuthToken`; mint an API key
for the MCP transport; create a **dedicated project** via `createProjectViaApi`
(so no other spec's PATCH on a shared project can change which of this spec's
flows are exposed); create two flows in it via `createFlow(..., folder_id)` —
`exposed` and `hidden`; upload a small text file carrying a per-flow, per-run
sentinel into each via `POST /api/v1/files/upload/{flowId}` (multipart), and
capture each server-assigned (timestamp-prefixed) filename from the response
`file_path`; `PATCH /api/v1/mcp/project/{projectId}` with `mcp_enabled: true` for
`exposed` and `mcp_enabled: false` for `hidden` (stated explicitly, so the
control does not rest on the API's creation default). Teardown (`afterAll`):
delete both flows (removes their files), the project, and the API key.

**Test 1 — `resources/list` surfaces the exposed flow's file, not the hidden one's**

1. Complete the MCP handshake (`initialize` + `notifications/initialized`) via
   `mcpHandshake` against the dedicated project's streamable endpoint.
2. Call `resources/list`; **poll** it until a resource whose URI path is
   `/api/v1/files/download/{exposedFlowId}/{exposedName}` appears (the list can
   lag a moment behind the upload) — up to a bounded timeout.
3. Assert that resource's `name` equals the exposed file's stored name.
4. On a build carrying #16127: assert that **the same response** has no resource
   whose URI path is under `/api/v1/files/download/{hiddenFlowId}/`. Both files
   were uploaded before the first poll, so the response that proves the exposed
   file is listed is also past any listing lag for the hidden one.

**Test 2 — `resources/read` returns the exposed file and refuses the hidden one**

1. Complete the handshake.
2. Call `resources/read` with `params.uri` set to the exposed resource URI
   (`.../files/download/{exposedFlowId}/{exposedName}`).
3. Assert `result.contents[0].uri` matches the requested path and that its
   content (decoding `blob`/`text`; see Notes on encoding) contains the exposed
   flow's sentinel — proving the byte content is served, not merely listed.
4. On a build carrying #16127: call `resources/read` for the hidden file's URI
   and assert a JSON-RPC `error` whose message is `Resource not found or access
   denied`, with no `result`.

---

## Validation criterion *(required)*

- **Test 1:** the `resources/list` result contains an entry whose `uri` path is
  `/api/v1/files/download/{exposedFlowId}/{exposedName}` and whose `name` equals
  the exposed file's stored name — asserted against the specific created flow,
  not a generic "≥1 resource". On a build carrying #16127 (`≥ 1.14.0.dev23` on
  1.14, `≥ 1.13.2rc0` on 1.13), the same result contains no entry under
  `/api/v1/files/download/{hiddenFlowId}/`.
- **Test 2:** the `resources/read` result's `contents[0]` carries the matching
  URI and its decoded content contains the exposed flow's per-run sentinel. On a
  build carrying #16127, reading the hidden file's URI answers the JSON-RPC error
  `Resource not found or access denied`.

---

## External dependencies *(required)*

- `src/backend/base/langflow/api/v1/mcp_projects.py` — project-scoped MCP server:
  the `/{project_id}/streamable` route,
  `StreamableHTTPSessionManager(..., stateless=True)`, the
  `@server.list_resources()` / `@server.read_resource()` handlers, and
  `PATCH /api/v1/mcp/project/{project_id}` (per-flow `mcp_enabled`, merged).
- `src/backend/base/langflow/api/v1/mcp_utils.py` — `handle_list_resources`
  (builds `Resource(uri=.../files/download/{flow_id}/{file}, name, mimeType)`;
  project-scoped since #16127 to `Flow.mcp_enabled == True`) and
  `handle_read_resource` (parses the URI's last two path segments, authorizes —
  same `mcp_enabled` filter when project-scoped — and returns file content).
- `src/backend/base/langflow/api/v1/files.py` — `POST /api/v1/files/upload/{flow_id}`
  (server prepends a `YYYY-MM-DD_HH-MM-SS_` prefix to the stored filename).
- Helpers: `tests/helpers/auth/get-auth-token.ts`,
  `tests/helpers/auth/create-api-key.ts`,
  `tests/helpers/mcp/mcp-streamable-client.ts` (`mcpCall`, `mcpHandshake`),
  `tests/helpers/flows/create-project-via-api.ts`,
  `tests/helpers/flows/create-flow.ts`, `tests/helpers/flows/delete-flow.ts`,
  `tests/helpers/other/served-version.ts`,
  `tests/helpers/mcp/mcp-resource-visibility.ts` (which builds carry #16127).

---

## What this test does not cover *(optional)*

- **Client-side resource consumption (§13.1)** — not implemented in the product
  (see Scope note); no MCPTools resource UI or client API exists to test.
- **MCP Server *tools*** (`tools/list`, `tools/call`) and the generated-endpoint
  advertisement — covered by `mcp-server-protocol.spec.ts`.
- **MCP Server UI** (exposing a flow via the MCP Server tab) — covered by
  `mcp-server-regression.spec.ts` and `mcp-server.spec.ts`.
- MCP prompts (`prompts/list`, `prompts/get`) — separate primitive, out of scope.
- User-level files (uploaded via `/api/v2/files`) and the **global**
  (non-project) server, which #16127 left listing every owner-scoped flow — this
  spec scopes to project resources = flow files.
- A flow whose `mcp_enabled` is `NULL` (legacy rows) — not reachable through the
  API this spec uses; upstream's unit tests cover it.

---

## Preconditions *(optional)*

- Langflow running at `PLAYWRIGHT_BASE_URL`, `auto_login` mode (the fixture's
  `request` context is authenticated via `getAuthToken`).
- **An API key is the transport credential.** The specs mint one with
  `createApiKey` (`tests/helpers/auth/create-api-key.ts`) and send it as
  `x-api-key`; the `auto_login` session JWT is refused with `403` by
  `/api/v1/mcp/project/{id}/streamable` (measured on 1.12.0.dev33 — the table in
  `tests/tests-automations/regression/mcp/CLAUDE.md` → *Authenticating against the
  MCP transport*). The key is deleted in teardown. No lane sets
  `LANGFLOW_SKIP_AUTH_AUTO_LOGIN`, on purpose.
- No LLM or API key required.

---

## Notes *(optional)*

- The streamable transport is **stateless** (`stateless=True`): each JSON-RPC
  POST is independent, no `Mcp-Session-Id` is carried between calls. Confirmed
  live — `initialize`, `resources/list`, `resources/read` each return `200` as
  standalone POSTs. `mcpHandshake` still fires `notifications/initialized` to
  mirror a real client.
- **Content encoding:** for a `text/plain` upload the stored file's mimeType is
  reported as `application/octet-stream`, so `resources/read` returns the content
  in `contents[0].blob` (not `text`). The observed `blob` is **double-base64**
  (the read handler base64-encodes the file bytes, then the MCP framework
  base64-encodes the `blob` field) — seen on 1.11.0, 1.13.1rc2 and
  `1.14.0.dev25`. The assertion decodes defensively — it looks for the sentinel
  at decode depth 0/1/2 — so it survives a future switch to single-encoding or a
  plain `text` field without silently passing on garbage.
- **Timing:** `resources/list` can momentarily lag behind the upload; Test 1
  polls the list until the file appears rather than asserting on a single shot.
- **Filename:** the upload API prepends a timestamp
  (`2026-07-21_14-31-34_note.txt`); the resource `name`/`uri` use that stored
  name, so read must target the server-assigned name (captured from the upload
  response), not the original one.
- **Storage namespace vs. URI:** since LE-3242 (1.13.1 / `1.14.0.dev16`) the
  upload's `file_path` is `flow-{flowId}/{file}`, but the resource URI still
  carries the bare flow id (`/files/download/{flowId}/{file}`). The spec builds
  the expected URI from the flow id and takes only the file name from
  `file_path`, so it does not depend on the storage layout.
- **URI matching:** assert on the URI *path* (`/files/download/{flowId}/{file}`),
  not the absolute host — the server builds the URI from its own host setting
  (`0.0.0.0` on the nightly image), which differs from the test's
  `PLAYWRIGHT_BASE_URL` host; `handle_read_resource` only consumes the last two
  path segments.
- **Isolation:** the dedicated project is what makes the negative control
  trustworthy. In the shared default project another spec exposing flows through
  `PATCH /api/v1/mcp/project/{id}` could flip `hidden` on, and the absence
  assertion would then fail for a reason that is not a product change.
- Cleanup: both flows, the project and the API key are deleted in `afterAll`
  (id-scoped); the orphan count is checked via `GET /api/v1/flows/` before
  reporting. The uploaded files are removed with their flows.
