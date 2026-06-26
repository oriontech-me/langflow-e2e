# Spec: Delete a Component from the Canvas

**Test file:** `tests/tests-automations/regression/core-components/componentDelete.spec.ts`

**Last validated:** Langflow 1.10.x

---

## What this test validates

Confirms that components placed on the canvas can be removed by the user, through every supported deletion path, leaving the flow without the deleted node(s). This is the canvas node-lifecycle counterpart of `componentHoverAdd` (which validates adding a component) and the foundation for graph-manipulation coverage.

The spec is a `test.describe` block of three tests, one per deletion mechanism:

1. **Backspace key** — with one node on the canvas, selecting it and pressing `Backspace` removes it (count `1 → 0`).
2. **Node options menu** — with one node on the canvas, opening the node's options (`...`) menu and clicking **Delete** removes it (count `1 → 0`).
3. **Marquee box selection (multiple nodes)** — with two nodes on the canvas, a Shift+drag selection marquee selects all of them and `Backspace` removes them at once (count `2 → 0`).

A shared `beforeEach` opens a blank flow via `setupBlankFlow` and asserts the canvas starts empty; a shared `afterEach` deletes the created flow via the REST API so no orphan flows are left behind.

---

## Tags

`@release` `@stable` `@workspace` `@components`

---

## Step by step

**beforeEach (all tests)**
1. `setupBlankFlow(page)` — create a blank flow via the REST API and open it (avoids the UI-creation 500 race; returns the flow id for cleanup).
2. Assert the canvas starts empty: `.react-flow__node` has count `0`.

**Test 1 — Backspace key**
1. Add a Chat Input via the sidebar (`sidebar-search-input` + `add-component-button-chat-input`); assert one `.react-flow__node`.
2. Click the node to select it, press `Backspace`, assert zero `.react-flow__node`.

**Test 2 — node options menu**
1. Add a Chat Input (same as above); assert one `.react-flow__node`.
2. Click `icon-MoreHorizontal` (the node's `...` button), then `icon-Delete` (the menu's Delete item), assert zero `.react-flow__node`.

**Test 3 — marquee box selection**
1. Add a Chat Input and a Chat Output; assert count goes `1` then `2`.
2. Click `.react-flow__pane` to deselect (the last-added node is auto-selected, which would skew the marquee).
3. Compute the bounding box that encloses all nodes; Shift+drag a marquee (padded by 60 px so it starts on empty canvas) across them with `page.mouse` + `page.keyboard.down("Shift")`.
4. Press `Backspace`, assert zero `.react-flow__node`.

**afterEach (all tests)**
1. Navigate to `/` (so background polling does not 404 on the deleted flow), then `DELETE /api/v1/flows/{id}`.

---

## Validation criterion

| Test | Criterion |
|---|---|
| beforeEach | Canvas has `0` `.react-flow__node` after the blank flow opens |
| Backspace | `1` node after add; `0` nodes after select + `Backspace` |
| Options menu | `1` node after add; `0` nodes after `...` → Delete |
| Marquee | `2` nodes after adding both; `0` nodes after marquee-select + `Backspace` |

---

## External dependencies

- React Flow canvas — `.react-flow__node` (every node) and `.react-flow__pane` (empty-canvas background). Renaming or restructuring these breaks node counting and the deselect click.
- Sidebar add affordance — `sidebar-search-input` and `add-component-button-<name>` (`chat-input`, `chat-output`). Used to seed the nodes to delete.
- Node options menu — `icon-MoreHorizontal` (the `...` button) and `icon-Delete` (the Delete menu item). Neither the button nor the menu item exposes a dedicated test ID, so the test targets these inner icons.
- Keyboard deletion — React Flow's delete handler must accept `Backspace`/`Delete` on selected nodes; multi-selection must respond to the Shift+drag marquee (`selectionKeyCode = Shift`).
- `tests/helpers/flows/setup-blank-flow.ts` — API-based flow creation and the `flowId` used for cleanup.

---

## What this test does not cover

- Deleting an edge/connection between components (separate concern).
- Deleting a node that participates in an edge (edge cleanup on node removal).
- Undo/redo of a deletion.
- Multi-selection by individually Shift+clicking nodes (the components added via the `+` button stack at the same position, so only marquee selection is exercised here).
- Multi-selection followed by copy/paste — exercised only by the inherited, unvalidated `flow-functionality/canvas-multiselect.spec.ts` (a cleanup/consolidation candidate).

---

## Preconditions

- Langflow running at `PLAYWRIGHT_BASE_URL`.
- No model provider credentials required (deterministic, no LLM).
- Default Playwright Desktop Chrome viewport.

---

## Notes

- Sibling references: `core-components/componentHoverAdd.spec.ts` and `customComponentAdd.spec.ts` (adding a component to the canvas).
- The "add a component" mechanic is a small local helper (`addComponent`) inside the spec — kept local because here the component is incidental; promoting it to a shared helper is deferred until a real cross-spec need.
- Each test creates its own flow and deletes it in `afterEach`, so the suite leaves no orphan flows.
- Validated by stepping through `--debug`; node-count assertions (`1 → 0`, `2 → 0`) confirm the delete actually removed nodes rather than passing on an already-empty canvas.
