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
   canvas (`data_sourceAPI Request`, via `dragComponentFromSidebar` — the drag is
   repaired, see Notes), giving the flow a tool to expose; then exit the flow.
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
   (`add-component-button-lf-starter_project`, via
   `addComponentFromSidebarWithoutSearch` — the add is repaired, see Notes);
   open the **Add MCP Server** modal (`openAddMcpServerModal`); paste the Linux
   config with a unique server name substituted; click `add-mcp-server-button`.
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
- `helpers/flows/add-component-from-sidebar.ts` — both repairing adds this spec
  needs: `dragComponentFromSidebar` (step 1, drag) and
  `addComponentFromSidebarWithoutSearch` (step 8, click on a tab with no search).
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
- **Cleanup is id-scoped, never a wipe** (#553), and it was added in #1335 —
  the claim it replaces ("no flows are left behind by design") was false. The
  test creates TWO flows per run and registered a fresh `test_server_<random>`
  every time, deleting neither: measured on the local nightly while working
  #1335, 14 orphan `test_server_*` registrations had accumulated (alongside 58
  orphan "New Flow" flows, which this spec shares with every other blank-flow
  spec). The servers are not merely litter — their count decides which branch
  the widget under test renders (an empty list shows
  `add-mcp-server-simple-button`, a populated one `mcp-server-dropdown`), so
  leaving them behind quietly stopped the spec from ever taking the empty-list
  path again. Flow ids come from `POST /api/v1/flows` 201 bodies, not from the
  canvas URL, which still holds the stale bootstrap id (#681). Folder CRUD is
  exercised by the sibling starter-projects spec.
- **The step-8 add is repaired, and that is what #1335 was** (recurrent flake on
  the 2026-08-05 and 2026-08-06 dailies). The failure named
  `mcp-server-dropdown` — `locator.click: Timeout 3000ms exceeded` — and the
  issue read it as a widget too slow for a 3 s budget. It was not: the failing
  attempt's `error-context.md` shows an empty `application "Flow canvas"` with
  "Minimize all" disabled, i.e. Langflow had swallowed the sidebar click and
  there was no MCP component at all. Both of the modal's entry points hang off
  that node, so **no wait budget could have fixed it** — measured on nightly
  1.12.0.dev17: **4 of 8** first clicks on the MCP tab produced no node within
  12 s, all 4 repaired by an identical second click (the #1304 class, whose
  Components-tab rate was 4/20), while a landed add rendered in 91–108 ms and
  its entry point became visible 6–15 ms later, enabled, in 8 of 8.
- Consequently `openAddMcpServerModal` no longer decides its branch from a snap
  read: `isVisible({ timeout: 1000 })` looks like a wait but Playwright ignores
  that option, so the helper committed to the dropdown branch before the widget
  had painted — and in the no-servers case that locator never appears at all. It
  now waits for **either** entry point and, when neither arrives, fails naming
  the canvas node count so an empty canvas is never reported as a slow dropdown.
- **The step-1 API Request add is repaired too, and it is a SECOND surface.**
  Fixing the MCP-tab click left the spec at 4 of 5, and the one failure was not
  the #1335 signature at all: the *drag* at the top of the test was swallowed,
  and surfaced 30 s later as `waitForSelector: generic-node-title-arrangement`
  timing out — naming the node that was never created rather than the gesture
  that failed to create it, which is the same mis-attribution #1335 was filed
  under, one surface over. Measured on nightly 1.12.0.dev18: **1 of 5** drags
  swallowed while the repaired MCP-tab click was 5 of 5 clean. It now goes
  through `dragComponentFromSidebar`, which re-issues the drag once. The gesture
  is re-issued rather than swapped for a click: dragging out of the sidebar is an
  interaction Langflow ships, and a spec that quietly stops exercising it stops
  covering it. The comment this replaced ("use dragTo which is more reliable than
  click on add-component-button") predates the #1304 repair — neither gesture is
  reliable bare, and both are reliable repaired.
