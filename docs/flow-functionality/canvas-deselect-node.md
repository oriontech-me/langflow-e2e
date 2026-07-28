# Spec: Canvas — Deselecting a Node

**Test file:** `tests/tests-automations/regression/flow-functionality/canvas-deselect-node.spec.ts`

## What this test validates

Covers two `§15.4` checklist items — `Deselect node by clicking on empty canvas
area` and `Deselect node via Escape`. Both are the same contract from two
affordances: a selected node must return to unselected, so the node toolbar and
the canvas shortcuts stop acting on it.

Two tests on a blank flow holding a single **Prompt Template** node:

1. **Click on empty canvas deselects** — select the node (`.react-flow__node.selected`
   count 1), click a point on `.react-flow__pane` away from the node, count
   returns to 0.
2. **`Escape` deselects** — same setup, `Escape` instead of the click.

Both tests assert the selected state **before** acting, so a run where the node
was never selected fails at the setup step instead of passing vacuously on a
canvas that was already empty of selection.

## Tags

`@stable` `@release` `@workspace` `@ui-ux`

## Validation criterion

| Step | Criterion |
|---|---|
| Blank flow + Prompt Template added | `.react-flow__node` count is exactly 1 |
| Click the node | `.react-flow__node.selected` count is 1 (precondition — makes the deselect causal) |
| Click empty canvas / press `Escape` | `.react-flow__node.selected` count is 0 |

Non-criteria (deliberate):

- **The empty-canvas click targets `.react-flow__pane` by position**, not the
  `#react-flow-id` wrapper: the wrapper's coordinate space includes the node
  layer, and a "far away" position computed against it can still land on a node
  after a zoom change.
- **`Escape` also closes an open node context menu** (§15.9,
  `ui-ux/right-click-dropdown.spec.ts`). Here no menu is open, so the test
  isolates the deselect half of that behavior.
- **Node toolbar visibility is not asserted** as a proxy for selection —
  `.react-flow__node.selected` is the state ReactFlow owns; the toolbar is a
  downstream render detail that has moved between releases.

## External dependencies

- ReactFlow's pane-click and `Escape` deselect handling; `.react-flow__node.selected`.
- Sidebar `add-component-button-prompt-template`.

No provider API key and no LLM call. The spec creates one flow per test via
`setupBlankFlow` and deletes exactly that id in `afterEach` (`deleteFlow`); the
inherited version leaked one flow per test.

## Last validated

1.12.x (nightly `1.12.0.dev8`)
