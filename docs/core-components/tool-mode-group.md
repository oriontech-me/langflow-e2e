# Group Components in Tool Mode (§2.2 Tool Mode)

**Last validated:** Langflow 1.11.x

---

## What this test validates *(required)*

Validates that a component in **Tool Mode** can be **grouped** together with its
consumer into a single **Group** node — the §2.2 "Group components in Tool Mode"
behavior. Grouping is Langflow's "collapse a connected sub-graph into one
reusable component" feature (`Ctrl/Cmd+G`); the test proves a tool-mode
component participates in a group without being rejected or stripped, and that
the created group absorbs it.

Concretely: a **URL** component is switched to Tool Mode (its output becomes a
`toolset` handle), connected to an **Agent**'s `tools` input, both are selected,
and grouped. The result is a single **Group** node — Langflow does not raise the
"Invalid selection" guard (which fires for ungroupable selections), the two
nodes collapse into one, and the group exposes the tool-mode component's own
input (`urls`) as a group input, proving the URL was absorbed into the group
with its wiring intact.

If this breaks, users could no longer package a tool-mode component + its Agent
into a reusable group — either the group action would be rejected or the
tool-mode component would be dropped/mis-wired on grouping.

---

## Tags *(required)*

`@stable` `@release` `@components`

---

## Preconditions *(required)*

- Langflow running at `PLAYWRIGHT_BASE_URL`.
- No model provider credentials required — the flow is assembled and grouped but
  never run (grouping is a client-side graph operation).

---

## Step by step *(required)*

1. Bootstrap the app and open a blank flow.
2. Open **Data Sources**, add the **URL** component, focus it, and drag it into
   the canvas.
3. Enable Tool Mode on it (`Ctrl/Cmd+Shift+M`) → assert the `toolset` output
   appears.
4. Open **Models & Agents**, drag an **Agent** onto the canvas.
5. Connect the URL's `handle-urlcomponent-shownode-toolset-right` to the Agent's
   `handle-agent-shownode-tools-left`; assert an edge exists.
6. Shift+drag a selection box over the canvas to select both nodes; assert two
   `.react-flow__node.selected`.
7. Press `Ctrl/Cmd+G` to group.
8. Assert the group materialized (below).

Every flow this page creates is captured from its `POST /api/v1/flows → 201`
response and deleted id-scoped in `afterEach`.

---

## Validation criterion *(required)*

After `Ctrl/Cmd+G`, all of the following hold:

- a **Group** node exists — `title-Group` is visible and `button_run_group` is
  present;
- **no** "Invalid selection" error toast appeared (the selection was a valid,
  connected, single-free-output group — a tool-mode component did not block it);
- the two original nodes collapsed into one — `div-generic-node` count is 1;
- the group absorbed the tool-mode component — the group exposes its `urls`
  input handle (`handle-groupnode-shownode-urls-left`), which only exists
  because the URL component (in Tool Mode) is now inside the group.

Each assertion targets a distinctive observable; a mutated assertion (expecting
the group to be absent, or the nodes not to collapse) fails deterministically.

---

## External dependencies *(required)*

- `data-testid="data_sourceURL"` / `add-component-button-url` — sidebar URL
  component + its quick-add button.
- `generic-node-title-arrangement` — node header (focus/drag target).
- `Ctrl/Cmd+Shift+M` — Tool Mode toggle shortcut; `text=toolset` — the tool-mode
  output marker.
- `handle-urlcomponent-shownode-toolset-right` / `handle-agent-shownode-tools-left`
  — the toolset→tools connection handles.
- `Ctrl/Cmd+G` — the Group shortcut (`GroupSelection`).
- `title-Group` / `button_run_group` / `handle-groupnode-shownode-urls-left` —
  the created group node's title, run button, and absorbed URL input handle.

---

## What this test does not cover *(optional)*

- **Ungrouping** the created group and asserting the internal URL is still in
  Tool Mode. The ungroup action could not be driven reliably from the UI
  (neither the toolbar Ungroup icon nor `Ctrl+Shift+G` fired the ungroup with
  the group node selected — scouted extensively on 1.11.0.dev43); the test
  therefore validates that a tool-mode component is groupable and absorbed, not
  the ungroup round-trip. If Langflow exposes a stable ungroup affordance later,
  extend this spec with a group→ungroup→`toolset`-returns round-trip.
- Grouping **two disconnected tool-mode components**. Langflow rejects that with
  "Invalid selection — Select only one component with free outputs · Select only
  connected components" (two free `toolset` outputs). A valid group needs the
  tool-mode component(s) connected to a single-free-output consumer (the Agent).
- Running the grouped flow (needs a provider).

---

## Notes *(optional)*

- **Why a tool-component → Agent pair (not two bare tool components).** The Group
  action requires a connected selection with exactly one free output. Two
  tool-mode components each expose a free `toolset` output → "Invalid selection".
  Wiring the tool-mode URL into the Agent's `tools` leaves the Agent's `Response`
  as the single free output, making the selection groupable while still
  containing a Tool-Mode component. Verified live on 1.11.0.dev43.
- **Distinct from `tool-mode.spec.ts`.** That spec covers §2.2 "Enable Tool Mode
  on a component" (toggle + toolset inspection). This one covers the separate
  §2.2 bullet "Group components in Tool Mode".
- **Expected "Error while updating the Component" toast.** Because the Agent
  used as the tools sink has **no model provider configured**, Langflow shows an
  *"Error while updating the Component"* toast during the group operation. It is
  benign here: no HTTP 4xx/5xx fires (the fixture backend monitor is not
  tripped), no JS console error, and the group is still created — the spec runs
  green and deterministic. Configuring a provider would silence it but couple the
  spec to an LLM (collect-models, model strategy, `--workers=1`, the
  model-selection-drop race) for zero added coverage of the grouping behavior, so
  the provider-less design is intentional. Do not "fix" this by weakening an
  assertion — the toast is app-side, not a test failure.
- **Flow cleanup.** The assembled flow's id is captured from
  `POST /api/v1/flows → 201` (a bare `page.url()` races the bootstrap flow's
  stale id — #490/#681) and deleted in `afterEach`.
