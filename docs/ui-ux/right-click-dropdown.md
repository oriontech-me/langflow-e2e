# Spec: Canvas — Right-Click Context Menu on a Component

**Test file:** `tests/tests-automations/regression/ui-ux/right-click-dropdown.spec.ts`

## What this test validates

Covers the `§15.9 — Context menu via right-click on component` checklist item:
a single right-click on a canvas node must (a) select that node, exactly like a
left-click would, and (b) open the node's options menu immediately — no prior
left-click, no hover on the toolbar's `...` button.

Two independent tests on a blank flow holding a single **Prompt Template** node:

1. **Right-click opens the menu and selects the node** — starting from an
   unselected canvas, one right-click on the node makes it `.selected` and opens
   the options menu (`role="listbox"`, `data-state="open"`) with its full ordered
   item contract: `Save`, `Duplicate`, `Copy`, `Docs`, `Minimize`, `Freeze`,
   `Download`, `Delete`. A single `Escape` closes the menu **and** clears the
   node selection — measured on `1.12.0.dev8`; `Escape` is also the canvas
   deselect shortcut (§15.4), and one keypress performs both.
2. **A menu item picked from the right-click menu acts on that node** —
   reopening the menu and choosing `Duplicate` adds exactly one node to the
   canvas (1 → 2) and closes the menu. This proves the right-click path is wired
   to the real actions, not just rendering a decorative popover.

The menu item set is **component-dependent** — `Freeze` renders for Prompt
Template but not for Chat Input / Language Model on `1.12.0.dev8`. The exact
ordered list is therefore asserted for **Prompt Template only**; that component
is the spec's fixture and is added deterministically from the sidebar.

Sibling coverage, deliberately not duplicated here:

- `core-components/componentDelete.spec.ts` — deleting via the toolbar `...`
  menu (`icon-MoreHorizontal` → `icon-Delete`), §15.4.
- `ui-ux/minimize.spec.ts` — Minimize/Expand through the toolbar menu, §15.4.
- `flow-functionality/canvas-copy-paste.spec.ts` — Copy/Paste by keyboard, §15.4.

## Tags

`@stable` `@release` `@components` `@ui-ux`

## Validation criterion

| Step | Criterion |
|---|---|
| Blank flow + Prompt Template added | `.react-flow__node` count is exactly 1 |
| Canvas unselected | `.react-flow__node.selected` count is 0 (proves the next assert is caused by the right-click) |
| Right-click the node | `.react-flow__node.selected` count becomes 1 |
| Menu opened | `[data-radix-popper-content-wrapper] [role="listbox"]` is visible with `data-state="open"` |
| Menu contract | its `role="option"` items are, in order: `Save`, `Duplicate`, `Copy`, `Docs`, `Minimize`, `Freeze`, `Download`, `Delete` (8 items) |
| `Escape` | the `role="listbox"` menu is detached AND `.react-flow__node.selected` drops back to 0 (one keypress closes the menu and deselects) |
| Right-click → `Duplicate` | node count goes 1 → 2 and the menu closes |

Non-criteria (deliberate):

- **`Save` is never clicked.** It writes the node into the user's saved-component
  library (and can raise a replace-confirmation dialog), i.e. account-wide state
  that would leak into every other spec. The previous version of this test
  clicked it; the rewrite asserts its presence only.
- **`more-options-modal` is not used as the "menu is open" signal.** On
  `1.12.0.dev8` that testid is an always-present, empty `div` (the Radix `Select`
  trigger) that reports `data-state="closed"` **while the right-click menu is
  open** — waiting for it passes on a closed menu, which is a false green. The
  previous version of this test gated on exactly that selector.
- **`Duplicate` and `Copy` share the testid `copy-button-modal`** (upstream
  wart). Items are therefore located by `role="option"` + text, never by testid.
- **Singleton components cannot be duplicated.** `Duplicate` on Chat Input /
  Webhook is a documented no-op (see `core-components/singleton-components.spec.ts`),
  which is why the fixture node is a Prompt Template.

### Canvas (pane) right-click — no product surface on 1.12.0.dev8

The sibling checklist item `§15.9 — Context menu via right-click on canvas`
has **no surface to test** on this build, so it stays `[~]` instead of getting a
spec (same treatment as the §15.1 sidebar-tooltip item, issue #937). Measured
live on `1.12.0.dev8`:

- A right-click on `.react-flow__pane` (empty canvas) dispatches a `contextmenu`
  event that reaches `document` with `defaultPrevented === false` — Langflow
  installs no pane handler, so the **browser's native** menu is what opens.
- Zero `[role="menu"]`, `[role="listbox"]` and `[data-radix-popper-content-wrapper]`
  elements appear after that right-click.
- Same result with a node selected (2 events, both unprevented), so it is not a
  selection-scoped menu either. ReactFlow's `onPaneContextMenu` /
  `onSelectionContextMenu` strings exist in the bundle only because the library
  ships them; Langflow does not wire them.

Edges are the exception and belong to §15.3: each edge renders an
`edge-context-menu-trigger` (a left-click affordance, not a right-click menu).

## External dependencies

- `src/frontend/src/CustomNodes/GenericNode/index.tsx` — the node's
  `onContextMenu` handler that selects the node and opens the options menu.
- `src/frontend/src/CustomNodes/GenericNode/components/NodeStatus` /
  `NodeToolbarComponent` — the options menu items and the
  `save-button-modal` / `copy-button-modal` / `docs-button-modal` /
  `minimize-button-modal` / `download-button-modal` testids.
- Sidebar `add-component-button-prompt-template` — the fixture node.

No provider API key and no LLM call. The spec creates one flow via
`setupBlankFlow` and deletes exactly that id in `afterEach` (`deleteFlow`), so it
leaves no flow behind.

## Last validated

1.12.x (nightly `1.12.0.dev8`)
