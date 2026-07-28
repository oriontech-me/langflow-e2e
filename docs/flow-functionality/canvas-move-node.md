# Spec: Canvas — Move a Component Within the Canvas

**Test file:** `tests/tests-automations/regression/flow-functionality/canvas-move-node.spec.ts`

## What this test validates

Covers the `§15.4 — Move component within canvas` checklist item: dragging a
node by its title must move it on the canvas **and** persist the new coordinates
to the backend, so reopening the flow finds the node where the user left it.

One test on a blank flow holding a single **Prompt Template** node:

1. Read the node's starting position from both layers — `style.transform` on the
   `.react-flow__node` element and `position` in `GET /api/v1/flows/{id}`.
2. Drag the node by its title (`title-Prompt Template`) with a measured offset.
3. Assert the DOM transform changed by approximately that offset, and then poll
   the flows API until the persisted `position` matches the DOM — the autosave
   round-trip is the real assertion.

The cross-layer check is what makes this a regression test rather than a DOM
tautology: a UI-only move that never reaches `PATCH /api/v1/flows/{id}` looks
correct on screen and loses the layout on reload. Measured on `1.12.0.dev8`, the
two agree exactly (DOM `translate(541px, 181px)` ↔ API `{x: 541, y: 181}`).

Sibling coverage, deliberately not duplicated here:

- `ui-ux/sidebar-add-component.spec.ts` — dragging a component **from the
  sidebar** onto the canvas (the node lands at the drop position). That is
  creation, not movement of an existing node.
- `flow-functionality/dragAndDrop.spec.ts` — dropping a flow **file** onto the
  dashboard to import it. Unrelated despite the name.

## Tags

`@stable` `@release` `@workspace` `@ui-ux`

## Validation criterion

| Step | Criterion |
|---|---|
| Blank flow + Prompt Template added | `.react-flow__node` count is exactly 1 |
| Starting state | the node's `style.transform` parses to `(x0, y0)`; `GET /api/v1/flows/{id}` reports the same `position` |
| Drag the title by `(dx, dy)` | the node's `style.transform` parses to approximately `(x0+dx, y0+dy)` — tolerance accounts for canvas zoom |
| Persistence | polling `GET /api/v1/flows/{id}` converges on a `position` matching the post-drag DOM coordinates (within the same tolerance) |

Non-criteria (deliberate):

- **Exact pixel equality is not asserted** — the canvas may be at a zoom level
  other than 1, so the drag delta in screen pixels is not the delta in flow
  coordinates. The assert uses a tolerance and, crucially, requires DOM and API
  to agree with **each other**.
- **The drag is issued as `mouse.move` → `down` → `move(steps)` → `up`**, not
  `locator.dragTo`. ReactFlow needs intermediate move events to start a node
  drag; a single jump can be swallowed.
- **The node is dragged by its title**, never by its body — a body-center press
  can land on an interactive field inside the node and start editing instead of
  dragging (same trap the delete helpers document).
- **A single-node canvas** — with overlapping nodes the topmost one captures the
  press, which silently moves the wrong node (observed during scouting: two
  components added from the sidebar stack 10 px apart).

## External dependencies

- `src/frontend/src/CustomNodes/GenericNode/index.tsx` — the node title drag
  handle (`title-{Component Name}`).
- ReactFlow's node drag → `PATCH /api/v1/flows/{id}` autosave path.
- Sidebar `add-component-button-prompt-template` — the fixture node.

No provider API key and no LLM call. The spec creates one flow via
`setupBlankFlow` and deletes exactly that id in `afterEach` (`deleteFlow`).

## Last validated

1.12.x (nightly `1.12.0.dev8`)
