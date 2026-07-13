# Manual Save With Auto-Save Disabled — §12.2 View and Edit Flow

**Last validated:** Langflow 1.11.x

---

## What this test validates *(required)*

Validates the flow persistence contract when **auto-saving is turned off**
(`/api/v1/config` → `auto_saving: false`): unsaved graph edits are **discarded**
on exit unless the user explicitly saves, and an explicit **save persists** the
edits across an exit / re-open cycle.

With auto-save off, the editor must:

1. **Discard on "Exit Anyway"** — after adding a component without saving,
   leaving the flow via the back button raises an unsaved-changes dialog;
   choosing **Exit Anyway** discards the edit (the re-opened flow has zero
   nodes).
2. **Persist on save** — adding a component and then saving (via the on-canvas
   **Save** button or the exit dialog's **Save And Exit**) persists it; the
   re-opened flow shows the saved component.
3. **Persist a subsequent edit** — adding a second core component (Chat Output)
   and saving again persists both; the re-opened flow shows **two** nodes
   (Chat Input + Chat Output).

If this breaks, the auto-save-off workflow is unsafe — either edits are lost
when the user meant to save, or discarded edits silently persist.

---

## Tags *(required)*

`@stable` `@release` `@api` `@database` `@components`

`@api` — mocks `/api/v1/config`. `@database` — asserts server-side persistence
across a full exit/re-open. `@components` — drives a canvas component.

---

## Step by step *(required)*

Setup: mock `/api/v1/config` to `auto_saving: false`, bootstrap the app
(`awaitBootstrapTest`), open a blank flow. Every flow this page creates is
captured from its `POST /api/v1/flows → 201` response and deleted id-scoped in
`afterEach`.

1. Add a **Chat Input** component to the canvas (sidebar search → hover entry →
   `add-component-button-chat-input`)
2. Assert the on-canvas **`save-flow-button`** is enabled (auto-save off ⇒ manual
   save is available)
3. Leave via the back button (`icon-ChevronLeft`); the unsaved-changes dialog
   ("Unsaved changes will be permanently lost.") appears — click **Exit Anyway**
4. Re-open the flow (via the flow card's open button); assert the canvas has
   **0** nodes (`div-generic-node` count = 0) — the edit was discarded
5. Add the Chat Input component again (hover the sidebar entry →
   `add-component-button-chat-input`)
6. Leave via the back button; click **Save And Exit**
7. Re-open the flow; assert **`title-Chat Input`** is visible — the edit persisted
8. Add a **Chat Output** component (hover the sidebar entry →
   `add-component-button-chat-output`), click **`save-flow-button`** (the
   on-canvas manual save), leave via the back button. The exit-guard dialog is
   timing-dependent here — if the manual save settled, the exit is clean;
   otherwise **Save And Exit** appears and is clicked. Either path persists.
9. Re-open the flow; assert both `title-Chat Input` and `title-Chat Output` are
   visible and `div-generic-node` count = **2**

---

## Validation criterion *(required)*

- After **Exit Anyway** on an unsaved change: the re-opened flow's
  `div-generic-node` count is **0** (discard worked).
- After a **save**: the re-opened flow shows `title-Chat Input`.
- After the second save: both `title-Chat Input` and `title-Chat Output` are
  visible and `div-generic-node` count is exactly **2** (both edits persisted
  server-side).

Each observable is a hard count/visibility on the re-opened flow — a mutated
assertion (wrong count, wrong discard) fails deterministically. The only
conditional (the third exit's dialog) handles a genuinely timing-optional
confirmation and is gated by the `div-generic-node` count === 2 assert, which
fails if either save did not persist (see Notes on the hardening).

---

## External dependencies *(required)*

- `/api/v1/config` — mocked to `auto_saving: false` (the surface under test).
- `data-testid="save-flow-button"` — on-canvas manual save (present only when
  auto-save is off).
- `data-testid="icon-ChevronLeft"` — back-to-list navigation.
- Exit dialog: **"Exit Anyway"** (discard) / **"Save And Exit"** (persist; its
  primary button carries `data-testid="replace-button"`).
- `data-testid="input_outputChat Input"` / `add-component-button-chat-input` /
  `input_outputChat Output` / `add-component-button-chat-output` /
  `sidebar-search-input` — Chat Input / Chat Output sidebar entries, add buttons,
  search. Adds use the draggable wrapper hover → add button (the sidebar row is
  briefly `pointer-events-none`; dragging it is unreliable).
- `data-testid="title-Chat Input"` / `div-generic-node` — node presence on canvas.
- `data-testid="list-card"` / `flow-name-div` / `list-card-open-button` —
  re-open a flow from the list (the `/flows` a11y refactor made `flow-name-div`
  `pointer-events-none`; open via the card overlay button — Langflow #13891).
- No API key — the Chat Input / Chat Output components are added to the graph,
  never executed.

---

## What this test does not cover *(optional)*

- Auto-save **on** (the default) — a separate behavior.
- Renaming / deleting flows.
- Save via keyboard shortcut (Ctrl/Cmd+S).

---

## Notes *(optional)*

- **Hardening for promotion.** The pre-promotion spec left `New Flow` behind
  (no cleanup — confirmed 4 leaked flows on the instance) and used silent
  bypasses: a `try/catch` that logged "skipping dialog confirmation" and
  `if (replaceButton) {…}` / `if (saveExitButton) {…}` guards that could skip a
  save/exit step without failing. Live scouting on 1.11.0.dev41 confirmed all
  the first two exits are deterministic (the unsaved-changes dialog always
  appears; the save button is `replace-button` with text "Save And Exit"), so
  those guards became explicit asserts + clicks. The **third** exit is genuinely
  timing-optional — the on-canvas `save-flow-button` sometimes settles the save
  before the back-navigation, yielding a clean exit with no dialog — so it keeps
  a single conditional for the optional dialog, gated by the final
  `div-generic-node` count === 2 (the force-fail gate that proves persistence
  regardless of path).
- **Flow cleanup.** ids are captured from `POST /api/v1/flows → 201`
  (Pattern-A accumulator; `page.url()` races the bootstrap flow id — #490/#681)
  and deleted in `afterEach`.
- **Core I/O components (Chat Input + Chat Output)** — they render on the canvas
  without an API key and without a run, keeping the test hermetic; neutral core
  components avoid the model-provider connotation of the pre-promotion NVIDIA
  node they replaced. The second edit uses Chat Output rather than a second Chat
  Input because Langflow hides a component's quick-add button once a copy is on
  the canvas.
