# MCP Server — flow MCP tab, tool selection & add-server modal (UI)

**Last validated:** Langflow 1.12.x

---

## What this test validates *(required)*

Covers two UI items of QA-CHECKLIST §14.1 that concern managing a Langflow
**project as an MCP server from the UI**:

1. **MCP Server tab in flow** (§14.1). The flow's MCP Server tab renders, lists
   the project's flows/tools, lets a tool be selected and renamed through the
   "Edit Tools" (Actions) modal, and the change persists across a reload. The
   JSON configuration exposes a real, copyable client config (`mcpServers`,
   `mcp-proxy`, `uvx`, an SSE endpoint URL) and can mint an API key.
2. **Add MCP server via modal** (§14.1). The generated client config is fed back
   into the **Add MCP Server** modal (from an MCP-starter-project flow) and, once
   added, its tools resolve in the `dropdown_str_tool` selector — proving the
   round-trip (project exposed → registered as an MCP server → tools discovered).

If this fails, the MCP Server tab no longer manages tools, no longer emits a
valid client configuration, or a server built from that configuration can no
longer be added and have its tools discovered — a core MCP-server UI regression.

---

## Tags *(required)*

`@release` `@workspace` `@components` `@mcp` `@stable`

- `@stable` — promoted under #948 after repeated clean `--workers=1 --retries=0`
  runs on nightly 1.12.0.dev4 and a per-assertion force-failure check.
- `@workspace`/`@components` — drives the flow canvas + MCP tab UI; `@mcp` — MCP
  server area; `@release` — happy-path MCP-server management.

---

## Preconditions *(optional)*

- Langflow running at `PLAYWRIGHT_BASE_URL`; auto-login superuser.
- The default MCP starter project exists (`lf-starter_project`), so the
  `add-component-button-lf-starter_project` starter is available in the sidebar.
- No LLM / provider key required (no agent executes).
- Clipboard permission (granted by the Playwright config) — the test reads the
  generated client config via `navigator.clipboard`.

---

## Step by step *(required)*

1. Bootstrap; create a blank flow and drag an **API Request** component onto the
   canvas (gives the flow a tool to expose), then exit the flow.
2. Open the **MCP Server tab** (`mcp-btn`); assert `mcp-server-title` and the
   "Flows/Tools" header are visible.
3. Open **Edit Tools** (`button_open_actions`) → the "MCP Server Tools" modal.
   Assert the tools grid has rows/cells; select the first tool (checkbox becomes
   checked); close the modal.
4. **Reload**; reopen the MCP tab and the Actions modal; re-select the first data
   row and rename its action via `input_update_name` → "mcp test name"; close.
   Assert `div-mcp-server-tools` is visible (the selection persisted).
5. Switch the config to **JSON** mode; assert a `pre` block renders. If a
   "Generate API key" button is present, generate the key and assert the JSON
   flips from `YOUR_API_KEY` to a real non-empty key and the button disappears;
   otherwise assert the state is already "API key generated".
6. Copy the config (Windows form): assert it contains `mcpServers`, `mcp-proxy`,
   `uvx`, and a matchable SSE URL. Switch to **macOS/Linux** form and copy again:
   assert its `args` SSE URL matches.
7. Assert the **setup guide** link points at the documented MCP-server anchor.
8. Bootstrap again; add an **MCP-starter-project** component to a new flow
   (`add-component-button-lf-starter_project`); open the **Add MCP Server** modal
   (`openAddMcpServerModal`); paste the Linux config with a unique server name
   substituted; click `add-mcp-server-button`.
9. Assert the `dropdown_str_tool` selector becomes enabled and, when opened,
   exposes at least one tool option (`[data-testid*="-option"]`).

---

## Validation criterion *(required)*

- The MCP Server tab renders (`mcp-server-title` + "Flows/Tools"); a tool can be
  selected and renamed via the Actions modal, and the selection survives a reload
  (`div-mcp-server-tools` visible).
- The generated JSON client config contains `mcpServers` / `mcp-proxy` / `uvx`
  and a matchable SSE endpoint URL for both the Windows and macOS/Linux forms;
  the API-key generation flips `YOUR_API_KEY` to a real key when offered.
- A server added from that config via the modal resolves ≥1 tool option in
  `dropdown_str_tool` — the exposed-project → added-server round-trip works.

## Guarding against false positives *(how)*

- **Unique server name per run** (`test_server_<random>`) — the modal-add step
  cannot pass on a stale server from a previous run.
- **Concrete config asserts** (`mcpServers`/`mcp-proxy`/`uvx` + a regex-matched
  SSE URL) — a blank or malformed config cannot satisfy them.
- **Reload gate** — the rename/selection is re-read after `page.reload()`, so a
  purely client-side (unpersisted) change fails.
- **Force-failure check** (CONTRIBUTING §2) run during VERIFY on the tab-visible,
  config-content and tool-count assertions.

---

## What this test does not cover *(optional)*

- MCP-server tool **execution** over the protocol — covered by
  `mcp-server-protocol.spec.ts`.
- Flow-file **resources** — covered by `mcp-server-resources.spec.ts`.
- MCP server **auth_settings** / OAuth composer path.
- Starter-project folder CRUD — covered by `mcp-server-starter-projects.spec.ts`.

---

## External dependencies *(required)*

- MCP Server tab UI (`mcp-btn`, `mcp-server-title`, `button_open_actions`,
  `div-mcp-server-tools`, `input_update_name`) and the JSON-config panel
  (`icon-copy`, API-key generation).
- Add-MCP-server modal (`add-mcp-server-simple-button` / `mcp-server-dropdown` →
  `add-mcp-server-button`, `json-input`) via `helpers/mcp/open-add-mcp-server-modal.ts`.
- The `lf-starter_project` MCP starter (`add-component-button-lf-starter_project`).
- API Request component (`data_sourceAPI Request`) — the tool exposed on the flow.
- `helpers/other/await-bootstrap-test.ts`, `helpers/ui/adjust-screen-view.ts`.

---

## When to review this test *(optional)*

- If the MCP Server tab testids, the Actions/Edit-Tools modal, or the JSON client
  config shape (`mcpServers`/`mcp-proxy`/`uvx`) change.
- If the add-MCP-server modal flow or `dropdown_str_tool` changes.
- If the setup-guide docs anchor changes.

---

## Notes *(optional)*

- Single `test()`, heavy UI (loads a flow + MCP starter project). Trace-on may
  hang on the ReactFlow-canvas family (see the skill's known `--trace=on`
  limitation); step verification relies on `--retries=0` bursts + force-fail.
- The API-key generation is branch-guarded because the button only appears when
  no key exists yet; both branches assert a valid end state.
- No flows are left behind by design — the flows created live in the default
  project and the test does not persist named artifacts requiring id-scoped
  cleanup; folder CRUD is exercised by the sibling starter-projects spec.
