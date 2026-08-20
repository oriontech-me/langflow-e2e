# MCP Server — add-server modal: stdio / HTTP registration, field persistence & tool refresh

**Last validated:** Langflow 1.12.x (tests 1–7 on nightly `1.12.0.dev9`; tests 8–9 on `1.12.0.dev20`)

---

## What this test validates *(required)*

Covers the **Add MCP Server modal** as the registration surface for external MCP
servers, across both transports, plus the security contract the stdio form now
enforces (QA-CHECKLIST §14.1):

1. **stdio registration round-trip** — a server registered with
   `command` + `args` resolves its tools into the MCPTools node's
   `dropdown_str_tool`, renders the selected tool's inputs on the node, appears
   in Settings → MCP Servers, and can be edited and deleted from there.
2. **Field persistence** — every stdio field (name, command, N args, N env
   pairs) and every HTTP/SSE field (name, URL, N headers, N env pairs) survives
   save → reopen-for-edit.
3. **Tool-list refresh on edit** — changing which package a registered server
   runs makes the node's tool list reflect the *new* server, not the cached one.
4. **The stdio command/args contract** — `command` must be a single executable;
   an option or package glued onto it is refused, and the same registration
   split into `command` + `args` is accepted.
5. **Streamable HTTP against Langflow itself** — a project's own
   `/api/v1/mcp/project/{id}/streamable` endpoint registers as an MCP server and
   exposes the project's flows as tools.
6. **The single-server read-back and update API** (#1397) — a registered server
   is readable on its own at `GET /api/v2/mcp/servers/{name}` with exactly the
   fields it was created with, and `PATCH /api/v2/mcp/servers/{name}` updates
   them, merging at the top level and refusing to rename.

If this fails, external MCP servers can no longer be registered from the UI, the
modal loses field state, the tool list serves stale data after an edit, the
stdio input-shape validation that keeps every policy layer seeing the same argv
has been dropped, or the API the modal's edit path is built on stops returning
what it stored.

---

## Tags *(required)*

`@release` `@workspace` `@components` `@mcp` `@stable`
(plus `@regression` on the command/args contract test, and `@api` on the
read-back/update tests)

- `@stable` — promoted under #1091 after the file was brought back to green on
  nightly `1.12.0.dev9` with repeated `--workers=1 --retries=0` runs and a
  per-test force-failure check. Before #1091 the file carried no `@stable` and
  therefore ran in **no automated lane**, which is why every stdio registration
  in it had been broken since 2026-07-15 without a single red run. Tests 8 and 9
  ship `@stable` from the start (#1397): they are pure API, need no subprocess,
  no npm registry and no LLM, and were validated per CONTRIBUTING before the PR.
- `@api` — on tests 8 and 9 only; they exercise
  `GET`/`PATCH /api/v2/mcp/servers/{name}` directly and never drive the modal.
  They carry **no** `@regression`: that tag means "test for a previously fixed
  bug" (`CLAUDE.md`), which is earned by the contract test below and by the
  409/404 sibling spec, but these two are new coverage of a path with no bug
  history. `@api` + `@stable` (cross-cutting) and `@mcp` (functional) satisfy the
  tagging rule on their own.
- `@regression` — on the contract test only: it guards an intentional upstream
  security change (see *External dependencies*), so a silent removal of that
  validation must fail the suite.
- `@workspace`/`@components` — drives the flow canvas, sidebar and MCPTools
  node; `@mcp` — MCP server area; `@release` — happy-path MCP registration.

---

## Preconditions *(optional)*

- Langflow running at `PLAYWRIGHT_BASE_URL`; auto-login superuser.
- The default MCP starter project exists (`lf-starter_project`).
- **An API key is the transport credential.** The specs mint one with
  `createApiKey` (`tests/helpers/auth/create-api-key.ts`) and send it as
  `x-api-key`; the `auto_login` session JWT is refused with `403` by
  `/api/v1/mcp/project/{id}/streamable` (measured on 1.12.0.dev33 — the table in
  `tests/tests-automations/regression/mcp/CLAUDE.md` → *Authenticating against the
  MCP transport*). The key is deleted in teardown. No lane sets
  `LANGFLOW_SKIP_AUTH_AUTO_LOGIN`, on purpose. Test 6 is the one that needs it: it registers Langflow's **own**
  transport endpoint, so the stored server config must carry the header for
  Langflow to connect to itself.
- **Network egress to the npm registry** — the stdio tests run real MCP servers
  via `npx`. A cold container downloads the package on first use; see the
  timeout budgets below. **Tests 8 and 9 are exempt**: registration is
  persist-only, so they register a non-existent package and never start a
  subprocess.
- `npx` on `PATH` inside the Langflow container (it ships there; verified on the
  nightly image).
- No LLM / provider key required — no agent executes.

---

## Step by step *(required)*

### 1 — `user must be able to change mode of MCP tools without any issues`

1. Bootstrap; blank flow; add the first MCP component from the sidebar.
2. Assert the node's `icon-Mcp` paths use the theme-correct fill.
3. Open the Add MCP Server modal → **stdio** tab; register
   `command: npx`, `args[0]: @modelcontextprotocol/server-everything` under a
   per-run random name.
4. Poll `GET /api/v2/mcp/servers?action_count=true` until the server's
   `toolsCount` is non-null; open `dropdown_str_tool` and pick `echo-0-option`.
5. Assert the `echo` tool's `message` input renders on the node.
6. Settings → MCP Servers → Edit the server: assert the JSON and HTTP tabs are
   disabled, stdio is enabled, and **both** `stdio-command-input` (`npx`) and
   `stdio-args_0` (the package) round-tripped.
7. Delete the server; assert it disappears from the list.

### 2 — `user must be able to add and delete MCP server from sidebar`

1. Bootstrap; blank flow; open the MCP sidebar and its add-server trigger.
2. Register the same `npx` + `server-everything` split under a random name.
3. Add the server's component to the canvas; assert `dropdown_str_tool` renders.
4. Settings → MCP Servers: assert the server is listed, delete it, assert it is
   gone.

### 3 — `STDIO MCP server fields should persist after saving and editing`

1. Bootstrap; add the `lf-starter_project` MCP component.
2. Open the modal → stdio tab; fill name, `command: uvx`, and **four** args —
   `mcp-server-test`, `--verbose`, `--port=8080`, `--config=test.json` — plus two
   env pairs. (`mcp-server-test` is a deliberately non-existent package: this
   test asserts form persistence, not connectivity, and registration is accepted
   independently of whether the subprocess starts.)
3. Save; Settings → MCP Servers → Edit.
4. Assert every field round-tripped: name, command, `stdio-args_0..3`, and both
   env key/value pairs.
5. Escape the modal and delete the server.

### 4 — `HTTP/SSE MCP server fields should persist after saving and editing`

Unchanged by #1091 (no stdio surface). Registers an HTTP server with two headers
and two env pairs, reopens it for edit, and asserts all ten field values
round-tripped; then deletes it.

### 5 — `mcp server tools should be refreshed when editing a server`

1. Bootstrap; add the `lf-starter_project` MCP component; `adjustScreenView`
   and assert the canvas-controls menu is closed (`zoom_out` hidden) — the
   postcondition gate kept from #1053/#997.
2. Register server **A**: `command: npx`,
   `args[0]: @modelcontextprotocol/server-sequential-thinking`.
3. Assert the node's tool dropdown exposes `sequentialthinking-0-option`
   (through `waitForMcpToolOption`, see below); select it and assert the tool's
   own inputs render on the node (`anchor-popover-anchor-input-thought` and
   `int_int_thoughtnumber`).
4. Settings → MCP Servers → Edit: assert `command` is `npx` and `args[0]` is the
   sequential-thinking package, then **edit `args[0]`** to
   `@modelcontextprotocol/server-everything` (server **B**) and save.
5. Return to the flow **by id** (`openFlowById`), re-select the server on the
   node, and assert the tool list now exposes `echo-0-option` — the refresh, not
   the cached A list.
6. Delete the server; assert it is gone; re-register it as **A** again, return to
   the flow by id, and assert the node's tool list is back to
   `sequentialthinking-0-option`.

Both re-opens address the flow by **id**, never by the card whose name contains
"New Flow" (#1340) — see the note below.

All three tool-list waits in this test go through
`helpers/mcp/wait-for-mcp-tool-option.ts` (#1422). It first requires the **node
to be bound to the expected server** (`mcp-server-dropdown` carrying
`testName`) — the readiness signal this surface actually has, since the tool
control is interactive ~140 ms after the modal closes while the component can
still be pointing at the previously selected server. Measured on
`1.12.0.dev25`: a run that skipped that check refreshed the list of
`lf-starter_project`, which resolved happily with that project's flows
(`new_flow`, `basic_prompting`) and no error at all. It then waits for the
**tool option itself** under `MCP_TOOL_LIST_TIMEOUT_MS` (120 s), and when the node
reports `Error loading server: …` it re-queries through the dropdown's own
`refresh-dropdown-list-tool` affordance, at most `MCP_TOOL_LIST_MAX_REFRESHES`
(3) times and no closer together than
`MCP_TOOL_LIST_REFRESH_INTERVAL_MS` (10 s) — unspaced, the three attempts were
measured spending themselves inside the first ~2 s of a 120 s budget, which is
the worst placement for a start that failed transiently — before failing with
the node's error text in the message. What it
replaced — `dropdown_str_tool:not([disabled])` under the 120 s budget, followed
by a 10 s wait for the option — put the whole budget on a control that is
enabled **113–145 ms** after the modal closes (measured, 1.12.0.dev24) and is
enabled in the error state too, leaving the tool list a 10 s wait and the
failure unattributed. See the note below.

### 6 — `Streamable HTTP MCP server with server-everything should load tools correctly`

Unchanged by #1091 (no stdio surface). Derives the project's own
`/api/v1/mcp/project/{id}/streamable` URL, registers it via the HTTP tab **with an
`x-api-key` header** (`http-headers-key-0` / `popover-anchor-http-headers-value-0`),
polls `toolsCount`, and asserts ≥1 tool option; cleans up the server and the key via
the API.

The header is what makes the poll meaningful rather than a wait on a value that can
never arrive: Langflow connects out to that URL itself, so with no credential stored
`GET /api/v2/mcp/servers?action_count=true` answers `toolsCount: null` with
`rejected the request with HTTP 403: the configured credential was refused`
(measured, #1522). The failure this test is here to catch — the endpoint not serving
its project's flows — and a missing credential both used to read as the same null.

### 7 — `stdio command with an embedded argument is refused, and command plus args is accepted` *(new)*

1. Bootstrap; blank flow; open the Add MCP Server modal → stdio tab.
2. Fill a random name and `command: npx @modelcontextprotocol/server-everything`
   (executable and package glued together); save.
3. Assert the **rejection**: the modal stays open (`add-mcp-server-button` still
   visible), an in-dialog `role="alert"` carries
   `/single executable name or path/`, and `GET /api/v2/mcp/servers` does **not**
   list the name.
4. Without closing the modal, correct the input — `command: npx`,
   `args[0]: @modelcontextprotocol/server-everything` — and save again.
5. Assert the **acceptance**: the modal closes, no alert remains, and the API now
   lists the server with `command === "npx"` and
   `args === ["@modelcontextprotocol/server-everything"]`.
6. Delete the server via the API.

### 8 — `a registered MCP server is read back individually with the fields it was created with` *(new, #1397)*

Pure API, no browser navigation and no subprocess: registration is persist-only,
so a **deliberately non-existent package** is used (the same reasoning as test 3)
and nothing is fetched from the npm registry.

1. Pre-clean the per-worker name (a crashed retry could have left it behind).
2. `POST /api/v2/mcp/servers/{name}` with `command: npx`,
   `args: ["mcp-server-read-back-probe"]` and one `env` pair; assert 2xx.
3. `GET /api/v2/mcp/servers/{name}`: assert **200** and that the body is exactly
   the config that was posted — `command`, `args` and `env` equal, and no extra
   keys. The `env` value round-trips through the encrypted column, so this also
   covers decryption on read.
4. Assert the single read carries **no `name`** field: the name is owned by the
   URL path, not the body (this is the same rule test 9 pins from the write side).
5. Assert the server is also listed by `GET /api/v2/mcp/servers`, so a single-read
   endpoint that answered from somewhere the list does not see would fail.

### 9 — `PATCH updates a registered server, merges at the top level, and refuses to rename it` *(new, #1397)*

1. Register the same shape as test 8.
2. `PATCH` with a **different** `args` package and nothing else: assert 200, then
   assert the change through a fresh `GET` — the response body alone would pass
   even if nothing were persisted.
3. Assert `command` **and** `env` survived: neither was mentioned by the patch, so
   both surviving is the evidence that the merge is per top-level key rather than
   a whole-document replace.
4. `PATCH` with only `env` (a different single pair): assert `command`/`args`
   survive and the previous `env` pair is **gone** — the merge replaces a key's
   value wholesale, it does not deep-merge into it.
5. `PATCH` with a body `name` that disagrees with the URL: assert **422** and a
   detail matching `/name is immutable/i`, then assert via `GET` that the stored
   config is untouched and carries no stray `name` key.

---

## Validation criterion *(required)*

- **stdio registration works only in the split shape.** A `command` carrying an
  embedded argument is refused with an in-dialog alert matching
  `/single executable name or path/` and creates no server; the same
  registration as `command` + `args[0]` is accepted, closes the modal, and is
  readable back from `GET /api/v2/mcp/servers` with exactly that command/args
  pair.
- **Tools resolve from a really-running server.** `dropdown_str_tool` exposes
  the tool testid the registered package actually serves
  (`echo-0-option` for `server-everything`, `sequentialthinking-0-option` for
  `server-sequential-thinking`) — not merely "some option".
- **The selected tool's own inputs render**: `popover-anchor-input-message`
  (echo), `anchor-popover-anchor-input-thought` + `int_int_thoughtnumber`
  (sequentialthinking).
- **Every modal field round-trips** save → edit: stdio name/command/`args_0..3`
  + 2 env pairs; HTTP name/URL + 2 headers + 2 env pairs.
- **The tool list refreshes on edit**: after changing `args[0]` from
  sequential-thinking to server-everything, the node exposes `echo-0-option`;
  after reverting, `sequentialthinking-0-option`. Each of those three waits is
  satisfied only by the option's own testid appearing — never by the tool
  control merely becoming enabled, which happens before any list exists and
  happens in the error state as well (#1422).
- **The single-server read returns what was stored, and only that.**
  `GET /api/v2/mcp/servers/{name}` answers 200 with a body deep-equal to the
  posted config — including the `env` pair, decrypted — with no `name` key and no
  extra keys, and the same server appears in the list endpoint.
- **`PATCH` persists, merges per top-level key, and cannot rename.** A changed
  `args` is visible on a subsequent `GET` and leaves `env` intact; a subsequent
  `env`-only patch leaves `command`/`args` intact and *replaces* the whole `env`
  object; a body `name` disagreeing with the URL is refused with 422 and changes
  nothing. Each patch names as few keys as possible, so what survives is evidence
  about the merge rather than about the patch echoing itself back.

## Guarding against false positives *(how)*

- **Per-run random server names** (`test_server_<5-digit>`) — no test can pass
  on a server a previous run left behind.
- **The Settings list is asserted through the row's own `mcp_server_name_<n>`
  span**, never `getByText(name)` (#1422). The page renders an extra `sr-only`
  span reading `"<name> error: …"` whenever the server carries an error, so the
  bare text locator resolves to two elements and dies as a strict-mode
  violation — twice in one full-file run on 1.12.0.dev25, and once on the
  2026-08-11 daily at `:588`. The scoped locator also makes the assertion mean
  "the row is listed" instead of "the string appears somewhere", and the
  post-delete check is `toHaveCount(0)`, which cannot pass on an ambiguous
  match the way `not.toBeVisible()` could.
- **Tool-name-specific option testids**, never `[data-testid*="-option"]` on the
  stdio path: a server that starts but serves the *wrong* tool set fails. This
  is exactly what the tool-refresh test turns into its assertion.
- **The contract test asserts both directions in one test.** A refusal assert
  alone would still pass if the modal rejected *everything*; the accepted-shape
  half proves the validation is discriminating, not blanket.
- **The contract test checks the API, not only the UI** — a modal that stays
  open while the server is created anyway would pass a UI-only assert.
- **Canvas-controls postcondition gate** (`zoom_out` hidden) in test 5 fails at
  the canvas controls instead of ~60 lines later as `<html> intercepts pointer
  events` (#576/#997/#1053).
- **Tests 8 and 9 assert through a fresh `GET`, never through the write's own
  response body.** `POST` and `PATCH` both echo the config back, so an endpoint
  that validated and returned without persisting would pass an echo-only assert.
- **Test 9 asserts a refusal next to a success**, the same argument as test 7: a
  422-only assert would still pass against an endpoint that refused *every*
  patch, and the merge assertions prove it is discriminating.
- **Deep equality, not field spot-checks**, on the read-back: an endpoint that
  quietly added a `name`, a `transport` label or a stray body key would pass a
  per-field check and fail this one.
- **Force-failure check** (CONTRIBUTING §2) executed per test during VERIFY.

---

## What this test does not cover *(optional)*

- MCP **tool execution** through a registered client server — covered by
  `mcp/client/mcp-client-regression.spec.ts` and `mcp/client/mcp-client-agent.spec.ts`.
- The MCP Server **tab** on a flow (exposing a project) — `mcp-server-tab.spec.ts`.
- Protocol-level tool listing/execution — `mcp-server-protocol.spec.ts`.
- Flow-file **resources** — `mcp-server-resources.spec.ts`.
- Registration **status codes** (409/404) — `mcp/client/mcp-server-registration-status-codes.spec.ts`.
- **The read/update paths for a name that does not exist.** Measured on nightly
  `1.12.0.dev20` and deliberately left unasserted, because both look wrong and
  asserting either way would be a decision this spec should not make on its own:
  `GET /api/v2/mcp/servers/{unknown}` answers **200 `null`** rather than the 404
  its sibling `DELETE` returns (upstream `#14005` fixed the delete path and left
  this one), and `PATCH /api/v2/mcp/servers/{unknown}` answers **200 and creates
  the server** — so a typo'd name silently registers a ghost instead of failing.
  Asserting today's behaviour would enshrine it; asserting the corrected
  behaviour would ship a durably red `@stable` test, which the current triage
  policy strips within a day. Both belong in a product-finding issue first.
- **The stdio security policy on the PATCH path.** Also measured: a merge patch
  that sends `args` **without** `command` is validated with no command in scope,
  so `{"args": ["-y", "…"]}` is refused with 422 (`dangerous keyword '-y'`) while
  the identical args are accepted by `POST` alongside `command: npx`. An
  args-only patch is otherwise fine — measured 200 — so test 9 sends one
  deliberately and simply avoids `-y`; the asymmetry itself is not asserted here.
- The rest of the stdio security policy — the arg blocklist
  (`DANGEROUS_KEYWORDS`), shell-metacharacter rejection, the docker-arg policy
  and the env blocklist are **not** covered here; test 7 covers only the
  command-shape rule.
- `uvx`-launched MCP servers that actually start. See *Notes*.

---

## External dependencies *(required)*

- **Langflow's stdio security policy** —
  `src/lfx/src/lfx/base/mcp/security.py` → `validate_mcp_stdio_config()`.
  Since upstream `f4d6ac4` (PR `#14073`, 2026-07-15, forward-porting the
  release-1.10.3 multi-tenant hardening from `#13530`/`#14044`), `command` must
  be a single executable name or path; options and arguments belong in `args`.
  `npx` and `uvx` remain in `ALLOWED_MCP_COMMANDS`. This is the contract test 7
  pins.
- **Public npm registry** — `@modelcontextprotocol/server-everything` and
  `@modelcontextprotocol/server-sequential-thinking` are fetched by `npx` inside
  the Langflow container.
- Add-MCP-server modal testids (`stdio-tab`, `stdio-name-input`,
  `stdio-command-input`, `stdio-args_N`, `input-list-plus-btn_-0`,
  `stdio-env-key-N`/`stdio-env-value-N`, `stdio-env-plus-btn-0`, `http-tab`,
  `http-name-input`, `http-url-input`, `http-headers-*`, `http-env-*`,
  `add-mcp-server-button`) and `helpers/mcp/open-add-mcp-server-modal.ts`.
- Settings → MCP Servers page (`sidebar-nav-MCP Servers`,
  `add-mcp-server-button-page`, `mcp-server-menu-button-<name>`,
  `btn_delete_delete_confirmation_modal`).
- MCPTools node (`dropdown_str_tool`, `mcp-server-dropdown`, `list_item_<name>`).
- `src/backend/base/langflow/api/v2/mcp.py` — the MCP v2 server API behind tests
  8 and 9: `get_server_endpoint` (the single read, which returns the *decrypted*
  config), `update_server(..., merge_existing=True)` (the PATCH merge and its
  version guard) and `_enforce_immutable_server_name` (the 422 whose detail test 9
  matches).
- `src/backend/base/langflow/api/v2/schemas.py` — `MCPServerConfig`, the PATCH/POST
  request model. Its `extra="allow"` is precisely why the immutable-name rule has
  to exist, and its `_validate_stdio_security` validator is what refuses an
  args-only patch (see *What this test does not cover*).
- `GET`/`PATCH`/`POST`/`DELETE /api/v2/mcp/servers[/{name}]`,
  `helpers/auth/get-auth-token.ts`,
  `helpers/other/await-bootstrap-test.ts`, `helpers/ui/adjust-screen-view.ts`,
  `helpers/ui/zoom-out.ts`, `helpers/flows/delete-flow.ts`,
  `helpers/flows/add-component-from-sidebar.ts`
  (`addComponentFromSidebarWithoutSearch`),
  `helpers/mcp/wait-for-mcp-tool-option.ts` (`waitForMcpToolOption`).

---

## When to review this test *(optional)*

- If `validate_mcp_stdio_config()` changes which command shapes are accepted, or
  the rejection message stops matching `/single executable name or path/`.
- If the add-server modal testids or the args/env list controls change.
- If either `@modelcontextprotocol` package renames its tools (`echo`,
  `sequentialthinking`) or stops publishing.
- If the MCPTools node's tool-input testid derivation changes (integers are
  lowercased into `int_int_<name>`; strings keep their case in
  `popover-anchor-input-<name>`).
- If the dropdown stops rendering `refresh-dropdown-list-tool`, or the node's
  failure label stops matching `/Error loading (server|tools)/` — the first is
  the only way `waitForMcpToolOption` can re-query, the second is the only way
  it can tell a dead server from a wrong tool set (#1422).
- If Langflow starts re-querying a failed MCP tool list on its own: the bounded
  refresh loop would then be redundant, and the spec should say so rather than
  keep paying for it.
- If `MCPServerConfig` gains or drops a field, or the single read starts
  returning a wrapper (a `name`, a transport label) instead of the bare config —
  test 8's deep equality is the assertion that will say so.
- If the PATCH merge changes granularity (deep-merging `env` instead of
  replacing it), or `_enforce_immutable_server_name` stops answering 422.

---

## Notes *(optional)*

- **#1422 — the 120 s tool-list budget was hanging on a control that is ready in
  140 ms, and the failure blamed the UI for a dead subprocess.** Test 5 waited
  for `dropdown_str_tool:not([disabled])` under `TOOL_LIST_TIMEOUT` (120 s) and
  then gave the tool option 10 s. Measured on nightly `1.12.0.dev24`: that
  control becomes enabled **113–145 ms** after the add-server modal closes,
  while the option itself lands at ~2 s on a cold npm cache — so the enabled
  state never said anything about the list, the 120 s was never spent, and the
  real budget for a `npx`-fetched stdio server was 10 s. Worse, the control is
  enabled in the **error** state too: with a package that cannot be installed
  the node shows `Error loading server: Connection closed`, the dropdown shows
  `No options found`, and the option never appears — reproduced deterministically
  (error visible at 1.2–1.6 s, 3 runs). That is exactly the state the
  2026-08-11 daily died in on all three attempts (`error-context` snapshot, run
  31475108157): `POST /api/v1/custom_component/update` answered **200 in 3.9 s
  carrying the error**, so the stdio child had died — not the 30 s
  `_create_stdio_session` budget running out, which would have read
  `Timeout waiting for STDIO session … to initialize`. Slow-cold-`npx` is
  therefore ruled out as the mechanism, and so is cross-suite interference: the
  MCP suites added in #1395/#1396 ran on shards 3 and 4, each shard being a job
  with its own Langflow service container and its own database, and neither
  deletes servers it did not create. What remains is a runner-side stdio start
  that failed and a UI that never retries it. The wait now goes through
  `waitForMcpToolOption`, which spends the 120 s on the option, re-queries via
  `refresh-dropdown-list-tool` up to 3 times when the node reports an error
  (measured to recover), and fails carrying that error text. The bounded refresh
  is not a mute: a server that never starts still fails the test, and now says
  why.
- **#1340 — test 5 re-opened a flow by NAME, and it opened the wrong one.** Both
  re-opens clicked the first `list-card` whose name contained "New Flow".
  Langflow names every blank flow "New Flow"/"New Flow (N)", so under
  `fullyParallel` the shared project holds one per worker and `.first()` resolves
  whichever the list puts first. Measured on nightly `1.12.0.dev18`: in isolation
  the test's own flow ranks first and the click is correct (which is why this
  never appeared in the daily history — no recorded failure on this test), but
  seeding **one** competing `New Flow …` in the same project before the list
  fetch is enough to flip it — the rendered order became
  `["New Flow probeB-…", "New Flow (1)", "Basic Prompting"]`, the click opened
  the competitor, and the test then died on the `text="MCP Tools"` wait at 30 s,
  blaming the node for a flow it was never in. The same locator, in
  `auto-save-off.spec.ts`, cost two dailies before it was diagnosed (#1336). Both
  re-opens now use `openFlowById` (#1214), the repo's by-id entry, which also
  seeds the assistant-onboarding flag and gates on the flow being writable —
  neither of which the card click did (#1005). The flow id is read AFTER the
  blank-flow navigation, never before it: the bootstrap parks the page on a
  placeholder flow Langflow deletes as soon as the modal navigates elsewhere
  (#490/#681).
- **Pre-existing flake, NOT introduced by #1340: `openAddMcpServerModal`.** This
  test fails roughly 1 run in 3 locally at
  `helpers/mcp/open-add-mcp-server-modal.ts:10` (`mcp-server-dropdown`,
  `locator.click: Timeout 3000ms exceeded`) — the #1335 signature, in a second
  file. Confirmed by a control run of the unmodified spec: same 2/3, same step.
  Raising that budget to 30 s locally did not help under `--workers=2+`, where
  the dropdown simply never becomes clickable; a 4-worker burst of this spec
  fails 3/4 there, always before the re-open. That budget belongs to #1335 and is
  deliberately untouched here — it is a shared MCP helper with other callers.

- **Why `npx` and not `uvx` for the servers that must really start.** Before
  #1091 tests 1/2/5 registered `uvx mcp-server-fetch` / `mcp-server-time`.
  Splitting those into `command` + `args` gets past the new validation but the
  subprocess still dies: the published `mcp-server-fetch` and `mcp-server-time`
  packages fail at import against the current `mcp` Python SDK —
  `ImportError: cannot import name 'McpError' from 'mcp.shared.exceptions'`
  (renamed to `MCPError`), reproduced inside the nightly container and **not**
  fixed by pinning the server version, because the `mcp` dependency floats.
  That is a third-party breakage in `modelcontextprotocol/servers`, outside both
  Langflow and this suite. The `npx` servers start cleanly on the same image and
  are already the shape the `@stable` `mcp/client/` specs use, so tests 1/2/5
  register through `npx`. `uvx` stays covered as a *command* by test 3, which
  only asserts form persistence.
- **Timeout budgets.** `npx` cold-starts a package download on a fresh
  container. The sibling stdio test in `mcp-client-regression.spec.ts` was
  raised to **120 s** for exactly this (#463), so the tool-list waits here use
  the same 120 s budget rather than the 30 s the file carried while it was
  never running in CI. The subsequent option/testid waits stay short (10 s) —
  once `toolsCount` is non-null the dropdown is local state. Test 5 carries
  **three** of those 120 s waits (register A → edit to B → re-register A), which
  does not fit the suite's 5-minute per-test cap, so it raises its own budget to
  8 min via `test.setTimeout` — otherwise a slow registry surfaces as a test
  timeout instead of as the wait that actually ran out.
- **A second defect the fix exposed.** With registration working again, test 1
  reached an assertion it had never executed: it sampled the selected tool's
  `message` input with a bare `count()` immediately after clicking the option.
  The node's inputs arrive with a rebuild a beat later, so the count was 0. It
  is now an auto-retrying `toBeVisible`, matching how the `@stable` sibling that
  selects the same `echo` tool waits (`mcp-client-regression.spec.ts`) — which
  is why that spec never hit the race and this one could not have, while its
  registration was failing 60 lines earlier.
- **Flow cleanup.** Every test bootstraps and creates a flow. Ids are collected
  from `POST /api/v1/flows` 201 responses (pattern A — `awaitBootstrapTest` runs
  first, so the canvas URL id is not trustworthy, #681) and deleted id-scoped in
  `afterEach`. Registered MCP servers are also deleted by name in `afterEach`, so
  a mid-test failure cannot leak one into the next run.
- Trace-on may hang on this ReactFlow-canvas family (see the skill's known
  `--trace=on` limitation); step verification relies on `--retries=0` bursts +
  force-fail.
- A commented-out seventh block (SSE against a public Cloudflare MCP endpoint)
  remains at the bottom of the file, untouched by #1091.
- **The three MCP-starter adds are repaired, not bare clicks** (#1335). Langflow
  swallows that sidebar click on the MCP tab roughly half the time on nightly
  1.12.0.dev17 (measured 4/8, all 4 repaired by an identical second click), and
  every entry point of the add-server modal hangs off the node it should have
  created. Measured locally on dev17 before and after: this file failed 3 of its
  6 runnable tests with the bare clicks — including the `@stable` tests 3
  ("STDIO … fields should persist") and 5 ("tools should be refreshed …") — and 1
  of 6 with `addComponentFromSidebarWithoutSearch`. The remaining failure is test
  6 ("Streamable HTTP … server-everything"), which registers through the sidebar
  page rather than the modal, fails identically with and without this change, and
  is not `@stable`.
