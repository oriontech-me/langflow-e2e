# MCP Server — add-server modal: stdio / HTTP registration, field persistence & tool refresh

**Last validated:** Langflow 1.13.x (tests 1–7 on nightly `1.12.0.dev9`; tests 8–9 on
`1.12.0.dev20`; tests 1 and 6 re-validated on `1.12.0.dev39` under #1266; test 5's
auto-binding assertion and the node-scoped `openAddMcpServerModal` on `1.13.0.dev30`
under #1447; tests 3, 4, 8 and 9 rewritten to the masked read-back contract, and test 10
added, on `1.13.0.dev35` under #2215)

---

## What this test validates *(required)*

Covers the **Add MCP Server modal** as the registration surface for external MCP
servers, across both transports, plus the security contract the stdio form now
enforces (QA-CHECKLIST §14.1):

1. **stdio registration round-trip** — a server registered with
   `command` + `args` resolves its tools into the MCPTools node's
   `dropdown_str_tool`, renders the selected tool's inputs on the node, appears
   in Settings → MCP Servers, and can be edited and deleted from there.
2. **Field persistence under the masked read-back contract** (#2215) — every
   stdio field (name, command, N args, N env pairs) and every HTTP/SSE field
   (name, URL, N headers, N env pairs) survives save → reopen-for-edit: the
   structural fields and every env/header **key** come back verbatim, and every
   env/header **value** comes back as the literal mask `********` — never the
   plaintext, never empty.
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
   fields it was created with (env values masked, #2215), and
   `PATCH /api/v2/mcp/servers/{name}` updates them, merging at the top level,
   refusing to rename, and refusing a mask that names no stored value.
7. **An untouched edit keeps the stored credential** (#2215) — saving the edit
   modal without touching a masked header leaves Langflow holding the real
   credential, proven by an **effect** that uses it (Langflow authenticating to
   its own MCP transport), never by a response body, which can only ever show
   the mask.

If this fails, external MCP servers can no longer be registered from the UI, the
modal loses field state, the tool list serves stale data after an edit, the
stdio input-shape validation that keeps every policy layer seeing the same argv
has been dropped, the API the modal's edit path is built on stops returning what
it stored, a management response discloses a stored credential again, or an
untouched edit overwrites a credential with its own mask.

---

## Tags *(required)*

`@release` `@workspace` `@components` `@mcp` `@stable`
(plus `@regression` on the command/args contract test, and `@api` on the
read-back/update tests; test 10 is `@regression` `@mcp` `@settings` `@stable`)

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
- `@stable` on test 1 was **removed as a quarantine** at the 2026-08-04 triage
  (#1258) and restored in the #1266 fix PR, re-validated per `CONTRIBUTING.md` on
  nightly `1.12.0.dev39`. The quarantine was `test.fixme` + tag removal, so the
  test ran in no lane at all while it stood.
- `@stable` on tests 3, 4, 8 and 9 was **removed by the daily's auto-removal**
  (`8b8d2a487`, VM lane run `20261007T080014Z`, `1.13.0.dev35`) after all four
  read back `"********"` where they expected the value they saved, and restored
  in the #2215 fix PR once they asserted the masked contract instead. Nothing
  was quarantined (no `test.fixme`).
- Test 10 carries `@regression` because it guards an upstream security fix
  (langflow-ai/langflow#15529, the same reasoning as the contract test above),
  `@settings` because it drives Settings → MCP Servers, and ships `@stable`:
  it needs no subprocess, no npm registry and no LLM — only the instance's own
  MCP transport, which test 6 already depends on in every lane.
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
4. Wait for the server to report a tool count via
   `waitForMcpToolsCount` — a probe of
   `GET /api/v2/mcp/servers?action_count=true` that treats its OWN failure as
   "not ready yet" and only gives up when the whole budget is spent (#1266; see
   *Notes*). Then open `dropdown_str_tool` and pick `echo-0-option`.
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
4. Assert every field round-tripped: name, command, `stdio-args_0..3` and both
   env **keys** verbatim, and both env **values** as exactly `********` (#2215 —
   see *Validation criterion* for why exactly the mask, and not merely "not the
   plaintext").
5. Escape the modal and delete the server.

### 4 — `HTTP/SSE MCP server fields should persist after saving and editing`

Unchanged by #1091 (no stdio surface). Registers an HTTP server with two headers
and two env pairs, reopens it for edit, and asserts all ten fields round-tripped:
name, URL and the four keys verbatim, and the four values (two headers, two env)
as exactly `********` (#2215); then deletes it. Two of those values are not
secrets (`application/json`, `30000`) and are masked anyway: the redaction is
per map, not per value — every non-empty value of `env` and `headers` is masked.

### 5 — `mcp server tools should be refreshed when editing a server`

1. Bootstrap; add the `lf-starter_project` MCP component; `adjustScreenView`
   and assert the canvas-controls menu is closed (`zoom_out` hidden) — the
   postcondition gate kept from #1053/#997.
2. Register server **A** through the **node's own** Add MCP Server modal
   (`openAddMcpServerModal`, see below): `command: npx`,
   `args[0]: @modelcontextprotocol/server-sequential-thinking`.
3. Assert the node is **bound to A without being re-selected**:
   `mcp-server-dropdown` reads A's name once the modal closes. A modal opened
   from a node binds that node to the server it creates
   (`McpComponent.handleSuccess`, #1447), so this is asserted, never performed.
4. Assert the node's tool dropdown exposes `sequentialthinking-0-option`
   (through `waitForMcpToolOption`, see below); select it and assert the tool's
   own inputs render on the node (`anchor-popover-anchor-input-thought` and
   `int_int_thoughtnumber`).
5. Settings → MCP Servers → Edit: assert `command` is `npx` and `args[0]` is the
   sequential-thinking package, then **edit `args[0]`** to
   `@modelcontextprotocol/server-everything` (server **B**) and save.
6. Return to the flow **by id** (`openFlowById`), re-select the server on the
   node, and assert the tool list now exposes `echo-0-option` — the refresh, not
   the cached A list.
7. Delete the server; assert it is gone; re-register it as **A** again, return to
   the flow by id, and assert the node's tool list is back to
   `sequentialthinking-0-option`.

The two re-selections in steps 6 and 7 stay: those servers are edited or
re-registered from **Settings**, not from the node, so nothing promises the node
a binding there — only the node's own modal does (step 3).

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

**Every node-side registration opens the node's modal, never the sidebar's**
(#1447). Tests 1, 3, 4 and 5 — and `mcp-server-tab.spec.ts` — go through
`helpers/mcp/open-add-mcp-server-modal.ts` → `openAddMcpServerModal`, which
clicks the node's `mcp-server-dropdown` and then the "Add MCP Server" button
**inside the server-list dialog it opens** (`role="dialog"`), never a page-wide
`getByText("Add MCP Server")`. With the MCP sidebar tab open, the sidebar's
`sidebar-add-mcp-server-button` carries the same text and is the **only** match
until the list dialog renders, so a dropdown click that did not open the dialog
used to fall through to it: the SIDEBAR's modal opened, with the same testids,
the server was created, and the node was never bound — with no error anywhere.
When the dialog does not open, the helper re-clicks the dropdown (at most
`NODE_LIST_DIALOG_ATTEMPTS` times) and otherwise fails naming the dropped click.

### 6 — `Streamable HTTP MCP server with server-everything should load tools correctly`

Unchanged by #1091 (no stdio surface). Derives the project's own
`/api/v1/mcp/project/{id}/streamable` URL, registers it via the HTTP tab **with an
`x-api-key` header** (`http-headers-key-0` / `popover-anchor-http-headers-value-0`),
waits for `toolsCount` through the same `waitForMcpToolsCount` probe as test 1
(#1266), and asserts ≥1 tool option; cleans up the server and the key via the API.

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
   `args: ["mcp-server-read-back-probe"]` and one `env` pair; assert 2xx, and
   that the **create response** already carries the env value as `********` —
   the write's echo is a management response too, and #15529 masks all three
   (`GET`, `POST`, `PATCH`).
3. `GET /api/v2/mcp/servers/{name}`: assert **200** and that the body is exactly
   the posted config **with the env value replaced by `********`** — `command`,
   `args` and the env key equal, and no extra keys (#2215). Before #15529 this
   read returned the decrypted value; it now never discloses it, so decryption is
   no longer observable here — test 10 proves the stored credential by effect.
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
   a whole-document replace. `env` reads back as `{MCP_PROBE_TOKEN: "********"}`
   (#2215): the key survived and still holds a non-empty value — an empty one
   would read back as `""`, not as the mask.
4. `PATCH` with only `env` (a different single pair): assert `command`/`args`
   survive and the previous `env` pair is **gone** — the merge replaces a key's
   value wholesale, it does not deep-merge into it (`{MCP_PROBE_OTHER: "********"}`).
5. `PATCH` whose `env` sends `********` for a key that holds **no** stored value
   (#2215): assert **422** with a detail matching
   `/can only preserve an existing value/i`, then assert via `GET` that the stored
   config is untouched. A mask may only stand for a credential Langflow already
   holds; accepting one for a new key would store the placeholder itself.
6. `PATCH` with a body `name` that disagrees with the URL: assert **422** and a
   detail matching `/name is immutable/i`, then assert via `GET` that the stored
   config is untouched and carries no stray `name` key.

### 10 — `an untouched edit keeps the stored MCP credential — Langflow still authenticates to itself` *(new, #2215)*

No subprocess, no npm registry, no LLM: the registered server is the instance's
**own** project transport, the same self-call test 6 makes, because it is the
only MCP server this suite can reach whose answer depends on the stored header.

1. Mint an API key (`createApiKey`) and derive the first project's
   `/api/v1/mcp/project/{id}/streamable` URL from `PLAYWRIGHT_BASE_URL`.
2. `POST /api/v2/mcp/servers/{name}` with that `url` and
   `headers: {"x-api-key": <key>}`; assert 2xx.
3. `GET /api/v2/mcp/servers/{name}`: assert the body is exactly
   `{url, headers: {"x-api-key": "********"}}` — the URL verbatim, the credential
   masked.
4. Settings → MCP Servers → **Edit** the server: assert `http-url-input` is the
   URL, `http-headers-key-0` is `x-api-key`, and
   `popover-anchor-http-headers-value-0` reads `********`.
5. Save the modal **without touching anything**; wait for its
   `PATCH /api/v2/mcp/servers/{name}` and assert **200** (the modal resends the
   masks it was shown — measured on `1.13.0.dev35`, see *Notes*).
6. **Effect:** `waitForMcpToolsCount` resolves with a number — Langflow
   connected to itself with the stored header, so the mask resolved to the real
   key. Had the save stored `********` literally, the transport would refuse it.
7. **Control:** `PATCH` the header to a value that is not a key; assert the
   server is then reported as refused (`the configured credential was refused`)
   by `waitForMcpCredentialRefused`. Without this step, step 6 would also pass
   against a transport that stopped checking credentials — the shape `1.12.0.dev31`
   had, where a keyless request answered 200 (#1522).
8. Delete the server and the key (`afterEach`, id-scoped).

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
  + 2 env keys; HTTP name/URL + 2 header keys + 2 env keys — all verbatim — and
  every env/header **value** reads exactly `********` (#2215). Exactly the mask,
  not "anything but the plaintext": Langflow masks only a **non-empty** value
  (an empty one reads back as `""`), so the mask is also the evidence that a
  value was stored at all, and a looser check would pass on a field the modal
  dropped.
- **The node's own modal binds the node.** When the Add MCP Server modal opened
  from the MCP Tools node closes, `mcp-server-dropdown` reads the name of the
  server that modal just created — asserted before the test touches the server
  field at all, so the binding is Langflow's, not the test's (#1447).
- **The tool list refreshes on edit**: after changing `args[0]` from
  sequential-thinking to server-everything, the node exposes `echo-0-option`;
  after reverting, `sequentialthinking-0-option`. Each of those three waits is
  satisfied only by the option's own testid appearing — never by the tool
  control merely becoming enabled, which happens before any list exists and
  happens in the error state as well (#1422).
- **The single-server read returns what was stored, and only that — with the
  credential masked.** `GET /api/v2/mcp/servers/{name}` answers 200 with a body
  deep-equal to the posted config with each env value replaced by `********`, no
  `name` key and no extra keys; the create response is masked the same way; the
  same server appears in the list endpoint.
- **`PATCH` persists, merges per top-level key, refuses an orphan mask, and
  cannot rename.** A changed `args` is visible on a subsequent `GET` and leaves
  `env` intact (still masked, still non-empty); a subsequent `env`-only patch
  leaves `command`/`args` intact and *replaces* the whole `env` object; an `env`
  carrying `********` for a key with no stored value is refused with 422
  (`/can only preserve an existing value/i`) and changes nothing; a body `name`
  disagreeing with the URL is refused with 422 and changes nothing. Each patch
  names as few keys as possible, so what survives is evidence about the merge
  rather than about the patch echoing itself back.
- **An untouched edit keeps the credential, proven by effect, with a control.**
  After the edit modal is saved untouched (`PATCH` 200), `waitForMcpToolsCount`
  resolves with a number for a server whose only credential is the masked
  `x-api-key`; after that header is patched to a non-key, the same server is
  reported with `the configured credential was refused`. The pair is the
  criterion — the first half alone cannot tell a preserved credential from a
  transport that stopped checking one.

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
- **The binding assertion cannot be satisfied through the wrong modal.** The
  sidebar's Add MCP Server modal never binds a node, so a misrouted open — the
  #1447 mechanism — fails test 5 at the binding instead of passing on a server
  selection the test performed itself, which is what the precondition it
  replaces did. Measured on `1.13.0.dev30`: with the node's dropdown click
  swallowed, the unscoped helper opened the sidebar's modal and the node stayed on
  `lf-starter_project`; the scoped helper re-clicks instead.
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
- **No response body is ever the evidence for a stored credential** (#2215).
  Since #15529 every management read answers `********` whether Langflow holds
  the real value or the mask itself, so a body cannot tell the two apart. Test 10
  proves it by what the credential *does* — Langflow authenticating to its own
  transport — and pairs that with a refused control, because a transport that
  answered without checking (`1.12.0.dev31`, #1522) would make the effect pass
  on any stored value.
- **The orphan-mask refusal sits next to an accepted mask**, for the same reason
  test 7 asserts both directions: the 422 alone would pass against an endpoint
  that refused every masked write, which would break the modal's whole edit path.
- **Force-failure check** (CONTRIBUTING §2) executed per test during VERIFY.

---

## What this test does not cover *(optional)*

- MCP **tool execution** through a registered client server — covered by
  `mcp/client/mcp-client-regression.spec.ts` and `mcp/client/mcp-client-agent.spec.ts`.
- The MCP Server **tab** on a flow (exposing a project) — `mcp-server-tab.spec.ts`.
- Protocol-level tool listing/execution — `mcp-server-protocol.spec.ts`.
- Flow-file **resources** — `mcp-server-resources.spec.ts`.
- Registration **status codes** (409/404), including `GET` and `PATCH` of a name
  that does not exist (404, and the PATCH creates nothing; #1406) —
  `mcp/client/mcp-server-registration-status-codes.spec.ts`.
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
- **The stored value of an `env` entry** (#2215). No management read discloses it
  any more, and no MCP server this suite can reach makes it observable — a stdio
  child would have to echo its environment through a tool call. The env half of
  the restore logic is covered by **shape only** (tests 3, 8, 9: the key survives
  and holds a non-empty value; an orphan mask is refused); its value is proven by
  effect only for `headers` (test 10). Both maps go through the same
  `restore_mcp_config_secrets` loop upstream, which is the argument — not a
  measurement — that one effect stands for both.
- **The mask in `mcp-proxy --headers NAME VALUE` arguments**, which #15529 also
  redacts and restores by header name and occurrence. No spec here registers a
  server through `mcp-proxy`.

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
- `src/frontend/src/components/core/parameterRenderComponent/components/mcpComponent/index.tsx`
  — `McpComponent`: `handleSuccess`, passed to `AddMcpServerModal` as
  `onSuccess`, is what binds the node to the server its modal created (test 5's
  step 3); its `[name, options]` effect clears the binding when the server list
  does not contain the bound name (see the #1447 note).
- `src/frontend/src/CustomNodes/GenericNode/components/ListSelectionComponent/index.tsx`
  — the node's server-list dialog; its footer button (no testid, text
  "Add MCP Server") is the one `openAddMcpServerModal` clicks, scoped to the
  dialog.
- `src/frontend/src/modals/addMcpServerModal/index.tsx` — the modal both entry
  points open; it writes the new server into the `useGetMCPServers` cache before
  calling `onSuccess`.
- `src/backend/base/langflow/api/v2/mcp.py` — the MCP v2 server API behind tests
  8, 9 and 10: `get_server_endpoint`, `add_server` and `update_server_endpoint`
  (each returns `redact_mcp_config(...)` since langflow-ai/langflow#15529),
  `update_server(..., merge_existing=True)` (the PATCH merge and its version
  guard), `_restore_config_secrets` (the orphan-mask 422 test 9 matches) and
  `_enforce_immutable_server_name` (the immutable-name 422 test 9 matches).
- `src/backend/base/langflow/services/auth/mcp_encryption.py` —
  `MCP_CONFIG_VALUE_MASK` (`"********"`), `redact_mcp_config` (masks every
  non-empty value of the `env`/`headers` maps and of `mcp-proxy --headers`
  arguments) and `restore_mcp_config_secrets` (a mask resolves to the latest
  stored value of the same key; a mask for a key with no stored value raises the
  `can only preserve an existing value` error). Introduced by
  langflow-ai/langflow#15529 (*fix(mcp): redact server credentials from
  management responses*, merged to `release-1.12.5` on 2026-10-04 and into the
  1.13 line between `1.13.0.dev34` and `1.13.0.dev35`) — the contract tests 3, 4,
  8, 9 and 10 assert (#2215).
- `src/frontend/src/modals/addMcpServerModal/index.tsx` — on edit it renders the
  masked values as plain text and its save (`usePatchMCPServer`) resends them
  verbatim; test 10's untouched save depends on that round trip.
- `src/backend/base/langflow/api/v1/mcp_projects.py` — the project transport test
  10 registers; its API-key gate is what makes the stored header observable.
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
  `helpers/mcp/wait-for-mcp-tool-option.ts` (`waitForMcpToolOption`),
  `helpers/mcp/wait-for-mcp-tools-count.ts` (`waitForMcpToolsCount`,
  `waitForMcpCredentialRefused`), `helpers/auth/create-api-key.ts`.

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
- If `McpComponent` stops binding the node to the server its own modal created
  (`handleSuccess` no longer wired as the modal's `onSuccess`): test 5's step 3
  is the assertion that will say so, and it must be triaged as a product change,
  not re-written into a selection.
- If the node's server-list dialog stops rendering an "Add MCP Server" button
  inside `role="dialog"`, or gains a testid for it — `openAddMcpServerModal`
  should then address it by that testid.
- If the dropdown stops rendering `refresh-dropdown-list-tool`, or the node's
  failure label stops matching `/Error loading (server|tools)/` — the first is
  the only way `waitForMcpToolOption` can re-query, the second is the only way
  it can tell a dead server from a wrong tool set (#1422).
- If Langflow starts re-querying a failed MCP tool list on its own: the bounded
  refresh loop would then be redundant, and the spec should say so rather than
  keep paying for it.
- If `GET /api/v2/mcp/servers?action_count=true` starts caching its per-server
  connection, capping concurrency, or answering from stored counts: the probe
  budgets in `waitForMcpToolsCount` are sized for the measured behaviour above
  and should be re-measured, not assumed (#1266).
- If `MCPServerConfig` gains or drops a field, or the single read starts
  returning a wrapper (a `name`, a transport label) instead of the bare config —
  test 8's deep equality is the assertion that will say so.
- If the PATCH merge changes granularity (deep-merging `env` instead of
  replacing it), or `_enforce_immutable_server_name` stops answering 422.
- If `MCP_CONFIG_VALUE_MASK` changes, or the redaction narrows to the values it
  judges secret (today `application/json` and `30000` are masked too — tests 3
  and 4 would then fail on those fields, and the right response is to re-read
  the redaction rule, not to unmask the assertion wholesale).
- If the edit modal stops resending the masks it shows (e.g. it starts rendering
  credentials as empty password fields): an untouched save would then send `""`
  or omit the map, and test 10's effect is the assertion that decides whether the
  credential survived it.
- If the project transport's refusal stops reading `the configured credential
  was refused` — measured as **HTTP 401** on `1.13.0.dev35` (it was 403 on
  `1.12.0.dev33`, #1522), which is why the control matches the phrase and not
  the status code.

---

## Notes *(optional)*

- **#2215 — four tests read back `"********"`, and the product was right.** On
  the first day of `1.13.0.dev35` (VM lane run `20261007T080014Z`, 2026-10-07)
  tests 3, 4, 8 and 9 failed 3/3 attempts each, every one on an env or header
  value reading the literal mask, and lost `@stable` to the auto-removal. The
  `v1.13.0.dev34...v1.13.0.dev35` range carries langflow-ai/langflow#15529, which
  masks credentials in every MCP management response by design. Measured on a
  fresh `1.13.0.dev35` container before any test changed:

  | Request | Answer |
  |---|---|
  | `POST` stdio with `env: {T: "probe-value", EMPTY: ""}` | 200, `env: {T: "********", EMPTY: ""}` — an empty value stays `""` |
  | `GET` of the same server | identical to the create response |
  | `PATCH {args}` (args only) | 200, `env` still `{T: "********", …}` — key and value survived |
  | `PATCH {env: {T: "********"}}` (mask for a stored key) | 200, value preserved |
  | `PATCH {env: {T: "********", NEW: "********"}}` | **422** `A redacted MCP credential can only preserve an existing value.` |
  | `POST` with `env: {K: "********"}` | **422**, same detail, and no server is created |
  | `GET` of an unknown name | **404** `Server not found.` |

  The question that decides *regression* vs *intended* is whether the mask can
  leak into the **stored** config, so it was answered by effect, with the
  instance's own project transport registered behind an `x-api-key` header: with
  the real key it connects (`toolsCount: 0` — the fresh project had no flows —
  and no credential error); after a `PATCH` resending only masks it still
  connects; after the header is patched to a non-key it is refused
  (`rejected the request with HTTP 401: the configured credential was
  refused`); and a mask sent after that keeps the **latest** stored value, so it
  stays refused. Driven through the UI, the edit modal renders every env/header
  value as `********` in an ordinary text input, an untouched save sends
  `PATCH {url, env: {…: "********"}, headers: {…: "********"}}`, the backend
  answers 200 and the server still connects. No leak on any path — so the four
  tests were asserting a contract the product deliberately withdrew (plaintext
  read-back), and are rewritten to the one it offers instead: keys and
  structural fields verbatim, values masked, an orphan mask refused, and the
  credential proven by what it does (test 10).

- **#1266 — the readiness poll could not survive the slowness it existed to wait
  out, and the test paid for load it was itself creating.** Tests 1 and 6 waited
  for `toolsCount` with a bare `expect.poll` whose poller called
  `page.request.get("/api/v2/mcp/servers?action_count=true")` with no explicit
  timeout. Two facts make that shape indefensible. **`expect.poll` propagates a
  throw from the poller** instead of treating it as "not ready", so the first
  probe to exceed the suite's 20 s `actionTimeout` aborted the test — the 120 s
  budget was unreachable. The recorded signature proves the propagation: a
  swallowed failure would read `expect.poll … timed out after 120000ms`, and
  what three dailies recorded (2026-07-30, 2026-08-03, 2026-08-04) was
  `TimeoutError: apiRequestContext.get: Timeout 20000ms exceeded.`
  **And the endpoint really is that slow under concurrency.** Measured on
  `1.12.0.dev39` (4 CPU, `LANGFLOW_WORKERS=1`), `action_count=true` starts EVERY
  registered server on EVERY call — `langflow/api/v2/mcp.py` builds a fresh
  `MCPStdioClient` per server inside `check_server` and disconnects it in
  `finally`, so a stdio server costs one `npx` subprocess per request, with no
  cache and no concurrency cap:

  | Registered servers | c=1 | c=2 | c=3 | c=4 | c=6 |
  |---|---|---|---|---|---|
  | 2 (1 stdio) | 1.25 s | 1.33–1.44 s | 1.73–1.92 s | 1.60–1.97 s | — |
  | 4 (3 stdio) | 1.25 s | 1.74–1.78 s | 3.03–4.09 s | 4.16–6.52 s | **137.9 s, all six** |

  Cold first call: 2.98 s at one server, 5.30 s at two. Sequentially by server
  count the same instance degrades past the budget on its own at nine servers
  (9.3 / 14.0 / 20.6 s). This is **not a regression** — `1.12.0.dev37` measures
  the same, and on that 47-hour-old instance the cliff arrived earlier still
  (18.1 s and 75.1 s at four servers / three callers).

  The load hypothesis `CONTRIBUTING.md` → *Infra-signature exemption* predicts is
  therefore **confirmed**, and the spec was a contributor on three counts: it
  polled the expensive variant itself every 3 s; the page it had open polls the
  same endpoint independently (`useGetMCPServers` issues both
  `?action_count=false` and `?action_count=true` — read from the
  `1.12.0.dev39` bundle), so two concurrent callers were structural; and the
  daily runs `workers: 2` per shard over ten `@stable` MCP files sharing one
  Langflow, four of which drive `action_count`.

  The fix is the one the family sibling already shipped —
  `mcp-client-agent-gemini-tool-regression.spec.ts` carries this exact remedy,
  and is the *other* spec that showed a transport-level signature on 2026-07-30.
  It was never replicated here. `waitForMcpToolsCount` now owns it for the area:
  an explicit per-request timeout so the probe cannot inherit `actionTimeout`, a
  failed probe recorded and returned as "not ready yet", and the last probe
  failure printed when the budget does run out (#1012) — the difference between
  "the server never started" and "every probe timed out" is the whole diagnosis.
  **The assertion is unchanged**: a server that never reports a tool count still
  fails the test, now naming why.

  What this does NOT claim to fix is the endpoint. A page that keeps a slow
  `action_count=true` in flight is Langflow's own behaviour, and at six
  concurrent callers the run above left `lf-starter_project` answering
  `Error loading server: Connection closed` and never recovering. That belongs
  upstream, not in a wait strategy.

- **#1447 — the node "lost" the server its modal created because the modal was
  not the node's.** On `1.12.0.dev25` test 5 found the node back on
  `lf-starter_project` after creating `test_server_26480` (1 of 4 full-file runs,
  0 of 6 alone), its tool list correct for that project and no error anywhere;
  #1422 worked around it by selecting the server explicitly. The auto-binding is
  an explicit product contract — `McpComponent` passes `handleSuccess` to
  `AddMcpServerModal` as `onSuccess`, and `handleSuccess` sets the node's
  `mcp_server` to the created name — so the question was what undid it.
  **Not the stale refresh it looks like.** Adding the starter component fires a
  mount refresh (`POST /api/v1/custom_component/update`, `mcp_server=lf-starter_project`)
  that answers slowly — 22.98 s in a plain run on `1.13.0.dev30`, *after* the new
  server's own update (22.29 s) — and the binding held. Forcing the other two
  orderings with a routed delay changed nothing either: the stale response landing
  **between** the binding and the new server's response (6.96 s vs 33.0 s) and
  landing **last** (46.7 s) both left the node on the new server, on `1.13.0.dev30`
  and — for the in-between case — on `langflowai/langflow:1.12.0`, which predates
  `keepUserEdits` (upstream #14741). Which guard absorbs the stale response on
  each build was not isolated — the outcome was measured, and the outcome is what
  test 5 asserts.
  **The helper opened the sidebar's modal.** `openAddMcpServerModal` clicked
  `mcp-server-dropdown` and then `getByText("Add MCP Server", { exact: true }).last()`.
  Measured on `1.13.0.dev30` with the MCP sidebar tab open, that text has exactly
  **one** match before the list dialog renders — `sidebar-add-mcp-server-button`
  — and two after, the dialog's footer button being the last. So a dropdown click
  that did not open the dialog fell through to the sidebar button: swallowing that
  click once (a capture-phase listener) made the helper open the sidebar's modal
  (one dialog open, no server list), the server was created, and the node stayed on
  `lf-starter_project` with that project's tool list and no error — the dev25
  symptom exactly. Dropped clicks on this node's controls are a measured class
  here (#1304/#1335, and the `mcp-server-dropdown` flake noted below), and they
  concentrate under load, which is why only the full-file run hit it. The helper
  now scopes the click to the dialog and re-clicks the dropdown when the dialog
  does not open, and test 5 asserts the binding instead of performing it. Nothing
  was filed upstream: the product binds correctly; the test opened the wrong modal.
  **One product fragility measured on the way, recorded and not asserted.**
  `McpComponent`'s `[name, options]` effect resets `mcp_server` to empty whenever
  the server list it holds lacks the bound name. Answering the first post-create
  `GET /api/v2/mcp/servers?action_count=false` with the new server removed (a
  routed response) left the node on `Select a server...` on both `1.13.0.dev30` and
  `1.12.0`. The only natural trigger this repo has measured for such a list is a
  write answering 2xx before its commit, fixed upstream before `1.13.0.dev14`; a
  list that legitimately lacks the name is the reset doing its job. It is a
  different symptom from #1447's and is not what dev25 recorded.
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
