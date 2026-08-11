# MCP Server — installing a project into an MCP client: reported state, the composer URL, and what the UI hands the user

**Last validated:** Langflow 1.12.x (nightly `1.12.0.dev20`)

---

## What this test validates *(required)*

The **consumption** side of a project's MCP server (QA-CHECKLIST §14.1): how a user
actually connects a client to it.

1. **The URL the UI hands the user is rooted at the origin they are browsing.** The
   MCP Server tab's JSON configuration — what the copy button puts on the clipboard —
   carries a connection URL built from `window.location.origin`, so someone copying
   from a remote Langflow gets a URL pointing at that remote rather than at the
   server's own idea of its hostname.
2. **The UI and the API agree on the path**, and **the copied URL is a live endpoint.**
   `GET /api/v1/mcp/project/{id}/composer-url` publishes the project's streamable and
   legacy-SSE paths; the copied URL's path is the streamable one, and running an MCP
   `initialize` **against the copied string** identifies that same project — "resolves"
   asserted against the protocol, on the value a user would actually paste.
3. **The installed state is reported per client, and the auto-install list reflects
   it.** `GET /api/v1/mcp/project/{id}/installed` reports `installed`/`available` for
   Cursor, Windsurf and Claude, and each button's enabled state matches the answer
   **the page itself received** — captured from the page's own request, so the two
   cannot be read from different states. A third test routes one client to
   `available: true`, because in every environment the suite runs in all three are
   false and the correspondence would otherwise be indistinguishable from a constant.

If this fails, the advertised path for consuming an MCP server is broken: the UI hands
out a URL that does not resolve for the user who copied it, the two sides disagree
about which endpoint the project is served on, or the install list shows a state the
backend did not report.

### The mechanism — the obvious reading is wrong, and it decides what may be asserted

**The MCP Server tab never fetches `composer-url`.** That query is gated on an OAuth
project with MCP Composer enabled (`useMcpServer.ts`), which the default deployment is
not; the tab's only MCP calls are `GET /{id}?mcp_enabled=false` and `GET /{id}/installed`
(measured). So the two URLs are **independent derivations of the same address**: the
backend builds `http://{settings.host}:{port}/…`
(`api/utils/mcp/config_utils.py`), the frontend builds `${window.location.origin}/…`
(`customization/utils/custom-mcp-url.ts`).

Nothing propagates from one to the other. Asserting the two absolute URLs are the same
**string** therefore asserts a coincidence of deployment, not a product property: the
first version of this spec did exactly that and **failed on a healthy instance merely
reached as `127.0.0.1` instead of `localhost`** — a red that would have looked like a
product defect, on `manual.yml`'s external-URL job in particular. What is invariant is
one property from each side: the UI's origin rule, and agreement on the path.

---

## Tags *(required)*

`@stable` `@api` `@mcp`

- `@stable` — read-only: it creates nothing, mutates nothing, and needs no LLM key,
  no npm registry and no external MCP server. Validated per `CONTRIBUTING.md`.
- `@api` — the assertions are about `composer-url` and `installed`; the UI is the
  second half of each round trip.
- `@mcp` — the MCP server area (`tests/.../mcp/`, area-local `CLAUDE.md`).
- **No `@regression`** — that tag means "test for a previously fixed bug"
  (`CLAUDE.md`); this is new coverage of a path with no bug history.

---

## Preconditions *(optional)*

- Langflow running at `PLAYWRIGHT_BASE_URL`; auto-login superuser. **Any** base URL
  works — the spec deliberately does not require it to match the backend's configured
  `host:port` (see *The mechanism*); verified green against both
  `http://localhost:7860/` and `http://127.0.0.1:7860/`.
- At least one project exists (the default `Starter Project` satisfies this).
- Clipboard read/write permission — already granted to every context by
  `playwright.config.ts`.
- **Content on the home page.** The MCP Server tab only exists once the home page
  has some; on an instance where the user created nothing it renders the empty state
  (`new_project_btn_empty_page`) and `mcp-btn` is absent. The starter examples do
  **not** satisfy it — a disposable container reported 26 flows over the API and still
  rendered the empty page (measured). The entry therefore goes through
  `awaitBootstrapTest`, which creates one flow in that case; any flow it causes is
  deleted id-scoped in `afterEach`.

---

## Step by step *(required)*

A file-local helper enters through `awaitBootstrapTest` (which lands on a home page
with content, creating a flow only if it finds the empty state, and carries the
attributed page-entry barrier of #1262), opens the MCP Server tab (`mcp-btn` →
`mcp-server-title`) **while capturing the `GET …/installed` response the page itself
issues**, and returns that project id together with the parsed body. All three tests start
from it, so neither depends on the other and neither assumes which project the UI
selects by default.

### 1 — `the URL the UI copies is rooted at the user's own origin, agrees with the API, and resolves`

1. Open the tab; take the project id from the page's own request.
2. `GET /api/v1/mcp/project/{id}/composer-url`: assert 200, `uses_composer: false`,
   `error_message: null`, and that the **pathnames** of `streamable_http_url` and
   `legacy_sse_url` are this project's `/streamable` and `/sse`. Paths, not absolute
   URLs — the origin is the backend's own `settings.host:port` (see *The mechanism*).
3. Switch to the **JSON** tab, click `icon-copy`, and poll the clipboard until it is
   non-empty. Parse it; assert exactly one server under `mcpServers` and exactly one
   `http` argument, and take that as the copied URL.
4. Assert the copied URL's **origin** equals the page's own origin — the frontend's
   rule, and the property that makes the URL usable by whoever copied it.
5. Assert the copied URL's **path** equals the path the API published: the two
   independent derivations agree on where the project is served.
6. **Resolve it:** run the MCP handshake **against the copied URL** and assert
   `serverInfo.name === langflow-mcp-project-{id}`. Reachable by construction, since
   its origin is the page's own.

### 2 — `the auto-install list reflects the install state the page was given`

1. Open the tab, capturing the `installed` response.
2. Assert the API reports exactly the three supported clients — `cursor`, `windsurf`,
   `claude` — each with boolean `installed` and `available`.
3. For each of **Cursor**, **Claude** and **Windsurf**, assert (polled) that the
   button's disabled state equals `!available || !isLocalConnection`, with locality
   read from the page exactly as `useCustomIsLocalConnection` computes it.

### 3 — `a client reported as available is offered, while the others stay disabled`

1. Route `GET …/installed` to report `cursor` as `available: true` and the other two
   as false, then open the tab.
2. Assert the page received the routed state — otherwise this test silently becomes a
   copy of test 2.
3. Assert the same correspondence as test 2, which now separates "reflects the API"
   from "always disabled": **Cursor enabled, Claude and Windsurf disabled**.

The button is only asserted to be offered. It is never clicked — that would
`POST /install`, which writes real MCP client configuration.

---

## Validation criterion *(required)*

- `composer-url` answers 200 with `uses_composer: false`, no error message, and both
  transport **paths** for the project the UI is showing.
- The copied configuration carries exactly one connection URL; its **origin** is the
  page's own, and its **path** is the streamable path the API published.
- That copied URL completes an MCP `initialize` whose `serverInfo.name` names the same
  project — so the string the user pastes is a live endpoint, not just well-formed.
- `installed` reports all three supported clients with both booleans, every
  auto-install button agrees with the response the page received, and a client routed
  to `available: true` is **offered** while the other two stay disabled.

## Guarding against false positives *(how)*

- **The project id comes from the page's own request**, never from
  `GET /api/v1/projects/` ordering. Under `fullyParallel` other specs create projects,
  so "the first project" and "the project the UI is showing" are not the same thing —
  and a test that read them separately could compare two different projects and still
  pass.
- **The `installed` body is the one the page received**, captured from its request
  rather than fetched again afterwards. A second fetch could observe a different state
  and turn a genuine UI/API disagreement into a green run.
- **The URL is asserted by resolving it**, not by pattern-matching, and by resolving
  the **copied** one — the string a user pastes — rather than one the test rebuilt.
- **The path comparison is exact** (`toBe`, whole pathname). `toContain(projectId)`
  would pass on a URL with the wrong transport, and comparing the whole absolute URL
  would fail on a healthy instance reached by a different name (see *The mechanism*).
- **The disabled-state correspondence is given discriminating power by a routed
  test.** Mirroring the product rule is not enough on its own: with all three clients
  unavailable in every lane, the rule evaluates to a constant, and a mutation replacing
  it with a hardcoded `true` survives. With one client routed to `available: true` that
  mutation fails — verified.
- **The clipboard is polled, not gated on the `icon-check` confirmation**, which
  resets after 1 s and would make a successful copy fail whenever the first sample
  lands late.
- **The page entry is attributed** (via `awaitBootstrapTest`'s own barrier, #1262): on
  a wedged backend the failure names the backend instead of reading as a UI defect.
- **The entry is exercised on an instance that has never been used.** The first version
  of this spec was read-only and entered with a bare wait on `mcp-btn`; it passed on a
  developer box full of leftovers and failed all three tests in CI, where the home page
  renders the empty state. Every change here is now validated against a disposable
  container as well as the local one.
- **Force-failure check** (CONTRIBUTING §2) executed per assertion during VERIFY.

---

## What this test does not cover *(optional)*

- **`POST /{project_id}/install` — the write itself, deliberately.** Two independent
  reasons, both measured on `1.12.0.dev20`:
  1. **It writes to the filesystem of whichever machine runs Langflow.** The endpoint
     edits the real MCP client configuration — `~/.cursor/mcp.json`,
     `~/.codeium/windsurf/mcp_config.json`, Claude's `claude_desktop_config.json`. Run
     against a local `start-langflow-pip.sh` instance, a spec that exercised it would
     rewrite the **developer's own** editor configuration. A regression test must not
     do that, and no assertion is worth it.
  2. **It is unreachable from every lane this suite runs in anyway.**
     `install_mcp_config` refuses any caller whose TCP peer is not a loopback address
     (`is_local_ip` → `ip.is_loopback`; `get_client_ip` deliberately ignores
     `X-Forwarded-For` unless a trusted proxy is configured). Langflow runs as a
     container in every lane, so the peer is the bridge gateway and the call answers
     `500 "MCP configuration can only be installed from a local connection"`. Measured
     against the local nightly container.
  Covering the **write** needs an environment that is disposable **and** originates the
  call from inside the container — a dedicated lane, not this spec. The §14.1 bullet is
  therefore marked `[~]` rather than `[x]`, and this is the gap.

  **There is, however, a write-safe half worth a follow-up.** `install_mcp_config`
  rejects an unavailable client with `400 "<Client> is not installed on this system"`
  **before** `config_path.parent.mkdir()` and before the write
  (`mcp_projects.py`) — so for a client that `GET /installed` reports as
  `available: false`, the POST provably cannot touch the filesystem on any machine. A
  spec that reads `installed`, skips loudly if any client reports `available: true`,
  then POSTs and asserts the refusal would exercise the endpoint's guard rails —
  including the **locality guard**, which `get_client_ip`'s own docstring frames as an
  anti-spoofing control and which nothing regression-tests today. It is still not
  "performs the install", and the skip reason must be asserted (#570's green-all-skip),
  so it belongs in its own issue rather than here.
- **The auto-install click path**, for the same reason — and in every environment the
  suite runs in the buttons are disabled, because no client's config directory exists
  inside the container.
- **MCP Composer** (`uses_composer: true`, OAuth projects) — the composer service is
  disabled by default; this spec asserts the non-composer branch, which is what the
  default deployment serves.
- **The JSON tab's API-key generation and the OS variants** (`macOS/Linux` vs
  `Windows`) — covered by `mcp-server-tab.spec.ts`, which asserts the copied config's
  shape (`mcpServers`, `uvx`, `mcp-proxy`) and the key substitution. This spec asserts
  the one thing that spec does not: that the copied URL **equals** the API's.
- **Tool selection and the protocol itself** — `mcp-server-project-config.spec.ts`
  (#1396) and `mcp-server-protocol.spec.ts`. That spec also asserts `composer-url`'s
  shape and a `serverInfo.name`; the overlap is deliberate and minimal — here those two
  are the **precondition** for the path-agreement and the copied-URL handshake, which
  is what this spec is actually about. The URL it hands to the handshake is the one the
  UI copied, not one the test built.

---

## External dependencies *(required)*

- `src/backend/base/langflow/api/v1/mcp_projects.py` — `get_project_composer_url`
  (the non-composer branch that returns both URLs and a null `error_message`),
  `check_installed_mcp_servers` (the per-client `installed`/`available` report and the
  `cursor`/`windsurf`/`claude` list), `get_config_path` (where "available" is decided),
  and `install_mcp_config` + `is_local_ip` / `get_client_ip` (the local-only guard this
  spec documents rather than exercises).
- `src/frontend/src/customization/hooks/use-custom-is-local-connection.ts` — the
  `window.location.hostname ∈ {localhost, 127.0.0.1, 0.0.0.0}` rule test 2 mirrors.
- `src/frontend/src/pages/MainPage/pages/homePage/components/McpAutoInstallContent.tsx`
  — the auto-install buttons and their `disabled` condition; the client titles
  (`Cursor`, `Claude`, `Windsurf`) are the accessible names this spec locates by, since
  the buttons carry no `data-testid`.
- `src/frontend/src/pages/MainPage/pages/homePage/components/McpJsonContent.tsx` and
  `hooks/useMcpServer.ts` — the JSON configuration and the copy control.
- `tests/helpers/mcp/mcp-streamable-client.ts` (`mcpHandshake`),
  `tests/helpers/auth/get-auth-token.ts`.
- UI testids: `mcp-btn`, `mcp-server-title`, `icon-copy`, `icon-check`.

---

## When to review this test *(optional)*

- If `composer-url` changes shape, or the default deployment starts routing through MCP
  Composer (`uses_composer: true`), which changes which URLs are returned.
- If the supported client list changes — `check_installed_mcp_servers` hardcodes
  `["cursor", "windsurf", "claude"]` and the UI renders `autoInstallers`; the two must
  keep agreeing.
- If the auto-install buttons gain `data-testid`s (then locate by them instead of by
  accessible name), or the copy control stops swapping `icon-copy` → `icon-check`.
- If `is_local_ip` is relaxed or `install_mcp_config` gains a dry-run mode — either
  would make the uncovered half testable, and the `[~]` bullet could be promoted.

---

## Notes *(optional)*

- **The frontend and the backend disagree about what "local" means, and the UI is the
  optimistic one.** The frontend calls a connection local when the **browser's**
  hostname is `localhost`/`127.0.0.1`/`0.0.0.0`; the backend requires the **TCP peer**
  to be a loopback address. For the common Docker deployment — Langflow in a container,
  browser on the same laptop at `http://localhost:7860` — the frontend says local and
  the backend does not. The auto-install buttons are nevertheless disabled there, but
  for the *other* reason (`available: false`, since no client config directory exists
  inside the container), so the disagreement stays hidden. It becomes visible on a host
  where a client's directory is mounted or present: the UI would enable the button and
  the click would answer 500. Not asserted here — the spec pins the product's own rule,
  which both branches satisfy today — but worth knowing before reading a 500 from this
  endpoint as a new regression.
- **Not read-only, and the earlier claim that it was is what broke it in CI.** The
  tests themselves only read, but the *entry* cannot: a home page with no content has
  no MCP Server tab at all. `awaitBootstrapTest` creates a single flow in that case and
  `afterEach` deletes it id-scoped (pattern A — ids from the `POST /api/v1/flows` 201
  responses, never the canvas URL, #681). On an instance that already has content
  nothing is created and nothing is deleted.
- **The tab reaches `GET /api/v1/mcp/project/{id}?mcp_enabled=false`** to list the
  project's flows — the unfiltered listing, which is the semantics
  `mcp-server-project-config.md` records: that parameter removes the
  `mcp_enabled = true` filter rather than inverting it.
