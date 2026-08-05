# Spec: Canvas — Minimize and Expand a Component

**Test file:** `tests/tests-automations/regression/ui-ux/minimize.spec.ts`

## What this test validates

Covers the `§15.4 — Minimize component on canvas` checklist item: the node
options menu must collapse a node to its compact form and restore it, in the DOM
**and** in the persisted flow.

One test on a blank flow holding a single **Prompt Template** node:

1. **Baseline** — the node renders expanded: no `.react-flow__handle.no-show`,
   and the options menu offers `minimize-button-modal`.
2. **Minimize** — after picking it, every handle on that node carries `no-show`,
   the node's rendered height collapses (measured 209 px → 52 px on
   `1.12.0.dev8`), and `GET /api/v1/flows/{id}` reports `data.showNode === false`
   for that node.
3. **Expand** — the menu now offers `expand-button-modal`; picking it clears
   `no-show`, restores the height, and flips `data.showNode` back to `true`.

**The fixture component matters.** `Chat Output` — which the inherited version of
this spec would otherwise be a natural fit for — **ships minimized by default**
on 1.12 (`minimized: true` in `GET /api/v1/all`), so a "minimize it" test would
start in the end state. Prompt Template has `minimized: false` and renders
expanded, making the transition observable in both directions.

### Why the inherited version was red

It searched the sidebar for `Text Input` and waited on
`[data-testid="input_outputText Input"]`, which times out on 1.12.0.dev8:
**`Text Input` is now `legacy: true`** in the component catalog, so it is hidden
from the sidebar unless the legacy toggle is on. This is an intentional product
change, not a regression — the fix is a different fixture component, not enabling
the legacy toggle (that surface is covered by
`core-components/legacy-components-toggle-regression.spec.ts`).

## Tags

`@stable` `@release` `@workspace` `@ui-ux`

## Validation criterion

| Step | Criterion |
|---|---|
| Blank flow + Prompt Template added | `.react-flow__node` count is exactly 1, with `0` handles carrying `no-show` |
| Options menu (expanded node) | `minimize-button-modal` is present |
| After Minimize | every `.react-flow__handle` inside the node carries `no-show`; the node's bounding height is smaller than the expanded height; `GET /api/v1/flows/{id}` → the node's `data.showNode === false` |
| Options menu (minimized node) | `expand-button-modal` is present (the item swaps, it is not a toggle with one testid) |
| After Expand | no handle carries `no-show`; the height is back to the expanded value; `data.showNode === true` |
| Four further minimize/expand cycles (five toggles in total, counting the one above) | each cycle's minimize makes a `no-show` handle visible and each expand brings the `no-show` count back to `0`; after the last cycle `data.showNode` is still `true` on the server |

Non-criteria (deliberate):

- **Exact pixel heights are not asserted** — only "collapsed < expanded" and the
  handle/persistence signals. Node heights shift with upstream styling.
- **The minimize state is read from `data.showNode`, not `node.minimized`.**
  `node.minimized` is the component catalog's **default** (true for Chat Output,
  false for Prompt Template) and does not track the user's action;
  `data.showNode` is what the canvas writes. Confirmed live: after minimizing the
  Prompt Template, `data.showNode` was `false` while `node.minimized` stayed
  `false`.
- **The menu is opened from the node toolbar** (`icon-MoreHorizontal`), the same
  affordance `core-components/componentDelete.spec.ts` uses. Reaching the same
  items by right-click is §15.9's subject
  (`ui-ux/right-click-dropdown.spec.ts`), not repeated here.

### Why the repetition is here (#1290)

The four extra cycles arrived from `ui-ux/general-bugs-minimize-state-error.spec.ts`,
which #1290 **deleted**. That file duplicated everything above with weaker
assertions — a `hide-node-content` count, no geometry, no server truth — and its
distinct contribution was repeating the toggle, which is what the original bug
needed: the state error appeared after several cycles, never on the first one.
Since the steps above already perform one full cycle, the four here make **five**
in total — the deleted file's own loop count, not a reduction of it.

It also carried one assertion that did not come along: `Toolset` being absent from
the node. That is covered more purposefully by
`core-components/general-bugs-component-as-tool-shortcut.spec.ts`, which asserts it
absent *and then present* after enabling tool mode, so nothing was lost by dropping
a bare absence check here.
Moving it here rather than migrating that file keeps one owner for the behaviour
(no-duplication rule), inherits the stronger oracles, and — the practical part —
makes the repetition actually run: the deleted file was not `@stable`, so no
scheduled lane ever executed it, which is also why nobody noticed it had been
broken since Text Output became legacy.

It is a `test.step` inside the existing test rather than a second `test()` so it
reuses the node, the menu helper and the persisted-state reader already set up.

## External dependencies

- `src/frontend/src/CustomNodes/GenericNode/components/NodeToolbarComponent` —
  `icon-MoreHorizontal`, `minimize-button-modal`, `expand-button-modal`.
- `GET /api/v1/all` — `minimized` defaults per component (Chat Output `true`,
  Prompt Template `false`).
- `GET /api/v1/flows/{id}` — `data.showNode` per node.

No provider API key and no LLM call. The spec creates one flow via
`setupBlankFlow` and deletes exactly that id in `afterEach` (`deleteFlow`); the
inherited version created a flow per run and never deleted it.

## Last validated

1.12.x (nightly `1.12.0.dev8`)
