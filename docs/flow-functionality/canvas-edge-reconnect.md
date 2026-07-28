# Spec: Canvas — Deleting and Recreating an Edge

**Test file:** `tests/tests-automations/regression/flow-functionality/canvas-edge-reconnect.spec.ts`

## What this test validates

Covers two `§15.3` checklist items — `Delete edge/connection` and
`Reconnect existing edge` — with the persisted flow as the final witness: an
edge removed from the canvas but left in `data.edges` reappears on reload, and a
recreated edge that never persists is lost the same way.

Two tests on a blank flow holding Chat Input → Chat Output:

1. **Delete an edge from its context menu** — right-clicking
   `edge-context-menu-trigger` opens the edge menu; `context-menu-item-destructive`
   removes the edge from the canvas and from `data.edges`.
2. **Recreate the edge after deleting it** — clicking the same two handles again
   restores exactly one edge, in the DOM and in the flow. Deleting and
   recreating in one test is what makes this about *reconnecting* rather than
   about a fresh connection (which `canvas-connect-components.spec.ts` covers).

## Tags

`@stable` `@release` `@workspace` `@ui-ux`

## Validation criterion

| Step | Criterion |
|---|---|
| Blank flow + Chat Input + Chat Output connected | `.react-flow__edge` count is 1 and `GET /api/v1/flows/{id}` reports `data.edges.length === 1` (polled — the autosave is debounced) |
| Right-click `edge-context-menu-trigger` | the destructive menu item is visible |
| Click `context-menu-item-destructive` | `.react-flow__edge` count is 0 and `data.edges` is empty |
| Click the source handle then the target handle again | `.react-flow__edge` count is back to 1 and `data.edges.length === 1` |

Non-criteria (deliberate):

- **Dragging an edge endpoint onto a different handle is not covered.** The
  checklist item is satisfied by delete-then-reconnect; endpoint dragging is a
  distinct ReactFlow gesture with no §15.3 bullet of its own.
- **The inherited "deletable and reconnectable multiple times" loop was dropped.**
  Repeating the same two assertions N times adds runtime, not signal — one
  delete/recreate cycle either works or does not.
- **The edge is located through `edge-context-menu-trigger`, not by edge id** —
  the id format is an implementation detail.

## External dependencies

- `edge-context-menu-trigger` (rendered per edge) and
  `context-menu-item-destructive` in the edge context menu.
- Handle testids `handle-chatinput-noshownode-chat message-source` and
  `handle-chatoutput-noshownode-inputs-target`.
- `GET /api/v1/flows/{id}` — `data.edges`.

No provider API key and no LLM call. Each test creates one flow via
`setupBlankFlow` and deletes exactly that id in `afterEach` (`deleteFlow`); the
inherited file had no cleanup at all.

## Last validated

1.12.x (nightly `1.12.0.dev8`)
