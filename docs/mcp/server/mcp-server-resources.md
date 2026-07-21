# MCP Server – List and Read Flow-File Resources

**Last validated:** Langflow 1.11.0

---

## What this test validates *(required)*

Validates that a flow which holds an uploaded file surfaces that file as an
**MCP resource** over the MCP protocol, and that a client can read the resource
by its URI and receive the file's content. Exercises the two `resources/*`
primitives of the MCP protocol against Langflow's project-scoped server
endpoint (`/api/v1/mcp/project/{project_id}/streamable`):

1. **`resources/list`** — a file uploaded into a project flow appears in the
   resource list with the expected `name` and a URI of the form
   `.../api/v1/files/download/{flow_id}/{filename}`.
2. **`resources/read`** — reading that exact URI returns the file's content,
   matching the per-run sentinel that was uploaded.

If these fail, external MCP clients (Claude Desktop, IDE agents, …) cannot
discover or consume files that a Langflow flow exposes — the **resource** half
of Langflow's MCP-server contract is broken.

### Why this is the companion of `mcp-server-protocol.spec.ts`

`mcp-server-protocol.spec.ts` covers §14.1 **tools** (endpoint + `tools/call`)
and notes that `resources/list` returns `[]` — true for a flow with **no
files**: Langflow exposes each flow as a *tool*, not as a resource. A live scout
of nightly `1.11.0` refined that: **flow files are exposed as resources**. When a
project flow has an uploaded file, it appears in `resources/list` and is readable
via `resources/read` (regardless of whether the flow is `mcp_enabled` — resources
are file-scoped, not tool-scoped). This spec covers exactly that dimension.

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

All tests: `@api` `@mcp` `@regression` — pure MCP-protocol (JSON-RPC over HTTP);
no UI page, no LLM/agent. Mirrors the tag set of the direct sibling
`mcp-server-protocol.spec.ts`.

**`@stable` is intentionally withheld.** Per issue #828 the promotion is gated:
this MCP area is in the current flaky cluster (#773) and the clean non-guarded
daily baseline (#818) has not yet been achieved. Add `@stable` only after that
gate is met and the spec has demonstrated repeated clean `--retries=0` runs.

---

## Step by step *(required)*

Setup (`beforeAll`): resolve the auth header via `getAuthToken`; take the default
project id from `GET /api/v1/projects/`; create a flow via
`createRunnableChatFlowViaApi`; upload a small text file carrying a per-run
sentinel into that flow via `POST /api/v1/files/upload/{flowId}` (multipart), and
capture the server-assigned (timestamp-prefixed) filename from the response
`file_path`. Teardown (`afterAll`): delete the flow (removes its file too).

**Test 1 — `resources/list` surfaces the uploaded flow file**

1. Complete the MCP handshake (`initialize` + `notifications/initialized`) via
   `mcpHandshake` against the project streamable endpoint.
2. Call `resources/list`; **poll** it until a resource whose URI path ends with
   `/api/v1/files/download/{flowId}/{uploadedName}` appears (the list can lag a
   moment behind the upload) — up to a bounded timeout.
3. Assert that resource's `name` equals the uploaded filename.

**Test 2 — `resources/read` returns the file content by URI**

1. Complete the handshake.
2. Call `resources/read` with `params.uri` set to the resource URI
   (`.../files/download/{flowId}/{uploadedName}`).
3. Assert `result.contents[0].uri` matches the requested path and that its
   content (decoding `blob`/`text`; see Notes on encoding) contains the exact
   per-run sentinel — proving the byte content is served, not merely listed.

---

## Validation criterion *(required)*

- **Test 1:** the `resources/list` result contains an entry whose `uri` path is
  `/api/v1/files/download/{flowId}/{uploadedName}` and whose `name` equals the
  uploaded filename — asserted against the specific created flow, not a generic
  "≥1 resource" (the project list also contains other flows' files).
- **Test 2:** the `resources/read` result's `contents[0]` carries the matching
  URI and its decoded content contains the per-run sentinel string uploaded in
  setup.

---

## External dependencies *(required)*

- `src/backend/base/langflow/api/v1/mcp_projects.py` — project-scoped MCP server:
  the `/{project_id}/streamable` route,
  `StreamableHTTPSessionManager(..., stateless=True)`, and the
  `@server.list_resources()` / `@server.read_resource()` handlers.
- `src/backend/base/langflow/api/v1/mcp_utils.py` — `handle_list_resources`
  (builds `Resource(uri=.../files/download/{flow_id}/{file}, name, mimeType)`
  from `storage_service.list_files(flow_id)`) and `handle_read_resource`
  (parses the URI's last two path segments, authorizes, returns file content).
- `src/backend/base/langflow/api/v1/files.py` — `POST /api/v1/files/upload/{flow_id}`
  (server prepends a `YYYY-MM-DD_HH-MM-SS_` prefix to the stored filename).
- Helpers: `tests/helpers/auth/get-auth-token.ts`,
  `tests/helpers/mcp/mcp-streamable-client.ts` (`mcpCall`, `mcpHandshake`),
  `tests/helpers/flows/create-runnable-chat-flow-via-api.ts`,
  `tests/helpers/flows/delete-flow.ts`.

---

## What this test does not cover *(optional)*

- **Client-side resource consumption (§13.1)** — not implemented in the product
  (see Scope note); no MCPTools resource UI or client API exists to test.
- **MCP Server *tools*** (`tools/list`, `tools/call`) and the generated-endpoint
  advertisement — covered by `mcp-server-protocol.spec.ts`.
- **MCP Server UI** (exposing a flow via the MCP Server tab) — covered by
  `mcp-server-regression.spec.ts` and `mcp-server.spec.ts`.
- MCP prompts (`prompts/list`, `prompts/get`) — separate primitive, out of scope.
- User-level files (uploaded via `/api/v2/files`) — only exposed on the global
  (non-project) server; this spec scopes to project resources = flow files.

---

## Preconditions *(optional)*

- Langflow running at `PLAYWRIGHT_BASE_URL`, `auto_login` mode (the fixture's
  `request` context is authenticated via `getAuthToken`).
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
  in `contents[0].blob` (not `text`). On 1.11.0 the observed `blob` is
  **double-base64** (the read handler base64-encodes the file bytes, then the MCP
  framework base64-encodes the `blob` field). The assertion decodes defensively —
  it looks for the sentinel at decode depth 0/1/2 — so it survives a future switch
  to single-encoding or a plain `text` field without silently passing on garbage.
- **Timing:** `resources/list` can momentarily lag behind the upload; Test 1
  polls the list until the file appears rather than asserting on a single shot.
- **Filename:** the upload API prepends a timestamp
  (`2026-07-21_14-31-34_note.txt`); the resource `name`/`uri` use that stored
  name, so read must target the server-assigned name (captured from the upload
  response), not the original one.
- **URI matching:** assert on the URI *path suffix*
  (`/files/download/{flowId}/{file}`), not the absolute host — the server builds
  the URI from its own host setting (`localhost`), which may differ from the
  test's `PLAYWRIGHT_BASE_URL` host; `handle_read_resource` only consumes the last
  two path segments.
- Flow cleanup: the created flow is deleted in `afterAll` (id-scoped); the orphan
  count is checked via `GET /api/v1/flows/` before reporting. The uploaded file is
  removed with the flow.
