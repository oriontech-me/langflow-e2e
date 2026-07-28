# Spec: Canvas — Deleting Sticky Notes

**Test file:** `tests/tests-automations/regression/flow-functionality/canvas-sticky-note-delete.spec.ts`

## What this test validates

Covers the `§15.8 — Delete sticky note` checklist item, through both affordances
and with the persisted flow as the final witness — a note removed from the
canvas but left in the flow would reappear on reload.

Three tests, each on its own blank flow:

1. **Delete from the options menu** — selecting a note exposes the node toolbar;
   `icon-MoreHorizontal` → `Delete` removes it from the canvas and from the
   persisted flow.
2. **Delete with Backspace** — the same outcome from the keyboard, on a selected
   note.
3. **Deleting one of two notes leaves the other** — with two notes on the
   canvas, deleting one drops the count to exactly 1 in the DOM and exactly one
   `noteNode` remains in the flow. This is what makes the assertion about
   *deletion* rather than about *clearing the canvas*. Two notes added in a row
   land stacked on top of each other, so the second is dragged clear first —
   otherwise the top note intercepts the click meant for the bottom one.

Sibling coverage, deliberately not duplicated here:

- `ui-ux/sticky-notes.spec.ts` — adding, colouring and resizing notes.
- `ui-ux/edit-sticky-note-text.spec.ts` — editing note text.
- `core-components/componentDelete.spec.ts` — deleting **components** (not
  notes) through the same two affordances.

### Why the inherited version was red

Like every inherited sticky-note spec, its three tests clicked
**`sidebar-nav-add_note`** to create the note. That testid no longer exists on
`1.12.0.dev8` — the affordance is now the canvas control
`canvas-add-note-button` — so all three timed out before reaching any deletion
logic. The file also created a flow per test and deleted none.

## Tags

`@stable` `@release` `@workspace` `@ui-ux`

## Validation criterion

| Step | Criterion |
|---|---|
| Blank flow + note added | `note_node` count is 1, and the flow holds exactly one `noteNode` (polled — the canvas autosave is debounced) |
| Select note → `icon-MoreHorizontal` → `Delete` | `note_node` count is 0; the flow holds zero `noteNode` |
| Select note → `Backspace` | same two assertions |
| Two notes, dragged apart | their bounding boxes do not overlap (precondition — stacked notes make the click ambiguous) |
| Delete one of the two | `note_node` count is 1 (not 0); the flow holds exactly one `noteNode` |

Non-criteria (deliberate):

- **No undo assertion.** `Ctrl+Z` after a delete belongs to the canvas-shortcut
  contract (`ui-ux/langflowShortcuts.spec.ts`, §15.4).
- **The remaining note is identified by count, not by content.** Two freshly
  added notes are indistinguishable without typing into them, and text editing
  is another spec's subject; the count is the honest observable here.

## External dependencies

- `src/frontend/src/pages/FlowPage/components/PageComponent` —
  `canvas-add-note-button`.
- `src/frontend/src/CustomNodes/NoteNode` + the shared node toolbar —
  `note_node`, `icon-MoreHorizontal`, the `Delete` option.
- `GET /api/v1/flows/{id}` — nodes with `type === "noteNode"`.

No provider API key and no LLM call. Each test creates one flow via
`setupBlankFlow` and deletes exactly that id in `afterEach` (`deleteFlow`).

## Last validated

1.12.x (nightly `1.12.0.dev8`)
