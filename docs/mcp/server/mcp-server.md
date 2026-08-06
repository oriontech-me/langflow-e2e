# MCP Server — add-server modal: stdio / HTTP registration, field persistence & tool refresh

**Last validated:** Langflow 1.12.x (nightly `1.12.0.dev9`)

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

If this fails, external MCP servers can no longer be registered from the UI, the
modal loses field state, the tool list serves stale data after an edit, or the
stdio input-shape validation that keeps every policy layer seeing the same argv
has been dropped.

---

## Tags *(required)*

`@release` `@workspace` `@components` `@mcp` `@stable`
(plus `@regression` on the command/args contract test)

- `@stable` — promoted under #1091 after the file was brought back to green on
  nightly `1.12.0.dev9` with repeated `--workers=1 --retries=0` runs and a
  per-test force-failure check. Before #1091 the file carried no `@stable` and
  therefore ran in **no automated lane**, which is why every stdio registration
  in it had been broken since 2026-07-15 without a single red run.
- `@regression` — on the contract test only: it guards an intentional upstream
  security change (see *External dependencies*), so a silent removal of that
  validation must fail the suite.
- `@workspace`/`@components` — drives the flow canvas, sidebar and MCPTools
  node; `@mcp` — MCP server area; `@release` — happy-path MCP registration.

---

## Preconditions *(optional)*

- Langflow running at `PLAYWRIGHT_BASE_URL`; auto-login superuser.
- The default MCP starter project exists (`lf-starter_project`).
- **Network egress to the npm registry** — the stdio tests run real MCP servers
  via `npx`. A cold container downloads the package on first use; see the
  timeout budgets below.
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
3. Assert `dropdown_str_tool` enables and exposes `sequentialthinking-0-option`;
   select it and assert the tool's own inputs render on the node
   (`anchor-popover-anchor-input-thought` and `int_int_thoughtnumber`).
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

### 6 — `Streamable HTTP MCP server with server-everything should load tools correctly`

Unchanged by #1091 (no stdio surface). Derives the project's own
`/api/v1/mcp/project/{id}/streamable` URL, registers it via the HTTP tab, polls
`toolsCount`, and asserts ≥1 tool option; cleans up via the API.

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
  after reverting, `sequentialthinking-0-option`.

## Guarding against false positives *(how)*

- **Per-run random server names** (`test_server_<5-digit>`) — no test can pass
  on a server a previous run left behind.
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
- **Force-failure check** (CONTRIBUTING §2) executed per test during VERIFY.

---

## What this test does not cover *(optional)*

- MCP **tool execution** through a registered client server — covered by
  `mcp/client/mcp-client-regression.spec.ts` and `mcp/client/mcp-client-agent.spec.ts`.
- The MCP Server **tab** on a flow (exposing a project) — `mcp-server-tab.spec.ts`.
- Protocol-level tool listing/execution — `mcp-server-protocol.spec.ts`.
- Flow-file **resources** — `mcp-server-resources.spec.ts`.
- Registration **status codes** (409/404) — `mcp/client/mcp-server-registration-status-codes.spec.ts`.
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
- `GET`/`DELETE /api/v2/mcp/servers[/{name}]`, `helpers/auth/get-auth-token.ts`,
  `helpers/other/await-bootstrap-test.ts`, `helpers/ui/adjust-screen-view.ts`,
  `helpers/ui/zoom-out.ts`, `helpers/flows/delete-flow.ts`.

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

---

## Notes *(optional)*

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
