# Sticky Note — Edit Text

**Last validated:** Langflow 1.11.x

---

## What this test validates

Validates that a user can open a sticky note that already contains text, replace
that text with different content, and see the canvas render exclusively the new
text — not a mix of old and new.

The existing `sticky-notes.spec.ts` only fills an empty note (the Add note path).
This test covers the distinct Edit note journey: fill a note, commit it, reopen it,
replace the content, commit again, and assert the rendered note shows only the new
text.

If this breaks, users who edit an existing note may see the old text persist,
re-appear after save, or get appended to instead of replaced.

---

## Tags

`@stable` `@release` `@workspace`

---

## Step by step

1. `awaitBootstrapTest(page, { skipModal: true })` — reach the authenticated dashboard
2. `setupBlankFlow(page)` — create and open an empty canvas; capture `flowId` for cleanup
3. `adjustScreenView(page, { numberOfZoomOut: 3 })` — zoom out so the note fits in viewport
4. Click `canvas-add-note-button` — note appears immediately on canvas
5. Assert `note_node` is visible
6. Double-click `generic-node-desc` — textarea opens, value is empty
7. `textarea.fill('Original note content')` — type initial text
8. Click `rf__wrapper` + press Escape — commit; wait for `textarea` count to reach 0
9. Assert `generic-node-desc.innerText()` contains "Original note content"
10. Double-click `generic-node-desc` — textarea reopens with pre-loaded original text
11. `textarea.clear()` then `textarea.fill('Edited note content')` — replace text
12. Click `rf__wrapper` + press Escape — commit; wait for `textarea` count to reach 0
13. Assert `generic-node-desc.innerText()` contains "Edited note content"
14. Assert `generic-node-desc.innerText()` does NOT contain "Original note content"
15. `afterEach`: `DELETE /api/v1/flows/${flowId}` — clean up the test flow

---

## Validation criterion

- After the first commit: `generic-node-desc` inner text contains "Original note content"
- After the second commit:
  - `generic-node-desc` inner text contains "Edited note content"
  - `generic-node-desc` inner text does NOT contain "Original note content"

The dual assertion on the final state proves the edit replaced the content rather than
appending to it.

---

## External dependencies

- `src/frontend/src/CustomNodes/NoteNode/` — NoteNode / generic-node-desc rendering
  and the double-click handler that toggles edit mode
- `data-testid="canvas-add-note-button"` — toolbar button that places a sticky note
- `data-testid="note_node"` — the sticky note node container on the React Flow canvas
- `data-testid="generic-node-desc"` — rendered markdown area (also `.generic-node-desc-text`)
- `data-testid="textarea"` — edit-mode textarea
- `data-testid="rf__wrapper"` — React Flow canvas wrapper; clicking it commits the edit

No API key, provider, or LLM execution required — pure canvas UI.

---

## What this test does not cover

- Adding a sticky note for the first time (covered by `sticky-notes.spec.ts`)
- Changing note color, resizing, duplicating, copying, or deleting notes
- Markdown rendering fidelity (plain text used to keep assertions simple)
- Persistence across page reload

---

## Notes

- `canvas-add-note-button` replaced the defunct `sidebar-nav-add_note` testid; clicking
  the button places the note immediately — no separate canvas click is required.
- `rf__wrapper` is the stable commit target; it maps to the React Flow pane background
  and consistently blurs the textarea, triggering the save handler.
- `textarea.clear()` + `textarea.fill()` is used instead of `fill()` alone for explicit
  intent clarity; both are equivalent at the React level.
