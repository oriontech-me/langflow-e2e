# MCP Server — starter projects & project folder CRUD (UI)

**Last validated:** Langflow 1.13.x (nightly `1.13.0.dev27`)

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
  runs on nightly 1.12.0.dev4 and a per-test force-failure check. Auto-removed
  from test 1 by the daily workflow on 2026-07-30 and restored under #1123 after
  the positional-addressing fix (see **Notes**). Test 1 was quarantined again on
  2026-09-29 (`@stable` removed **and** `test.fixme` added, PR #2100) as a
  recurrent first-attempt flake, and restored under #2096 once the rename and
  delete steps synchronized on their own writes (see **Notes**).
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

1. Bootstrap (skip modal); `cleanOldFolders` to start from a known project set,
   then delete any leftover `renamed_project` via the API — see **Notes**.
2. Settings → **MCP Servers**: assert exactly one server row is named
   `lf-starter_project`, addressed **by name** (`mcp_server_name_<index>` filtered
   on the exact name) rather than by position — see **Notes**.
3. Add two projects (`add-project-button` ×2); back on MCP Servers, assert
   `lf-starter_project` is still listed, and `lf-new_project` / `lf-new_project_1`
   each appear exactly once.
4. **Rename** the first project this test created to `renamed_project` through
   its kebab's "Rename" entry. Wait for the rename's own write —
   `PATCH /api/v1/projects/<id>` — to answer **200 with `name: renamed_project`**,
   then read the MCP server list back through the API
   (`GET /api/v2/mcp/servers`) and assert it contains `lf-renamed_project`. Only
   then open MCP Servers and assert `lf-renamed_project` appears exactly once (and
   starter still listed). See **Notes** (#2096) for why the page is opened after
   the write and never after a fixed sleep.
5. **Delete** the renamed project through its kebab; wait for
   `DELETE /api/v1/projects/<id>` to answer 2xx, read the MCP server list back
   through the API and assert `lf-renamed_project` is gone, then on MCP Servers
   assert its count is 0 (and starter still listed).

**Test 2 — duplicate MCP server rejected**

1. Bootstrap; open the **Basic Prompting** template; exit to the flow list.
2. Open the flow's MCP tab, switch to JSON, copy the config.
3. Settings → MCP Servers → **Add MCP Server** (`add-mcp-server-button-page`),
   paste the config, submit (`add-mcp-server-button`).
4. Assert "Server already exists." is visible and its count is exactly 1.

---

## Validation criterion *(required)*

- **Test 1:** the MCP Servers page mirrors project-folder state at each step —
  a server row named exactly `lf-starter_project` is present (count 1) at every
  step; added projects appear by name (count 1); a renamed project's server
  appears as `lf-renamed_project`; a deleted project's server disappears
  (count 0). **Row order is not part of the contract** — see **Notes**.
  For the rename and the delete the observable is ordered, and each layer is
  asserted on its own so a failure names the layer that broke: the write answers
  (`PATCH` 200 carrying `name: renamed_project` / `DELETE` 2xx) → the backend's
  MCP server list reflects it (`GET /api/v2/mcp/servers` has / lacks
  `lf-renamed_project`) → the MCP Servers page, mounted after both, renders
  exactly one / zero `lf-renamed_project` entries.
- **Test 2:** re-adding an already-registered server surfaces exactly one
  "Server already exists." error (no silent success, no duplicate rows).

## Guarding against false positives *(how)*

- **Exact-name counts** (`toHaveCount(1)` / `toHaveCount(0)` on
  `getByText(..., {exact:true})`) instead of "visible", so a stale or
  partially-matching row cannot pass.
- **Auto-retrying counts** — every count assertion is `await expect(...)
  .toHaveCount(n)`, never `expect(await ....count())`. The MCP-server row is
  written by the backend as a side effect of the project write and can lag the
  navigation; a single DOM read turns that lag into a failure (#1135).
- **Synchronize on the write, not on a sleep (#2096)** — the rename and the
  delete wait for their own `PATCH` / `DELETE` response before the MCP Servers
  page is opened, and the `PATCH` body's `name` is asserted, so a rename that
  committed the wrong value fails on the write rather than as a missing row. The
  API readback in between separates "the backend did not rename the server"
  from "the page did not show it". The wait is for the write's **final**
  response: a 5xx is skipped because the frontend retries it in-band
  (`withTransientErrorRetry`) and the fixture still logs it, while a 4xx is
  final and fails the status assert.
- **Starter-project presence** re-checked after every mutation, so a project
  operation that silently drops the starter project's server cannot pass.
- **Row-scoped locator** — the starter-project assert filters the
  `mcp_server_name_<index>` server rows on the exact name, so matching text
  elsewhere on the page (a heading, a tooltip, an error string) cannot satisfy it.
- **`cleanOldFolders` + leftover-`renamed_project` sweep** normalize the starting
  project set so the add/rename/delete counts are deterministic, and so a failed
  attempt cannot change what the next one measures.
- **Force-failure check** (CONTRIBUTING §2) run during VERIFY on the name/count
  assertions of each test.

---

## What this test does not cover *(optional)*

- The **row order** of the MCP Servers list, and the internal `langflow-agentic`
  server Langflow injects into every user's list (see **Notes**) — neither is part
  of the §14.1 contract, so neither is asserted.
- MCP tool **selection/config** in the flow tab — `mcp-server-tab.spec.ts`.
- MCP-server tool **execution** / **resources** over the protocol —
  `mcp-server-protocol.spec.ts` / `mcp-server-resources.spec.ts`.
- The client-side add-server field persistence — `mcp-server.spec.ts`.

---

## External dependencies *(required)*

- Settings → MCP Servers page (`mcp_server_name_<index>`, `add-mcp-server-button-page`,
  `add-mcp-server-button`, `json-input`) via `helpers/ui/go-to-settings.ts`
  (`navigateSettingsPages`).
- `PATCH` / `DELETE /api/v1/projects/{id}` (the rename and delete writes) and
  `GET /api/v2/mcp/servers` (the API readback). The rename's MCP side effect is
  `handle_mcp_server_rename` in
  `src/backend/base/langflow/api/v1/projects_mcp_helpers.py`, awaited inside the
  `PATCH`; the page's list query is `useGetMCPServers` in
  `src/frontend/src/controllers/API/queries/mcp/use-get-mcp-servers.ts`, and the
  rename mutation is `usePatchFolders` in
  `src/frontend/src/controllers/API/queries/folders/use-patch-folders.ts`.
- Project folder CRUD (`add-project-button`, Rename/Delete, `input-project`, and
  the project entry plus its kebab — addressed through
  `helpers/ui/project-sidebar.ts`, which matches the id-derived testids of the
  nightly and the name-derived ones of `main` / `1.11.x`, #1363).
- `helpers/filesystem/clean-old-folders.ts`, `helpers/filesystem/convert-test-name.ts`,
  `helpers/other/await-bootstrap-test.ts`.
- Basic Prompting template + the flow MCP tab (Test 2).

---

## When to review this test *(optional)*

- If projects stop mapping 1:1 to MCP servers, or the `lf-` server-name prefix
  changes.
- If Langflow starts **sorting** the MCP Servers list, or stops injecting
  `langflow-agentic` (i.e. `agentic_experience` defaults back to off) — either
  would change what row order means, though this test no longer depends on it.
- If the MCP Servers settings page testids or the add-server modal change.
- If the duplicate-server error copy ("Server already exists.") changes.

---

## Notes *(optional)*

- **Row position is deliberately NOT asserted (#1123).** Test 1 originally read
  `mcp_server_name_0` and expected the starter project. Langflow upstream enabled
  the agentic experience by default (`agentic_experience: bool = True`, langflow
  commit `d4d5592c1c` / langflow#14244, 2026-07-24), and with that flag on,
  `auto_configure_agentic_mcp_server()` injects an internal server named
  `langflow-agentic` into **every** user's MCP configuration at startup. Measured
  on the nightly line, that row is created ~10 s **before** the starter project's
  server, and `GET /api/v2/mcp/servers` orders by `created_at` while the page
  renders that order with no sort — so `langflow-agentic` is permanently row 0 and
  the positional assert failed deterministically. The starter project itself was
  **not** renamed or dropped (`lf-starter_project` is still listed, at index 1),
  so the §14.1 premise is intact and the fix is to address the row by name.
  `cleanOldFolders` cannot and should not remove `langflow-agentic` — it deletes
  *projects*, and this is an internal server (`langflow_internal: True`), not a
  project-derived one.
- Test 1 mutates project folders; `cleanOldFolders` in setup keeps the counts
  deterministic across reruns. It shares the superuser account with everything
  else in the run — CI runs `workers: 2` (`playwright.config.ts`), and nothing
  pins this file to serial, so the counts must tolerate concurrent flow/project
  activity. They do, because every one of them is scoped to a name this spec
  owns (`lf-new_project*`, `lf-renamed_project`, `lf-starter_project`).
- **Leftover `renamed_project` is swept in setup (#1135).** `cleanOldFolders`
  only deletes folders named "New Project*", so an attempt that dies between the
  rename (step 4) and the delete (step 5) leaves `renamed_project` on the
  account. The next attempt's rename then hits `UNIQUE constraint failed:
  folder.user_id, folder.name` → **500**, and fails for a reason the first
  attempt never had — retries stop being independent evidence. Setup now deletes
  any leftover by id via `deleteProject` before the rename. The sweep is in
  *setup*, not teardown, so it also heals a run that was killed outright.
- **Why the rename step waits for its `PATCH` (#2096).** Test 1 flaked on the
  first attempt on dailies 2026-09-03 (Actions) and 2026-09-29 (VM lane), both
  times at the `lf-renamed_project` count (received 0, 9 polls in 5 s) with
  `lf-starter_project` found on the line before and no backend error logged. The
  step used to press Enter, sleep a fixed `waitForTimeout(1000)`, and open MCP
  Servers — so the page's list request raced the rename's write. The rename
  renames the MCP server synchronously inside the `PATCH`
  (`handle_mcp_server_rename`: delete the old row, create the new one, each
  committed), so a list read served before that `PATCH` finishes still carries
  `lf-new_project`. Nothing re-reads it afterwards: `useGetMCPServers` refetches
  only on mount, the rename mutation's `onSettled` invalidates `useGetFolders`
  and `useGetFlowsMCP` but **not** `useGetMCPServers`, and the slower
  `action_count=true` fetch is merged with `mergeMCPServerCounts`, which maps
  over the rows already cached and so cannot add a new one. A list fetched
  early therefore stays stale until the page is re-mounted, which is also why a
  longer `toHaveCount` budget would not help. The delete step had the same fixed
  sleep in front of the same page, so it waits for its own `DELETE` too.
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
- **Test 2's duplicate-add answers 409, and that is declared (#2096).** On the
  1.12 line under #1123 the rejection answered **500** with
  `{"detail":"Server already exists."}` — the status-code defect #991 tracked.
  #991 is closed and on `1.13.0.dev27` the same request answers **409**, which the
  fixture logged as a `🚨 Backend Error` on every run although it is the very
  rejection the test provokes. It is now declared with
  `page.expectKnownHttpError({ pathname: "/api/v2/mcp/servers/lf-starter_project",
  status: 409 })`, so it prints as `📌 Known backend defect` instead of
  polluting the advisory log, and the declaration is verified in both directions:
  a duplicate-add that stops answering exactly 409 on that path fails the test.
