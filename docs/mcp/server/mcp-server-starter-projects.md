# MCP Server — starter projects & project folder CRUD (UI)

**Last validated:** Langflow 1.12.x

---

## What this test validates *(required)*

Covers the QA-CHECKLIST §14.1 item **"Starter project with MCP"** — every
Langflow project is exposed as an MCP server on the Settings → MCP Servers page,
and the default project ships as `lf-starter_project`. Two `test()` cases:

1. **Starter projects appear as MCP servers, and reflect project folder CRUD.**
   The default project `lf-starter_project` is listed on the MCP Servers settings
   page. Adding two projects lists them as `lf-new_project` / `lf-new_project_1`;
   renaming a project renames its MCP server (`lf-renamed_project`); deleting the
   project removes its MCP server — each verified back on the MCP Servers page.
2. **Duplicate MCP servers are rejected.** Copying a project's own MCP client
   config and re-adding it via the Add-MCP-Server modal on the settings page
   returns exactly one "Server already exists." error.

If this fails, projects are no longer surfaced as MCP servers (or their lifecycle
is out of sync with the project folder), or the duplicate-server guard is gone.

---

## Tags *(required)*

`@release` `@workspace` `@components` `@mcp` `@stable` (both tests)

- `@stable` — promoted under #948 after repeated clean `--workers=1 --retries=0`
  runs on nightly 1.12.0.dev4 and a per-test force-failure check.
- `@workspace` — project/folder management; `@components`/`@mcp` — MCP servers
  settings; `@release` — happy-path MCP-server surfacing.

---

## Preconditions *(optional)*

- Langflow running at `PLAYWRIGHT_BASE_URL`; auto-login superuser.
- Default MCP starter project `lf-starter_project` present.
- No LLM / provider key required.
- Test 2 uses the clipboard (copy the config, paste into the modal).

---

## Step by step *(required)*

**Test 1 — starter projects & folder CRUD**

1. Bootstrap (skip modal); `cleanOldFolders` to start from a known project set.
2. Settings → **MCP Servers**: assert `mcp_server_name_0` contains
   `lf-starter_project`.
3. Add two projects (`add-project-button` ×2); back on MCP Servers, assert
   `lf-starter_project` still first, and `lf-new_project` / `lf-new_project_1`
   each appear exactly once.
4. **Rename** the first "New Project" folder to `renamed_project`; on MCP Servers
   assert `lf-renamed_project` appears exactly once (and starter still first).
5. **Delete** the renamed project; on MCP Servers assert `lf-renamed_project`
   count is 0 (and starter still first).

**Test 2 — duplicate MCP server rejected**

1. Bootstrap; open the **Basic Prompting** template; exit to the flow list.
2. Open the flow's MCP tab, switch to JSON, copy the config.
3. Settings → MCP Servers → **Add MCP Server** (`add-mcp-server-button-page`),
   paste the config, submit (`add-mcp-server-button`).
4. Assert "Server already exists." is visible and its count is exactly 1.

---

## Validation criterion *(required)*

- **Test 1:** the MCP Servers page mirrors project-folder state at each step —
  `lf-starter_project` always first; added projects appear by name (count 1);
  a renamed project's server appears as `lf-renamed_project`; a deleted project's
  server disappears (count 0).
- **Test 2:** re-adding an already-registered server surfaces exactly one
  "Server already exists." error (no silent success, no duplicate rows).

## Guarding against false positives *(how)*

- **Exact-name counts** (`.count()` === 1 / === 0 on `getByText(..., {exact:true})`)
  instead of "visible", so a stale or partially-matching row cannot pass.
- **Ordering assert** (`mcp_server_name_0` first) re-checked after every mutation.
- **`cleanOldFolders`** normalizes the starting project set so the add/rename/
  delete counts are deterministic.
- **Force-failure check** (CONTRIBUTING §2) run during VERIFY on the name/count
  assertions of each test.

---

## What this test does not cover *(optional)*

- MCP tool **selection/config** in the flow tab — `mcp-server-tab.spec.ts`.
- MCP-server tool **execution** / **resources** over the protocol —
  `mcp-server-protocol.spec.ts` / `mcp-server-resources.spec.ts`.
- The client-side add-server field persistence — `mcp-server.spec.ts`.

---

## External dependencies *(required)*

- Settings → MCP Servers page (`mcp_server_name_0`, `add-mcp-server-button-page`,
  `add-mcp-server-button`, `json-input`) via `helpers/ui/go-to-settings.ts`
  (`navigateSettingsPages`).
- Project folder CRUD (`add-project-button`, `more-options-button_<name>`,
  Rename/Delete, `input-project`, `sidebar-nav-<name>`).
- `helpers/filesystem/clean-old-folders.ts`, `helpers/filesystem/convert-test-name.ts`,
  `helpers/other/await-bootstrap-test.ts`.
- Basic Prompting template + the flow MCP tab (Test 2).

---

## When to review this test *(optional)*

- If projects stop mapping 1:1 to MCP servers, or the `lf-` server-name prefix
  changes.
- If the MCP Servers settings page testids or the add-server modal change.
- If the duplicate-server error copy ("Server already exists.") changes.

---

## Notes *(optional)*

- Test 1 mutates project folders; `cleanOldFolders` in setup keeps the counts
  deterministic across reruns. Runs `--workers=1` in CI (shared project state).
- No standalone flows are created that need id-scoped cleanup — the artifacts are
  **projects/folders**, created and then renamed/deleted within the test; the
  duplicate-server test adds a server registration, not a flow.
- **Ambient backend 500 (logged, not failing):** on the MCP Servers settings
  page the browser session fires `GET /api/v2/mcp/servers/lf-starter_project`,
  which returns 500 (`InvalidSignatureError: Signature verification failed`) in
  the auto-login session context — a fresh-token `curl` to the same endpoint
  returns 200. The fixture logs this as a `🚨 Backend Error` but does **not**
  fail the test (only `flow_error` fails; `http_error` is log-only). The test's
  assertions do not depend on that call. Import switched to `fixtures/fixtures.ts`
  under #948 to gain this monitoring; the 500 is peripheral/pre-existing.
