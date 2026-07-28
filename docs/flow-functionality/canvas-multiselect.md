# Spec: Canvas — Box Selection of Multiple Components

**Test file:** `tests/tests-automations/regression/flow-functionality/canvas-multiselect.spec.ts`

## What this test validates

Covers the `§15.4 — Select multiple components via box selection` checklist
item: a Shift+drag marquee over the canvas must select every node it encloses.

Two tests on a blank flow holding **two non-overlapping, non-singleton** nodes
(Prompt Template + Chat Output, moved apart before the marquee):

1. **The marquee selects both nodes** — starting from an unselected canvas,
   Shift+dragging a rectangle around both takes `.react-flow__node.selected`
   from 0 to 2. A marquee drawn away from the nodes leaves the count at 0, so
   the assertion is causal rather than "something got selected".
2. **The selection is actionable** — pressing `Delete` with both selected clears
   the canvas (`.react-flow__node` count 0). This is the multi-select
   counterpart of the single-node delete and proves the selection reached the
   canvas action layer.

### Why the inherited version was red

Test 1 asserted box selection **indirectly**: it copied the selection with
`Ctrl+C`, pasted with `Ctrl+V` and expected `2 originals + 2 pasted = 4` nodes.
It got **3**, deterministically — one of its two fixture components was
`Chat Input`, a **singleton** that cannot be copy/pasted (see
`core-components/singleton-components.spec.ts`), so only one node ever pasted.
The rewrite asserts the selection **directly** (`.react-flow__node.selected`),
which is both the honest observable and immune to the singleton rule.

## Tags

`@stable` `@release` `@workspace` `@ui-ux`

## Validation criterion

| Step | Criterion |
|---|---|
| Blank flow + two components added and separated | `.react-flow__node` count is exactly 2, and their bounding boxes do not overlap |
| Canvas unselected | `.react-flow__node.selected` count is 0 |
| Shift+drag a marquee that encloses neither node | `.react-flow__node.selected` stays 0 (negative control — the marquee itself does not select) |
| Shift+drag a marquee enclosing both | `.react-flow__node.selected` count becomes 2 |
| Press `Delete` | `.react-flow__node` count becomes 0 |

Non-criteria (deliberate):

- **No copy/paste in the assertions.** Clipboard round-trips depend on the
  singleton rule and on clipboard permissions; keyboard Copy/Paste is covered by
  `ui-ux/langflowShortcuts.spec.ts` and
  `flow-functionality/canvas-copy-paste.spec.ts`.
- **The two nodes are separated by an explicit drag before the marquee.** Two
  components added from the sidebar stack ~10 px apart on 1.12, and a marquee
  over stacked nodes cannot distinguish "selected both" from "selected the top
  one twice".
- **No `if (box)` guard around the drag.** The inherited version wrapped the
  whole marquee in `if (firstBox && secondBox)`, which silently skips the action
  when a bounding box is unavailable; the rewrite asserts the boxes exist.
- **Marquee-delete of a whole flow already has a sibling** —
  `core-components/componentDelete.spec.ts` covers "delete multiple selected
  components" (§15.4, already `[x]`). Test 2 here is scoped to proving *this*
  selection is actionable, and the doc records the overlap.

## External dependencies

- ReactFlow's selection-on-drag behavior, keyed by `Shift`
  (`selectionKeyCode="Shift"` in the canvas setup).
- `.react-flow__node.selected` — the class ReactFlow puts on selected nodes.
- Sidebar `add-component-button-prompt-template`,
  `add-component-button-chat-output`.

No provider API key and no LLM call. The spec creates one flow via
`setupBlankFlow` and deletes exactly that id in `afterEach` (`deleteFlow`); the
inherited version leaked one flow per test.

## Last validated

1.12.x (nightly `1.12.0.dev8`)
