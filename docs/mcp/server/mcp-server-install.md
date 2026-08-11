# MCP Server — installing a project into an MCP client: reported state, the composer URL, and what the UI hands the user

**Last validated:** Langflow 1.12.x (nightly `1.12.0.dev20`)

---

## What this test validates *(required)*

The **consumption** side of a project's MCP server (QA-CHECKLIST §14.1): how a user
actually connects a client to it.

1. **The connection URL the API publishes is a real endpoint.**
   `GET /api/v1/mcp/project/{id}/composer-url` returns the project's streamable and
   legacy-SSE URLs, and the streamable one answers a real MCP `initialize` identifying
   **that** project — "resolves" asserted against the protocol, not against a 200.
2. **The UI hands the user the same value.** The MCP Server tab's JSON configuration —
   the thing the copy button puts on the clipboard — carries the *identical* URL
   string, not a re-derived or stale one.
3. **The installed state is reported per client, and the UI reflects it.**
   `GET /api/v1/mcp/project/{id}/installed` reports `installed`/`available` for Cursor,
   Windsurf and Claude, and each auto-install button's enabled state matches the answer
   **the page itself received** — the response is captured from the page's own request,
   so the two cannot be read from different states.

If this fails, the advertised path for consuming an MCP server is broken: the URL the
UI copies no longer matches the one the API publishes, the published URL is not a live
endpoint, or the install list shows a state the backend did not report.

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

- Langflow running at `PLAYWRIGHT_BASE_URL`; auto-login superuser.
- At least one project exists (the default `Starter Project` satisfies this).
- Clipboard read/write permission — already granted to every context by
  `playwright.config.ts`.
- No project or flow is created, so there is nothing to clean up.

---

## Step by step *(required)*

A file-local helper opens the MCP Server tab from the home page (`mcp-btn` →
`mcp-server-title`) **while capturing the `GET …/installed` response the page itself
issues**, and returns that project id together with the parsed body. Both tests start
from it, so neither depends on the other and neither assumes which project the UI
selects by default.

### 1 — `the composer URL resolves, and the JSON the UI copies carries the same value`

1. Open the tab; take the project id from the page's own request.
2. `GET /api/v1/mcp/project/{id}/composer-url`: assert 200, `uses_composer: false`,
   `error_message: null`, and that `streamable_http_url` / `legacy_sse_url` end in this
   project's `/streamable` and `/sse` paths.
3. **Resolve it:** run the MCP handshake against the returned **absolute**
   `streamable_http_url` and assert `serverInfo.name === langflow-mcp-project-{id}`.
   A URL that 200s but belongs to another project would pass a status check.
4. Switch to the **JSON** tab, click `icon-copy`, and wait for it to become
   `icon-check` (the control's own confirmation).
5. Read the clipboard, parse it as JSON, and assert it declares exactly one server
   under `mcpServers` whose `args` **contain the composer URL verbatim**.

### 2 — `installed state is reported per client and the auto-install list reflects it`

1. Open the tab, capturing the `installed` response.
2. Assert the API reports exactly the three supported clients — `cursor`, `windsurf`,
   `claude` — each with boolean `installed` and `available`.
3. Read the page's own locality rule (`window.location.hostname` against
   `localhost`/`127.0.0.1`/`0.0.0.0`, which is what
   `useCustomIsLocalConnection` uses).
4. For each of **Cursor**, **Claude** and **Windsurf**, assert the button's disabled
   state equals `!available || !isLocalConnection` — the product's own rule, so the
   assertion holds on any base URL and in any environment rather than hard-coding
   "disabled".

---

## Validation criterion *(required)*

- `composer-url` answers with both transport URLs for the project the UI is showing,
  and the streamable one completes an MCP `initialize` whose `serverInfo.name` names
  that same project.
- The clipboard JSON's `args` contain the composer URL **string for string**. A UI that
  rebuilt the URL from its own state — or served a cached one after a host change —
  fails here even though both would still "look" correct.
- `installed` reports all three supported clients with both booleans, and every
  auto-install button agrees with the response the page received.

## Guarding against false positives *(how)*

- **The project id comes from the page's own request**, never from
  `GET /api/v1/projects/` ordering. Under `fullyParallel` other specs create projects,
  so "the first project" and "the project the UI is showing" are not the same thing —
  and a test that read them separately could compare two different projects and still
  pass.
- **The `installed` body is the one the page received**, captured from its request
  rather than fetched again afterwards. A second fetch could observe a different state
  and turn a genuine UI/API disagreement into a green run.
- **The URL is asserted by resolving it**, not by pattern-matching. Asserting
  `toContain("/streamable")` would pass against a URL pointing at another project or a
  dead host.
- **The clipboard comparison is exact.** `toContain(projectId)` would pass on a URL
  with the wrong scheme, host or transport.
- **The disabled-state assertion mirrors the product rule** rather than the current
  environment, so it cannot silently degrade into "everything is disabled here anyway".
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
  Covering it needs an environment that is disposable **and** originates the call from
  inside the container — a dedicated lane, not this spec. The §14.1 bullet is therefore
  marked `[~]` rather than `[x]`, and this is the gap.
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
  (#1396) and `mcp-server-protocol.spec.ts`.

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
- **Read-only by construction.** Both tests only read; they create no project and no
  flow, which is why there is no `afterEach` and why they are safe to run against a
  shared instance at any concurrency.
- **The tab reaches `GET /api/v1/mcp/project/{id}?mcp_enabled=false`** to list the
  project's flows — the unfiltered listing, which is the semantics
  `mcp-server-project-config.md` records: that parameter removes the
  `mcp_enabled = true` filter rather than inverting it.
