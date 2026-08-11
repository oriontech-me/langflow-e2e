# MCP Server — per-project tool exposure (`GET`/`PATCH /{project_id}`) and what the protocol serves

**Last validated:** Langflow 1.12.x (nightly `1.12.0.dev20`)

---

## What this test validates *(required)*

The **selection surface** of a project's MCP server (QA-CHECKLIST §14.1): which of a
project's flows are exposed as MCP tools, and whether the protocol agrees with that
selection.

1. **The selection round-trips.** `PATCH /api/v1/mcp/project/{project_id}` sets a
   flow's `mcp_enabled`, `action_name` and `action_description`, and
   `GET /api/v1/mcp/project/{project_id}` reads them back — listing the **enabled**
   flows by default, and **every** flow in the project under `?mcp_enabled=false`,
   which removes the filter rather than inverting it.
2. **Selecting exposes it over the protocol, for real.** The enabled flow appears in
   `tools/list` on the project's own streamable endpoint under its `action_name`,
   described by its `action_description`, and `tools/call` actually runs it — so the
   listing is backed by a working capability, not just a string.
3. **De-selecting withdraws it from the protocol.** After `mcp_enabled: false`, the
   action is gone from `tools/list` — the assertion is made over the MCP protocol, not
   against the REST listing the UI renders, because those are two different code paths
   (`handle_list_project_tools` passes `mcp_enabled_only=True`; the REST endpoint
   filters in its own query).
4. **Exposure is scoped to the project that owns the flow.** Everything runs against a
   project this test creates, so a pass cannot be produced by another project's flows.

If this fails, the per-project tool selection no longer controls what an MCP client
discovers: either the settings do not persist, or the protocol serves a set that
disagrees with them.

---

## Tags *(required)*

`@stable` `@api` `@mcp`

- `@stable` — pure API and protocol, no browser navigation, no LLM key and no external
  network; validated per `CONTRIBUTING.md` before the PR.
- `@api` — drives `GET`/`PATCH /api/v1/mcp/project/{id}` and the JSON-RPC endpoint
  directly; there is no UI step.
- `@mcp` — the MCP server area (`tests/.../mcp/`, area-local `CLAUDE.md`).
- **No `@regression`** — that tag means "test for a previously fixed bug"
  (`CLAUDE.md`), and this is new coverage of a path with no bug history.

---

## Preconditions *(optional)*

- Langflow running at `PLAYWRIGHT_BASE_URL`; auto-login superuser.
- No provider key, no npm registry, no external MCP server: the flow under test is a
  Chat Input → Chat Output passthrough created from
  `tests/assets/flows/chat-io-ok-trace-fixture.json`.
- The test creates its **own** project and its own flow inside it, and deletes both.
  It never touches the default project, so it cannot race
  `mcp-server-protocol.spec.ts`, which mutates the default project's MCP settings.

---

## Step by step *(required)*

Shared setup (`beforeAll`): resolve the auth token, create a project via
`createProjectViaApi`, and create a passthrough flow inside it (`folder_id` = the new
project). Teardown deletes the flow and then the project.

### 1 — `project MCP settings round-trip through GET and PATCH`

1. `GET /api/v1/mcp/project/{project}`: assert a freshly created project exposes
   **nothing** (`tools: []`) — the baseline every later assertion is measured against.
2. `PATCH` the project with `settings: [{ id: flow, mcp_enabled: true, action_name,
   action_description }]`; assert 200.
3. `GET` again: assert exactly **one** entry, and that it carries the flow's id,
   `mcp_enabled: true`, the `action_name` and `action_description` just written, plus
   the flow's own `name`/`description` (the endpoint returns both pairs and they are
   not the same thing).

### 2 — `an exposed flow is served over the protocol, and de-selecting withdraws it`

1. `initialize` against `/api/v1/mcp/project/{project}/streamable` and assert the
   server identifies itself as this project (`langflow-mcp-project-{id}`) — a
   handshake against the wrong endpoint would otherwise pass every later step.
2. `tools/list`: assert the `action_name` is present and that its `description` is the
   **action** description, not the flow's. The action name is kept **short on
   purpose** — see *Notes*, the protocol truncates at 30 characters.
3. `tools/call` with a unique sentinel: assert `isError: false` and that the echoed
   text is the sentinel — the listing is backed by a real capability.
4. `PATCH` the same flow to `mcp_enabled: false`; assert 200.
5. `tools/list` again: assert the `action_name` is **gone**.
6. `GET /api/v1/mcp/project/{project}`: assert `tools: []`, and that
   `?mcp_enabled=false` returns the flow with `mcp_enabled: false`. That parameter
   **removes** the `WHERE mcp_enabled = true` clause rather than inverting it
   (`mcp_projects.py:301`), so on a project holding one flow the two readings are
   "the exposed set" and "the whole project".

---

## Validation criterion *(required)*

- A newly created project exposes no tools, and after one `PATCH` it exposes exactly
  the flow named in that `PATCH`, with the action name and description that were sent.
- The MCP protocol agrees with the REST selection **in both directions**: the enabled
  action is listed and callable; after de-selection it is absent from `tools/list`.
- `tools/call` on the enabled action returns the exact sentinel that was sent, so the
  exposure is a working tool rather than an advertised name.
- The unfiltered listing (`?mcp_enabled=false`) still returns the flow, now with
  `mcp_enabled: false` — proving it was withdrawn from exposure rather than deleted or
  detached from the project.

## Guarding against false positives *(how)*

- **Its own project and its own flow**, created per run with a unique name. No
  assertion can be satisfied by a flow another spec (or a previous run) exposed, and
  nothing this test writes can disturb the default project other specs use.
- **A unique per-run `action_name`**, so `tools/list` containment is about this run.
- **The de-selection assertion is made over the protocol** (`tools/list`), not against
  the REST listing. The REST endpoint and the MCP handler filter `mcp_enabled` in two
  different places, so asserting the REST side alone would not prove what an MCP
  client sees — which is the whole point of the bullet.
- **`tools/call` before de-selection** anchors the positive case in behaviour: a build
  that listed the tool but could not run it would pass a containment-only test.
- **The handshake asserts the project identity**, so a misdirected endpoint fails at
  step 1 instead of producing an empty `tools/list` that looks like correct
  de-selection. That single assertion is byte-identical to one in
  `mcp-server-protocol.spec.ts`, and the repetition is deliberate: there it is the
  coverage, here it is the precondition that makes an *absence* meaningful.
- **A fixture guard on the action name's length** fails in `beforeAll`, naming the
  30-character cap, rather than as a `tools/list` miss that reads like a product
  defect (see *Notes*).
- **Both `tools/list` calls check the JSON-RPC response before reading it.** Reading
  `resp.result?.tools ?? []` would turn any failed call into an empty list, and the
  de-selection assertion — the one this spec exists for — would then pass for exactly
  the wrong reason. Proven by mutation: with the guard removed, pointing that step at a
  bogus JSON-RPC method left the spec green.
- **Force-failure check** (CONTRIBUTING §2) executed per assertion during VERIFY.

---

## What this test does not cover *(optional)*

- **`tools/call` after de-selection — because it currently succeeds.** Measured on
  `1.12.0.dev20`: a flow whose `mcp_enabled` is `false` is absent from `tools/list`
  yet still executes over `tools/call` under its `action_name`, returning
  `isError: false`. It is not a cache — a tool that was **never** called while enabled
  behaves the same, while a genuinely unknown name answers
  `isError: true, "Flow with name '…' not found"`. Source-confirmed: the list handler
  passes `mcp_enabled_only=True` (`api/v1/mcp_projects.py`), while
  `handle_call_tool` (`api/v1/mcp_utils.py`) resolves by action name, checks the
  project and enforces `FlowAction.EXECUTE`, and never reads `mcp_enabled`. So the
  per-project selection is a **discovery** control, not an invocation control.
  Filed as its own product-finding issue (#1408); asserting the corrected behaviour
  here would ship a durably red `@stable` test, which triage strips within a day.
- **Auth settings** (`auth_settings` on the same `PATCH`) — a separate surface; the
  API-key variant is exercised by the A2A/project-auth specs.
- **The MCP Server tab UI** that drives this API — `mcp-server-tab.spec.ts`.
- **The generated endpoint and tool execution on the default project** —
  `mcp-server-protocol.spec.ts`. This spec asserts a call only to anchor the positive
  case; it is not the execution coverage.
- **Resources and prompts** — `mcp-server-resources.spec.ts`; `prompts/list` returns
  `[]` (no product surface, #829).
- **Installing the project into an MCP client** — #1395.
- **How the protocol derives a tool name from a long or exotic `action_name`.** The
  cap and the sanitizer are documented in *Notes* because they cost this spec a red
  run, but the transformation itself (emoji/diacritic stripping, collapsing,
  de-duplication via `get_unique_name`) is a naming contract of its own and is left
  to a spec that takes it as its subject.

---

## External dependencies *(required)*

- `src/backend/base/langflow/api/v1/mcp_projects.py` — `list_project_tools`
  (`GET /{project_id}`, including the `mcp_enabled` query filter),
  `update_project_mcp_settings` (`PATCH /{project_id}`, which merges **per flow id**
  and leaves flows it does not name untouched), `_build_project_tools_response`, and
  the `ProjectMCPServer` handlers that register `handle_list_project_tools`
  (`mcp_enabled_only=True`) and `handle_call_project_tool`.
- `src/backend/base/langflow/api/v1/mcp_utils.py` — `handle_call_tool`, which resolves
  a tool by action name and is where the missing `mcp_enabled` check lives (#1408).
- `tests/helpers/mcp/mcp-streamable-client.ts` — `mcpHandshake` / `mcpCall`, the
  repo's minimal streamable-HTTP JSON-RPC client (reused rather than hand-rolled, as
  #1396 requires).
- `tests/helpers/flows/create-project-via-api.ts`, `tests/helpers/flows/create-flow.ts`,
  `tests/helpers/flows/delete-flow.ts`, `tests/helpers/flows/delete-project.ts`,
  `tests/helpers/auth/get-auth-token.ts`.
- `tests/assets/flows/chat-io-ok-trace-fixture.json` — the passthrough flow.

---

## When to review this test *(optional)*

- If `MCPProjectUpdateRequest` gains or drops a field, or `PATCH` stops merging per
  flow id (a whole-project replace would silently disable flows this test never named).
- If `GET /{project_id}` changes shape — it currently returns
  `{ tools: [...], auth_settings }`, and each tool entry carries **both** the action
  pair and the flow's own name/description.
- If `?mcp_enabled` stops behaving as an on/off for the `mcp_enabled = true` filter —
  note it never selected the disabled set, and a build that made it do so would change
  what step 6 means without failing it on a single-flow project.
- If the streamable endpoint's `serverInfo.name` stops being
  `langflow-mcp-project-{id}`.
- If #1408 is fixed: add the post-de-selection `tools/call` assertion here and move
  the paragraph out of *What this test does not cover*.

---

## Notes *(optional)*

- **Why its own project.** `mcp-server-protocol.spec.ts` mutates the **default**
  project's MCP settings and says so in a comment anticipating a second project-MCP
  spec. Creating a project here removes the shared-state question entirely instead of
  relying on serial execution across files, which Playwright does not provide — and
  per-project scoping is the subject of the bullet anyway.
- **Why the flow is created inline rather than through
  `createRunnableChatFlowViaApi`.** That helper does not accept a `folder_id`, and it
  has **29 call sites across 21 specs**: extending it would pull every one of those
  specs into this PR's impacted-E2E lane (the import-graph selection, #1054) in
  exchange for two lines. The file-local helper reads the same fixture and calls the
  same `createFlow`.
- **Neither endpoint echoes `action_name` verbatim, and the difference cost a red
  run.** The REST listing serves `sanitize_mcp_name(action_name)` at the sanitizer's
  default cap of **46** (`mcp_projects.py:314`), while `tools/list` serves
  `get_unique_name(sanitize_mcp_name(action_name), 30, …)` — `MAX_MCP_TOOL_NAME_LENGTH`
  is **30** (`src/lfx/src/lfx/base/mcp/constants.py`). The two therefore agree only for
  a name that is already lowercase `[a-z0-9_]` **and** within 30 characters. The first
  version of this spec used a 35-character name: the REST round trip passed and
  `tools/list` answered with the name cut at 30 (`e2e_project_cfg_1786413140760_`),
  which reads exactly like the tool having failed to publish. Both halves measured on
  `1.12.0.dev20` — an `E2E-Probe-…` name comes back from `GET` lowercased and
  underscored, not as sent. The action name is now ~21 characters and a `beforeAll`
  guard asserts **both** the cap and the character class.
- **A truncated tool name is not merely renamed — it is uninvocable.** `tools/call`
  with the exact name `tools/list` itself served for a 37-character action
  (`e2e_probe_action_name_that_is_`) answers
  `isError: true, "Flow with name 'e2e_probe_action_name_that_is_' not found"`: the
  listing truncates while the lookup does not, so the server advertises a tool no
  client can call. Measured on `1.12.0.dev20`. Not asserted here — this spec's subject
  is the selection, and MCP tool naming deserves a spec of its own — but it is why the
  guard above is a hard failure rather than a comment.
- **The project's name prefix must be at most six characters, and that is load-bearing.**
  Creating a project derives an MCP server named `lf-${sanitize_mcp_name(name)[:26]}`
  (`MAX_MCP_SERVER_NAME_LENGTH` is 30 minus the `lf-` prefix) and that derived name
  must be unique per user, while `createProjectViaApi` appends a 20-character
  `-${Date.now()}-${rand5}`. Six or fewer is what **guarantees** the whole unique part
  stays inside the cut. Past six the suffix is truncated from the right and the
  conflict risk grows with the prefix rather than becoming certain at once — at seven
  characters four of the five random characters still survive — whereas the
  22-character prefix the first version of this spec used (`e2e_mcp_project_config`)
  left nothing past the first three digits of the timestamp, so there every project it
  created collided with the previous one: `POST /api/v1/projects/` → **409**
  `MCP server name conflict: 'lf-e2e_mcp_project_config_178' already exists for a
  different project`. That is how that version failed under
  `--workers=4 --repeat-each=3`.
  **This is a product behaviour, not a test artefact** — reproduced with two ordinary
  names on `1.12.0.dev20`: `Marketing Automation Project Alpha` creates, and
  `Marketing Automation Project Beta` is refused, because they share their first 26
  characters. Filed as **#1409**. Worth knowing before adding another project-creating spec: of the
  prefixes the suite uses today, `a2a-authgate` (12 chars) truncates to exactly the
  timestamp boundary, so it survives only because two projects are unlikely to be
  created in the same millisecond. This spec's own prefix is five characters, one
  inside the cut.
- **`PATCH` merges per flow id.** `update_project_mcp_settings` iterates the project's
  flows and touches only those named in `settings`, so this test cannot disable
  anything it did not create — worth knowing before reusing this pattern against a
  project that is not disposable.
