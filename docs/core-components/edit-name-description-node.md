# Edit Node Name & Description — §12.2 View and Edit Flow

**Last validated:** Langflow 1.11.x

---

## What this test validates *(required)*

Validates editing a node's **name** and **description** inside the flow editor —
the in-canvas rename/annotate flow that is part of "View and Edit Flow" (§12.2).
Two rendering modes are covered because the editor exposes two distinct edit
surfaces:

1. **Inspect panel enabled** (default) — the side inspection panel edits the
   node name/description; **Save** or **Enter** commits the change, **Escape**
   discards it.
2. **Inspect panel disabled** — the same edit is done inline on the node
   (title input + description textarea); **Publish / Save** or **Enter** commits,
   **Escape** discards.

If this breaks, users cannot label the building blocks of a flow — edits are
lost, or the commit/discard affordances stop honoring Save/Enter vs Escape.

---

## Tags *(required)*

`@stable` `@release` `@workspace` `@components`

`@workspace` — canvas node editing. `@components` — operates on a node's
configuration surface.

---

## Step by step *(required)*

Both tests bootstrap the app (`awaitBootstrapTest`), open a blank flow, and add
a Custom Component. Every flow this page creates is captured from its
`POST /api/v1/flows → 201` response and deleted id-scoped in `afterEach`.

**Test 1 — inspect panel enabled:**
1. Add a Custom Component (`sidebar-custom-component-button`) and select the node
2. Open the editor (`edit-name-description-button`); fill
   `inspection-panel-name` + `inspection-panel-description`; click
   `save-name-description-button` → both the new name and description render
   (count = 2: node + panel)
3. Repeat with fresh values (second edit persists the same way)
4. Edit the name and press **Enter** → the new name renders (commit via Enter)
5. Edit name+description and press **Escape** → the discarded values do **not**
   render (count = 0) while the previously-committed values remain (count = 2)
6. Edit again, press **Enter** → committed values render; discarded ones stay
   absent

**Test 2 — inspect panel disabled** (`disableInspectPanel`, restored in a
`finally`):
1. Add a Custom Component and select the node
2. Open the inline editor (`node-edit-name-description-button`); fill
   `input-title-*` + `textarea`; click `publish-button` / Enter → committed
   values render (count = 1: node only, no panel)
3. Escape discards the in-progress edit; committed values persist; discarded
   ones are absent

---

## Validation criterion *(required)*

- **Commit (Save / Enter):** the edited name and description are rendered on the
  canvas — `getByText(value).count()` = 2 with the inspect panel (node + panel),
  = 1 without it (node only).
- **Discard (Escape):** the in-progress value is **not** rendered
  (`count()` = 0) and the last committed value is unchanged.

Each assertion is a hard `getByText(<random value>).count()` against a unique
random string, so a mutated assertion (wrong count, commit vs discard swapped)
fails deterministically.

---

## External dependencies *(required)*

- `data-testid="sidebar-custom-component-button"` — add a Custom Component.
- `data-testid="div-generic-node"` — the node on the canvas.
- Inspect panel enabled: `edit-name-description-button`,
  `inspection-panel-name`, `inspection-panel-description`,
  `save-name-description-button`.
- Inspect panel disabled: `node-edit-name-description-button`,
  `input-title-<name>`, `textarea`, `publish-button`,
  `node-save-name-description-button`; toggled via
  `canvas_controls_dropdown_toggle_inspector` (`enable`/`disableInspectPanel`
  helpers).
- No API key — the Custom Component is added and edited, never executed.

---

## What this test does not cover *(optional)*

- Flow-level name/description (covered by `flowSettings.spec.ts`) — this spec is
  node-level.
- Character-limit enforcement on the node fields.
- Persistence across an exit / re-open cycle.

---

## Notes *(optional)*

- **Hardening for promotion.** Added id-scoped flow cleanup (the spec created a
  blank flow per test with no `afterEach` — it leaked a `New Flow`). Test 2
  toggles the global inspect-panel setting; the `enableInspectPanel` restore now
  runs in a `finally` so a mid-test failure cannot leave the setting off for
  sibling specs.
- **Flow cleanup.** ids captured from `POST /api/v1/flows → 201` (Pattern-A
  accumulator; `page.url()` races the bootstrap flow id — #490/#681) and deleted
  in `afterEach`.
- **`getByText` count = 2 vs 1.** With the inspect panel open the value shows in
  both the node and the panel (2); with it disabled only on the node (1). The
  random-string values keep the count unambiguous.
