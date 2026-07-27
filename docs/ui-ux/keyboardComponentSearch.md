# Spec: Component Sidebar — Keyboard Search and Keyboard Add

**Test file:** `tests/tests-automations/regression/ui-ux/keyboardComponentSearch.spec.ts`

## What this test validates

Driving the component sidebar entirely from the keyboard — the
`§15.1 Component Sidebar` item *Keyboard search (keyboard shortcut)*: the `/`
shortcut focuses the search field from the canvas, typing filters the tree,
`Tab` walks into the results, and `Space` / `Enter` add the focused component to
the canvas. `Escape` returns focus to the canvas.

One journey test (the shortcut chain only means something end to end):

1. `/` pressed with the canvas focused moves focus to `sidebar-search-input`
   without typing the character into it (the field stays empty).
2. Typing `chat` filters the tree — `input_outputChat Input` appears and
   `models_and_agentsPrompt Template` does not.
3. `Tab` is pressed until focus lands on `input_output_chat input_draggable`
   (bounded loop, asserted by `data-testid`), then `Space` adds the component:
   the canvas goes to exactly one node whose testid matches
   `/^rf__node-ChatInput-/`.
4. `Tab` walks to `input_output_chat output_draggable` and `Enter` adds it: two
   nodes, the second matching `/^rf__node-ChatOutput-/`.
5. `Escape` with the search focused blurs it (focus leaves
   `sidebar-search-input`).

### What changed from the inherited version

- **Tabbing is targeted, not blind.** The previous version pressed `Tab` three
  times and hoped: the real focus order on 1.12 is
  `sidebar-options-trigger` → `disclosure-<category>` → the first result card, so
  a single extra element upstream would have silently moved `Space` onto a
  different control while the test still passed (the node-count assertion did not
  say *which* component was added). The rewrite walks until the expected testid
  holds focus and asserts the **type** of each added node.
- **Flow cleanup added.** The old version opened a blank flow through the UI after
  `awaitBootstrapTest` and deleted nothing, leaking one flow per run.
- **Escape's real behavior is documented, not assumed:** on 1.12 `Escape` blurs
  the field but does **not** clear its text; the test asserts the blur only.

## Tags

`@stable` `@workspace` `@ui-ux`

## Validation criterion

| Step | Criterion |
|---|---|
| `/` from the canvas | `sidebar-search-input` is focused AND its value is still `""` |
| Type `chat` | `input_outputChat Input` visible, `models_and_agentsPrompt Template` hidden |
| `Tab` walk | focus reaches `input_output_chat input_draggable` within a bounded number of presses |
| `Space` | exactly 1 `.react-flow__node`, testid matching `/^rf__node-ChatInput-/` |
| `Tab` + `Enter` | exactly 2 nodes, the new one matching `/^rf__node-ChatOutput-/` |
| `Escape` | `sidebar-search-input` is not focused |

Non-criterion (deliberate): the search text after adding a component (the field
keeps its query on 1.12) and `Escape` clearing the query (it does not).

## External dependencies

- `sidebar-search-input`, `<category>_<name>_draggable` cards, and the canvas
  `.react-flow__node` / `rf__node-<Type>-<hash>` testids.
- The `/` shortcut binding and the sidebar's `Space`/`Enter` add handlers
  (upstream `SidebarDraggableComponent`). A change to the focus order does not
  break the test (it walks by testid), but removing the keyboard add handler does.
- `POST /api/v1/flows/` — the empty flow the editor opens on.

No provider API key, no LLM, no flow build.

Flow cleanup: the flow is created via the API and deleted by id in `afterEach`.

## Scenarios

### 15.1.5 Keyboard-only component search and add [-]

- **File:** `tests/tests-automations/regression/ui-ux/keyboardComponentSearch.spec.ts`
- **Objective:** prove the sidebar is operable from the keyboard: shortcut →
  filter → focus → add.
- **Precondition:** empty flow created via API; editor open; canvas focused.
- **Step by step:**
  1. Click the canvas pane, press `/`, read focus and the field value.
  2. Type `chat`; read the matching and non-matching cards.
  3. Press `Tab` until `input_output_chat input_draggable` has focus; press
     `Space`; read the node count and the node testid.
  4. Press `Tab` until `input_output_chat output_draggable` has focus; press
     `Enter`; read the node count and the new node's testid.
  5. Focus the search field, press `Escape`, read focus.
- **Validation:** as tabulated above — the criterion is the *identity* of the
  nodes added by the keyboard, not just that the canvas is non-empty.

## Last validated

1.12.x (nightly `1.12.0.dev6`)
