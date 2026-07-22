# Edit Node Name & Description — §12.2 View and Edit Flow

**Last validated:** Langflow 1.11.x (nightly `1.11.0.dev46`)

---

## What this test validates *(required)*

Validates editing a node's **name** and **description** inside the flow editor —
the in-canvas rename/annotate flow that is part of "View and Edit Flow" (§12.2).
The test exercises every commit/discard affordance the editor exposes:

- **Publish / Save button** commits the change.
- **Enter** commits the change.
- **Escape** discards the in-progress edit while leaving the last committed
  value intact.

If this breaks, users cannot label the building blocks of a flow — edits are
lost, or the commit/discard affordances stop honoring Save/Enter vs Escape.

---

## Tags *(required)*

`@stable` `@release` `@workspace` `@components`

`@workspace` — canvas node editing. `@components` — operates on a node's
configuration surface.

---

## Step by step *(required)*

Bootstrap the app (`awaitBootstrapTest`), open a blank flow, and add a Custom
Component. Every flow this page creates is captured from its
`POST /api/v1/flows → 201` response and deleted id-scoped in `afterEach`.

1. Add a Custom Component (`sidebar-custom-component-button`) and select the node
   (`div-generic-node`).
2. Open the editor (`node-edit-name-description-button`); fill the title input
   (`input-title-<current name>`) + the description `textarea`; commit via
   `publish-button` → the new name and description render on the node
   (count = 1).
3. Repeat with fresh values, committing via `node-save-name-description-button`
   (second edit persists the same way).
4. Edit the name and press **Enter** → the new name renders (commit via Enter).
5. Edit name + description and press **Escape** → the discarded values do **not**
   render (count = 0) while the previously-committed values remain (count = 1).
6. Edit again, press **Escape** → committed values render; discarded ones stay
   absent.

---

## Validation criterion *(required)*

- **Commit (Publish / Save / Enter):** the edited name and description are
  rendered on the canvas — `getByText(value).count()` = 1 (node only).
- **Discard (Escape):** the in-progress value is **not** rendered
  (`count()` = 0) and the last committed value is unchanged.

Each assertion is a hard `getByText(<random value>).count()` against a unique
random string, so a mutated assertion (wrong count, commit vs discard swapped)
fails deterministically.

---

## External dependencies *(required)*

- `data-testid="sidebar-custom-component-button"` — add a Custom Component.
- `data-testid="div-generic-node"` — the node on the canvas.
- `data-testid="node-edit-name-description-button"` — open the node editor.
- `data-testid="input-title-<name>"` — the title input; the testid carries the
  node's **current** displayed name (dynamic per edit).
- `data-testid="textarea"` — the description field.
- `data-testid="publish-button"`, `data-testid="node-save-name-description-button"`
  — commit affordances.
- No API key — the Custom Component is added and edited, never executed.

---

## What this test does not cover *(optional)*

- Flow-level name/description (covered by `flowSettings.spec.ts`) — this spec is
  node-level.
- Character-limit enforcement on the node fields.
- Persistence across an exit / re-open cycle.

---

## Notes *(optional)*

- **dev46 migration (issue #818).** The nightly removed the inspect-panel on/off
  toggle (`canvas_controls_dropdown_toggle_inspector`) and standardized on the
  node inspector side-panel. The previously-separate "inspect panel disabled"
  test became redundant with this one (its distinguishing scenario no longer
  exists) and was removed; this test now uses the current node-rename testids
  (`node-edit-name-description-button`, `input-title-<name>`, `textarea`,
  `publish-button`, `node-save-name-description-button`) and `count = 1`
  (no panel duplication).
- **Flow cleanup.** ids captured from `POST /api/v1/flows → 201` (Pattern-A
  accumulator; `page.url()` races the bootstrap flow id — #490/#681) and deleted
  in `afterEach`.
- Validated on `1.11.0.dev46` (2026-07-19): 1 passed (~47s), `--workers=1
  --retries=0`, 0 orphan flows.
