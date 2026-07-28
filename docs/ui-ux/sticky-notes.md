# Spec: Canvas — Sticky Notes (Add, Color, Resize)

**Test file:** `tests/tests-automations/regression/ui-ux/sticky-notes.spec.ts`

## What this test validates

Covers three `§15.8` checklist items — `Add sticky note`, `Change sticky note
color` and `Resize sticky note`. Each is asserted in the DOM **and** in the
persisted flow, so a note that renders correctly but never reaches
`PATCH /api/v1/flows/{id}` fails.

Three tests on a blank flow:

1. **Add** — the canvas toolbar button `canvas-add-note-button` places a note:
   `note_node` renders at the default 280×140, and the flow gains exactly one
   node whose `type` is `noteNode`.
2. **Change color** — selecting the note exposes `color_picker`, whose popover
   offers seven options (`amber`, `neutral`, `rose`, `blue`, `lime`,
   `transparent`, `custom`). Picking **rose** paints the note
   (`background-color: hsl(var(--note-rose))` on the `note_node` inline style)
   and persists `data.node.template.backgroundColor === "rose"`.
3. **Resize** — dragging the bottom-right resize handle grows the note beyond
   its default, and the new size persists to the node's top-level
   `width`/`height` (measured 280×140 → 394×224).

Sibling coverage, deliberately not duplicated here:

- `ui-ux/edit-sticky-note-text.spec.ts` — editing the note's text (the §15.8
  item that was already `[x]`).
- `flow-functionality/canvas-sticky-note-delete.spec.ts` — deleting notes.

### Why the inherited specs were red, and what was dropped

All four inherited sticky-note specs (11 tests) failed on `1.12.0.dev8` for a
single reason: they clicked **`sidebar-nav-add_note`**, a testid that no longer
exists — the affordance moved to the canvas controls as
`canvas-add-note-button`. None of them cleaned up either; one baseline run left
**12 orphan flows**.

Consolidating them into this file plus the delete spec dropped
`ui-ux/sticky-notes-dimensions.spec.ts` (340 lines) and
`ui-ux/note-color-picker.spec.ts` (144 lines). What was kept and what went:

| Inherited test | Fate |
|---|---|
| `sticky notes should have consistent 280x140px dimensions` | kept — folded into the **Add** test's default-size assertion |
| `sticky notes should respect resize constraints` | kept — folded into the **Resize** test |
| `user should be able to change note colors using the color picker` | kept — became the **Change color** test, now with the backend assertion |
| `user should be able to interact with sticky notes` | dropped — its substance (typing into a note, the 2500-char counter) belongs to `edit-sticky-note-text.spec.ts` |
| `sticky notes should have larger readable text` | dropped — asserts a `font-size` value; a styling assertion tracking no checklist item |
| `sticky notes should handle overflow with scrollbars` | dropped — asserts `overflow` CSS, same reason |
| `sticky notes should maintain size with content` | dropped — subsumed by the Resize test's explicit size assertions |
| `user should be able to use custom color picker for notes` | dropped — the free-colour widget is a distinct surface; the preset palette plus its persistence is what §15.8 asks for |

## Tags

`@stable` `@release` `@workspace` `@ui-ux`

## Validation criterion

| Step | Criterion |
|---|---|
| Blank flow | `[data-testid="note_node"]` count is 0 |
| Click `canvas-add-note-button` | `note_node` is visible; its box is 280×140; polling `GET /api/v1/flows/{id}` converges on exactly one node with `type === "noteNode"` |
| Select the note → open `color_picker` | all seven `color_picker_button_*` options are visible |
| Pick `color_picker_button_rose` | the `note_node` inline style contains `--note-rose`; the persisted `data.node.template.backgroundColor` is `"rose"` |
| Drag `.react-flow__resize-control.bottom.right.handle` by (+120, +90) | the rendered box is wider **and** taller than 280×140; the persisted top-level `width`/`height` match the rendered size |

Non-criteria (deliberate):

- **Exact resized pixels are not asserted** — only "grew in both axes" and
  "DOM and API agree". The drag delta in screen pixels is not the delta in flow
  units at zoom ≠ 1.
- **The `custom` colour option is asserted present but never opened** — the free
  colour widget is a separate surface (see the table above).
- **`transparent` is not exercised** — it has no positive colour observable to
  assert on.
- **No `font-size` / `overflow` assertions.** Styling values change upstream
  without any user-visible behaviour change; they were the reason two inherited
  specs existed and they track no checklist item.

## External dependencies

- `src/frontend/src/pages/FlowPage/components/PageComponent` — the
  `canvas-add-note-button` canvas control.
- `src/frontend/src/CustomNodes/NoteNode` — `note_node`, its inline
  `background-color`, the `color_picker` toolbar and the
  `color_picker_button_{amber,neutral,rose,blue,lime,transparent,custom}` items.
- ReactFlow `NodeResizer` — `.react-flow__resize-control.bottom.right.handle`.
- `GET /api/v1/flows/{id}` — node `type`, top-level `width`/`height`, and
  `data.node.template.backgroundColor`.

No provider API key and no LLM call. The spec creates one flow via
`setupBlankFlow` and deletes exactly that id in `afterEach` (`deleteFlow`).

## Last validated

1.12.x (nightly `1.12.0.dev8`)
