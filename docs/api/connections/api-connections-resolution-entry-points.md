# Connections — which entry points may resolve a connection

**File:** `tests/tests-automations/regression/api/connections/api-connections-resolution-entry-points.spec.ts`

**Last validated:** Langflow 1.13.x (`1.13.0.dev47`)

Owning issue: #2296 (Dedicated Integrations, batch 2). The non-interactive callers (webhook, HITL
resume, KB ingest, Slack app tokens) are #2306's, and trigger dispatch is #2309's — both reuse the probe
this file introduces (`tests/helpers/integrations/connection-probe.ts`).

---

## What this test validates *(required)*

A flow never carries a credential. It names a connection by its handle (`<provider>/<name>`), and the
server decides, **per run**, whether the caller behind that run may use it. Upstream names this the
feature's highest risk (#8 in its risk register): a run that resolves a connection it should not acts
as someone else, silently. Upstream proves the rule in-process
(`scripts/ci/execution_principal_matrix.json` plus unit tests). Until this file, nothing in the suite
had ever **run** a flow that resolves a connection.

The rule (`api/utils/execution_principal.py` + `lfx/services/connection/base.py`): every entry point
stamps an execution family on its run. Then:

- an **anonymous** principal resolves **nothing**;
- a **user-owned** connection resolves only for its owner, and for a non-interactive principal only
  with the owner's opt-in (#2306);
- an **instance** connection resolves for any non-anonymous principal.

This file owns the interactive and the anonymous families. Measured on `1.13.0.dev47`, all eleven
rows hold:

| # | Entry point | Family | User connection (owner) | Instance connection | What the verdict is read from |
|---|---|---|---|---|---|
| 1 | Playground build `POST /api/v1/build/{flow_id}/flow` | `interactive_chat` | PERMIT | PERMIT | the build's event stream (`event_delivery=direct`) |
| 2 | `POST /api/v1/run/{flow_id}` | `v1_run` | PERMIT | PERMIT | the response body |
| 3 | `POST /api/v1/responses` | `openai_responses` | PERMIT | PERMIT | the response body |
| 4 | `POST /api/v2/workflows` | `workflow_v2` | PERMIT | PERMIT | the response body |
| 5 | MCP project behind an API key, `tools/call` | `mcp_projects` | PERMIT | PERMIT | the tool result |
| 6 | The legacy global MCP server `/api/v1/mcp/streamable`, `tools/call` | `legacy_mcp` | PERMIT | PERMIT | the tool result |
| 7 | Shareable playground `POST /api/v1/build_public_tmp/{flow_id}/flow` | `legacy_public_chat` | **DENY** | **DENY** | the build's event stream: `code` + hint |
| 8 | `POST /api/v2/workflows/public` | `workflow_public_v2` | **DENY** | **DENY** | the stream: `code` + hint |
| 9 | MCP project with auth `none`, `tools/call` | `mcp_projects` (public call) | **DENY** | **DENY** | the tool result: the exception message only |
| 10 | A2A JSON-RPC, public agent | `a2a` | **DENY** | **DENY** | the owner's `GET /api/v1/monitor/messages`: the message only |
| 11 | A2A JSON-RPC, agent behind an API key | `a2a` | **DENY** | **DENY** | the probe: the typed reason `anonymous-principal` |

Each PERMIT asserts **which** connection resolved (its id and `owner_kind`), because a resolver that
picked the wrong row would also "resolve". Each DENY asserts it was the **principal** that was refused —
never the provider, and never past it to the scope check — because a run failing for an unrelated cause
would otherwise read as a correct denial.

### The oracle — two of them, because public paths do not run custom code

A planted connection carries a **fake** token, so "the provider accepted it" can never prove PERMIT —
and calling a real provider would make the file depend on egress and on provider error text.

- **Authenticated paths: a probe component** (`connection-probe.ts`). A `CustomComponent` declares one
  `ConnectionRefInput` per handle and calls `self.resolve_connection(<field>).get_credential()`. That
  runs the host's real resolver (identity floor, policy, scopes) and stops before any provider adapter
  exists. It outputs `PROBE <field> resolved owner_kind=<kind> connection_id=<id>` or
  `PROBE <field> denied code=<code> reason=<reason>`, and **never** the token. It declares no required
  scopes, so a resolution can only fail on identity or policy.
- **Anonymous paths: a real, read-only connector.** Public execution applies the public code policy:
  a `CustomComponent`'s code is swapped for the server's stock copy (#2196), and a public MCP project
  refuses a flow with custom code outright. The oracle there is Google *Drive: List Files*
  (`ext:google:GoogleDriveListComponent@official`). Only `connection` is required, and the action only
  **reads**, so even a wrongly permitted resolution could not write anything with a fake token.
- **The contrast that gives the anonymous DENY its meaning** (asserted in row 7). The same Drive flow,
  run **authenticated** over `/api/v1/run`, gets past identity and stops at `scope-missing`: the planted
  connection holds no `drive.file`, and upstream checks scopes **after** the principal. So a refusal
  that names the principal is the principal check, not a flow that was broken anyway.

### What each anonymous path lets a reader see

The refusal is the same everywhere (`ConnectionNotAuthorizedError`). What differs is how much of it
reaches the reader, so the assertion is as strong as each path allows:

- **Rows 7 and 8** send the client error shape: `code: "connection-not-authorized"` plus
  `solution: "Use an authenticated run route; public and A2A executions cannot resolve connections."`.
  That hint is the one-to-one stand-in for the typed reason `anonymous-principal`
  (`lfx/integrations/errors.py`), which the client is not sent.
- **Row 9** returns only `str(exception)` in the tool result:
  *"This execution principal is not authorized to use the requested connection."*. That message is
  shared by **every** non-`provider` reason, so the row proves the principal was refused, not which
  reason applied.
- **Row 10** answers the caller only *"Flow execution failed"* (task `state: "failed"`). That cannot
  tell a principal refusal from a scope refusal. The reason is read where the run recorded it — the
  flow owner's `GET /api/v1/monitor/messages?flow_id=…`, whose Drive error message is the same
  not-authorized text.
- **Row 11** runs the flow's own code (an agent behind a key, #2196), so the probe reports the typed
  reason directly: `anonymous-principal`.

### Where the measurement disagrees with the issue

- **A2A: design and code disagree on row 11.** `connection-contract.md` says the authenticated A2A
  sub-path resolves a connection for its owner. `api/v1/a2a.py` stamps **both** sub-paths with the
  anonymous family, and row 11 measures that: `denied … reason=anonymous-principal`. This file asserts
  what the code does and records the disagreement here. It is not a `test.fail()`: nothing says the
  code is the side that is wrong.
- **`POST /api/v2/workflows/public` is mounted but hidden from the OpenAPI schema**
  (`include_in_schema=False`). The committed API-surface baseline lists it anyway (`inSchema: false`),
  so row 8 declares it like any other. It has its own anonymous rate limit
  (`_enforce_public_rate_limit`), so row 8 sends one request per connection per run.
- **`/api/v1/run`, `/responses`, `/api/v2/workflows`, both MCP servers and the A2A key path need an API
  key under `auto_login`** (`403 "Since v1.5, LANGFLOW_AUTO_LOGIN requires a valid API key…"`). The
  file creates one for the superuser and deletes it in `afterAll`.
- **The legacy global MCP server looks a `tools/call` up by the flow's NAME, not its `action_name`.**
  Called by `action_name`, it answers *"Flow with name '<x>' not found"*. Row 6 names its flow after the
  tool.
- **The legacy SSE transport** (`GET /api/v1/mcp/sse`) is not driven: the same server is reachable
  over the streamable transport, and row 6 exercises that family through it.

### Recorded, not asserted

- **Voice** (`/api/v1/voice/ws/…`) needs a voice provider key.
- **The deployments family** is stamped by no OSS route ("an unstamped serving-plane build fails
  closed").
- **Headless `lfx run`** is not the server under test.
- **Explicit shares** need Enterprise RBAC.
- **Cross-user refusals** (a flow of user B naming user A's connection) are #2300's.

### Budget and parallel safety

- **Connection writes:** two planted connections plus their deletes = **4 superuser writes per worker
  per run**, well inside the 30/minute bucket (#2295). Nothing here PATCHes a connection.
- **Projects:** rows 5, 9, 10 and 11 each create a project of their own and delete it, flow first, in
  `finally`. A project registers an `lf-<name>` MCP server entry, so leaking one is visible to
  `mcp-server-starter-projects.spec.ts`.
- **Every name is unique per run**, and every assertion keys on the probe's own handles and the planted
  ids. No list length is read. Row 6 adds one MCP-enabled flow to the user's global server for the
  duration of the test; no spec reads that server's tool count.

---

## Tags *(required)*

`@api` `@integrations` `@stable`, plus `@mcp` on rows 5, 6 and 9 and `@a2a` on rows 10 and 11.

`@stable`: no provider key, no model, no network egress. The probe stops before any adapter, and the
Drive oracle is refused before one, or stops at its missing scope.

---

## Step by step *(required)*

`beforeAll`, per worker:

1. Plant one **user** and one **instance** `google` connection, no scopes, each carrying a sentinel
   token unique to the run.
2. Create an API key.
3. Build the **probe flow** (Chat Input → *Probe*, with one input per handle → Chat Output).
4. Build two **Drive flows**, one bound to each handle, and mark them `access_type: PUBLIC`.

**Tests 1–4 (PERMIT over HTTP).** Each runs the probe flow through its entry point. Both lines must
read `resolved`, with the planted id and its owner kind.

**Test 5 (PERMIT, MCP project).**
1. The test moves a fresh probe flow into an `apikey` project.
2. It exposes the flow with `PATCH /api/v1/mcp/project/{id}`.
3. It completes the handshake and calls the tool.
4. Both lines must read `resolved`.

**Test 6 (PERMIT, legacy MCP).**
1. A fresh probe flow, named after its tool, is MCP-enabled.
2. The handshake must identify `langflow-mcp-server`.
3. `tools/call` must return both lines as `resolved`.

**Test 7 (DENY, shareable playground).**
1. The contrast: the user Drive flow over `/api/v1/run` must reach `scope-missing` and not
   `connection-not-authorized`.
2. Each Drive flow is then built over `build_public_tmp` with only a `client_id` cookie. The events must
   carry `connection-not-authorized` and the anonymous hint, and never `scope-missing`.

**Test 8 (DENY, public v2).** Each Drive flow is run over `POST /api/v2/workflows/public` with only a
`client_id` cookie. The stream is asserted the same way as test 7.

**Test 9 (DENY, public MCP).**
1. A Drive flow is moved into an `auth: none` project and exposed.
2. The `initialize` call, sent with **no** credential, must answer `200`.
3. `tools/call` must report `isError: true` with the not-authorized message, never `scope-missing`,
   never the provider's denial.

**Test 10 (DENY, public A2A).**
1. A Drive flow is moved into an `auth: none` project as an A2A agent.
2. `message/send` must end the task `failed`.
3. The owner's `GET /api/v1/monitor/messages?flow_id=…` must carry the not-authorized message, never
   `scope-missing`.

**Test 11 (DENY, A2A behind an API key).** A probe flow is moved into an `apikey` project as an agent.
`message/send` with `x-api-key` must return both lines as
`denied code=connection-not-authorized reason=anonymous-principal`.

Every response, event stream and recorded message is swept as **text** for both sentinel tokens (#1967).

---

## Validation criterion *(required)*

All eleven tests pass three consecutive times at `--retries=0 --workers=1` against `1.13.0.dev47`, and
once at `--workers=2`. The following hold on every run:

- every PERMIT names the exact planted id and `owner_kind` of **both** connections;
- every DENY names the principal refusal at the strength its path allows (code + hint, the message, or
  the typed reason), and never `scope-missing`;
- the authenticated Drive contrast reaches `scope-missing`;
- no response, stream or recorded message carries either sentinel token.

Every test also has a force-fail mutation executed against it: expecting the other owner kind on a
PERMIT, and expecting `scope-missing` or the other reason on a DENY.

---

## External dependencies *(required)*

- A running Langflow **1.13** instance at `PLAYWRIGHT_BASE_URL`, auto-login, with
  `LANGFLOW_ALLOW_CUSTOM_COMPONENTS=true` (the probe) and `LANGFLOW_A2A_ENABLED=true` (rows 10–11). Every
  lane sets both.
- `src/backend/base/langflow/api/utils/execution_principal.py` — the family each entry point stamps.
- Upstream's own statement of the matrix above is its CI matrix file (execution_principal_matrix.json
  under the upstream repository's scripts/ci directory), cited here as context, not as code the spec
  exercises.
- `src/lfx/src/lfx/services/connection/base.py` — the portable floor that refuses an anonymous
  principal.
- `src/backend/base/langflow/services/connection/service.py` — the database resolver.
- `src/lfx/src/lfx/custom/custom_component/component.py` — `resolve_connection`, which the probe
  calls.
- `src/lfx/src/lfx/integrations/errors.py` — `ConnectionNotAuthorizedError`: its message, its reasons
  and their hints.
- `src/backend/base/langflow/api/v1/chat.py` — `build_flow` and `build_public_tmp`.
- `src/backend/base/langflow/api/v2/workflow_public.py` — the public v2 route, hidden from the schema.
- `src/backend/base/langflow/api/v1/mcp_utils.py` — the public project call: stock code, public user.
- `src/backend/base/langflow/api/v1/mcp.py` — the legacy global MCP server.
- `src/backend/base/langflow/api/v1/a2a.py` — both A2A sub-paths stamped anonymous.
- `tests/helpers/integrations/connection-probe.ts`, `tests/helpers/flows/build-catalog-flow.ts`,
  `tests/helpers/flows/create-project-via-api.ts`, `tests/helpers/integrations/create-connection.ts`,
  `tests/helpers/auth/create-api-key.ts`, `tests/helpers/mcp/mcp-streamable-client.ts` and
  `tests/helpers/a2a/post-a2a-jsonrpc.ts` — the probe, the flows, the projects, the planted
  connections, the API key and the two protocol clients.
