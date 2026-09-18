# Spec: A Group node offers no Tool Mode, even when it contains a component that does

**Test file:** `tests/tests-automations/regression/core-components/toolModeGroup.spec.ts`

**Last validated:** Langflow 1.13.x (nightly `1.13.0.dev16`)

---

## What this test validates

Tool Mode — the toolbar's `tool-mode-button` and its `Ctrl/Cmd+Shift+M` shortcut — is
never offered on a **Group** node, even when the group encapsulates a component that
offers it on its own.

The exclusion is explicit upstream: the node toolbar computes
`hasToolMode = checkHasToolMode(template) && !isGroup`, and renders `tool-mode-button`
when `hasToolMode` is true and the Freeze button (`freeze-all-button-modal`) otherwise.
The `!isGroup` term is **load-bearing**, and this test proves it rather than assuming it:
a GroupNode's template is the union of its inner nodes' fields (suffixed with the inner
node id), so a group that contains a Prompt Template carries
`tool_placeholder_<innerId>` with `tool_mode: true` — and `checkHasToolMode` on that
template alone answers **true**. Without `!isGroup` the Group would offer Tool Mode.

The test asserts that:

1. the Prompt Template, selected on its own, offers Tool Mode (positive control — the
   same toolbar, the same testid, visible); and on a second, standalone Prompt Template
   the same shortcut **does** toggle it: it posts `POST /api/v1/custom_component/update`
   and renders the `Toolset` output, and a second press takes it back out;
2. grouping the Prompt Template with the Type Convert it feeds replaces both with
   exactly one Group node;
3. the **persisted** GroupNode's template carries at least one field with
   `tool_mode: true` — the premise that makes the exclusion load-bearing;
4. with the Group selected, the toolbar renders the Freeze branch
   (`freeze-all-button-modal` visible) and **no** `tool-mode-button`;
5. pressing `Ctrl/Cmd+Shift+M` on the selected Group issues **no**
   `POST /api/v1/custom_component/update` (the request an effective Tool Mode toggle
   sends) and renders no `Toolset` output.

---

## Tags

`@stable` `@release` `@workspace` `@components` `@ui-ux`

`@ui-ux` is the functional area: the node toolbar and a keyboard shortcut.

---

## Step by step

1. Create over the API a flow built from the live `GET /api/v1/all` catalog
   (`build-catalog-flow`) and open it with `openFlowById`: a **Prompt Template → Type
   Convert** pair, plus a standalone Prompt Template named `Tool Mode Control`. The flow
   id is deleted id-scoped in `afterEach`, after leaving the editor with
   `unmountEditorForCleanup`. The pair is groupable: neither node is an input/output
   component, and they are connected (`validateSelection` rejects both an I/O component
   and a selection with more than one free output).
2. Click `title-Prompt Template` — assert `tool-mode-button` is visible.
3. Click `title-Tool Mode Control` and press `ControlOrMeta+Shift+M` — assert a
   `POST /api/v1/custom_component/update` is sent and `Toolset` renders; press it again —
   assert another is sent and `Toolset` count 0. The calibration runs on this separate
   node because Tool Mode swaps a component's outputs, and the canvas then removes the
   pair's edge as invalid — which would make the pair ungroupable.
4. Fit the canvas, clear the selection and box-select the pair (`Shift` + drag over
   the two nodes' bounding boxes) — assert two `.react-flow__node.selected` — then click
   the selection menu's `group-node`. Assert `title-Group` visible, `title-Prompt
   Template` count 0 and `title-Tool Mode Control` still visible.
5. Poll `GET /api/v1/flows/{id}` until the flow holds exactly one `GroupNode`, whose
   template has at least one field with `tool_mode: true`, next to the control node.
6. Click `title-Group` — assert `freeze-all-button-modal` visible and `tool-mode-button`
   count 0.
7. Arm a listener for `POST /api/v1/custom_component/update` (matched on the
   pathname), press `ControlOrMeta+Shift+M`, and assert no such request within 5 s,
   `Toolset` count 0 and `tool-mode-button` still count 0.

---

## Validation criterion

| Claim | Observable |
|---|---|
| The inner component offers Tool Mode on its own | `tool-mode-button` visible with the Prompt Template selected |
| The shortcut toggles a component that offers it | on `Tool Mode Control`: `POST /api/v1/custom_component/update` sent and `Toolset` visible after the key press; sent again and `Toolset` count 0 after the second press |
| The pair was grouped | two `.react-flow__node.selected` before `group-node`; then `title-Group` visible and `title-Prompt Template` count 0 |
| The exclusion is load-bearing | persisted `GroupNode` template has a field with `tool_mode: true` |
| The Group's toolbar takes the no-Tool-Mode branch | `freeze-all-button-modal` visible **and** `tool-mode-button` count 0, in the same render |
| The shortcut is inert on the Group | no `POST /api/v1/custom_component/update` within 5 s of the key press; `Toolset` count 0 |

Why each negative can fail: the toolbar check pairs the absent button with the button
that replaces it, so an unrendered toolbar cannot pass it; the shortcut check observes
the request an effective toggle sends — step 3 shows, in the same test and with the same
key press, that the request does fire when Tool Mode is offered — rather than reading the
canvas right after the key press.

The test fails if a Group offers Tool Mode (the `!isGroup` exclusion regressed), if the
group template stops carrying the inner `tool_mode` field (the premise changed — the test
would otherwise go green vacuously), or if grouping itself breaks.

---

## External dependencies

- `src/frontend/src/pages/FlowPage/components/nodeToolbarComponent/hooks/use-toolbar-node-state.ts`
  — `hasToolMode = checkHasToolMode(...) && !isGroup`, and `isGroup` from `data.node.flow`
- `src/frontend/src/pages/FlowPage/components/nodeToolbarComponent/components/ToolbarButtonRow.tsx`
  — `tool-mode-button` vs `freeze-all-button-modal`
- `src/frontend/src/pages/FlowPage/components/nodeToolbarComponent/index.tsx` — the
  `Ctrl/Cmd+Shift+M` handler (`handleActivateToolMode`)
- `src/frontend/src/utils/reactflowUtils.ts` — `checkHasToolMode`, and the group
  template that merges the inner nodes' fields
- `src/lfx/src/lfx/components/models_and_agents/prompt.py` — Prompt Template declares
  `tool_placeholder` with `tool_mode=True`
- `src/lfx/src/lfx/components/processing/converter.py` — Type Convert, the non-I/O
  partner
- `tests/helpers/flows/build-catalog-flow.ts` — builds both nodes from the live catalog

---

## What this test does not cover

- Ungrouping and restoring the edge — `core-components/nested-grouping-regression.spec.ts`.
- Grouping a component that is already **in** Tool Mode with its Agent consumer —
  `core-components/tool-mode-group.spec.ts`.
- Toggling Tool Mode on a single component — `core-components/tool-mode.spec.ts`.

---

## Preconditions

- Langflow running at `PLAYWRIGHT_BASE_URL`. No provider key, no custom-component flag.

---

## Notes

- **Wave 9 T2 triage, issue #1911 — outcome PROMOTE.** Row in
  `docs/triage/inherited-spec-triage.md`: T2, `core-components/toolModeGroup.spec.ts`,
  0/3 green, quarantined by `test.skip` ("TODO: fix this test"). The `test.skip` comes off
  with the promotion.
- **Title changed.** The inherited title was *"group and ungroup updating values"*; its
  body never ungrouped nor updated a value — it grouped two nodes and asserted
  `tool-mode-button` hidden on the Group. The title now says what the test asserts.
- **Why it failed (drift, not product).** Measured on `1.13.0.dev16`: it died at
  `fit_view` (20 s) — that control now lives inside the `canvas_controls_dropdown` menu.
  Behind it was one more dead step — the Basic Prompting template has no `OpenAI` node (it
  ships a `Language Model`) — and one that only works on some hosts: selecting by
  `ControlOrMeta` + click. The suite runs `devices["Desktop Chrome"]`, whose Windows user
  agent makes React Flow expect `Control` as the multi-selection key, and Chromium on
  macOS turns `Control` + click into a context-menu click — measured: no modifier
  multi-selected on a macOS host. The pair is now box-selected with `Shift` + drag, the
  gesture `nested-grouping-regression.spec.ts` and `tool-mode-group.spec.ts` already use.
  It also opened the template through `awaitBootstrapTest`, which leaked **3 flows per
  run** on an empty project. The flow is now built over the API and deleted by id.
- **Why DELETE was not available.** `nested-grouping-regression.spec.ts` groups and
  ungroups but never reads the Group's toolbar; `tool-mode-group.spec.ts` asserts the
  group is created. Neither asserts the `!isGroup` exclusion.
- **The inherited assertion was vacuous.** `expect(getByTestId("tool-mode-button")).toBeHidden()`
  passes for a renamed testid, an unrendered toolbar, or a Group that was never selected.
  Steps 2, 3, 5 and 6 are what give it a failing state.
