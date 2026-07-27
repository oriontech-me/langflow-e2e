# Spec: Add Components to Canvas from the Sidebar

**Test file:** `tests/tests-automations/regression/ui-ux/sidebar-add-component.spec.ts`

## What this test validates

The two remaining ways to get a component from the sidebar onto the canvas, plus
the state the component arrives in — the `§15.2 Add Components to Canvas`
checklist items *Drag component from sidebar to canvas*, *Double-click in sidebar
adds component to canvas* and *Added component appears with default settings*.
The third way (hover + `+` button) is already `@stable` in
`core-components/componentHoverAdd.spec.ts` and is deliberately NOT repeated here.

Three independent tests:

1. **Double-click adds the component** — searching the sidebar and double-clicking
   the result adds exactly one node, whose React Flow id is derived from the
   component type (`rf__node-ChatInput-<hash>`), with the canvas empty before the
   gesture. The empty-before assertion is what makes this a *causal* check
   instead of "some node exists".
2. **Drag from the sidebar drops the node at the drop point** — dragging the
   sidebar item onto `.react-flow__pane` with an explicit `targetPosition` adds
   the node **at that position**: the persisted `node.position` matches the drop
   point converted to flow space through the live viewport transform (≤ 20 px).
   This is the assertion that separates a real drag from a click-to-add — a
   click-added node lands wherever the app decides, not where the pointer was
   released, so a broken drop handler that silently falls back to "add at default
   position" fails here (measured live: drop at pane-relative `(700, 420)` on an
   identity viewport persisted exactly `{x: 700, y: 420}`).
3. **The added component carries the catalog defaults** — after adding the
   component, the persisted node's `data.node.template` is compared field by
   field against the same component's template in `GET /api/v1/all` (the catalog
   the frontend builds the node from): every field that declares a `value` must
   arrive with **that** value (`sender: "User"`, `sender_name: "User"`,
   `should_store_message: true`, `input_value: ""`, the full `code` string, …),
   the template's field set must match exactly, and `display_name` must be the
   catalog's. The UI side is asserted too: the node renders its title and its
   `input_value` textarea is empty. "Appears with default settings" was
   previously read as "the node header is visible", which passes on a node built
   with missing or stale defaults — this is the version with teeth.

**Consolidation note.** This spec replaces
`core-components/canvas-component-defaults.spec.ts`, deleted in the same change:
its three tests were a strict subset of the above (node count + header text after
a hover-add, after a double-click, and after a drag used only to place a second
node), it asserted no default value despite its name, and its hover-add test
duplicated the already-`@stable` `componentHoverAdd.spec.ts`. The previous
`sidebar-add-component.spec.ts` "hover and click the add button" test is dropped
for the same reason.

## Tags

`@stable` `@workspace` `@ui-ux`

## Validation criterion

| Step | Criterion |
|---|---|
| Precondition (all tests) | `.react-flow__node` `count() === 0` on the freshly created flow |
| Double-click | exactly 1 node; its `data-testid` matches `/^rf__node-ChatInput-/`; `title-Chat Input` visible |
| Drag | exactly 1 node; its `data-testid` matches `/^rf__node-ChatOutput-/`; persisted `position` within 20 px of the drop point mapped to flow space |
| Defaults — template values | for every catalog field with a `value`, `node.template[field].value` deep-equals the catalog value |
| Defaults — template shape | the node's template field names (minus `_type`) equal the catalog's |
| Defaults — identity | node `data.node.display_name` equals the catalog `display_name` (`Chat Input`) |
| Defaults — UI | `title-Chat Input` visible and `textarea_str_input_value` has value `""` |

Non-criterion (deliberate): no assertion on the *screen* coordinates of a node
(they depend on the viewport transform, which the editor changes on entry — see
`docs/ui-ux/canvas-zoom-navigation.md`); the drag test converts to flow space and
asserts the persisted position instead.

## External dependencies

- Sidebar search + component cards: `sidebar-search-input`,
  `input_outputChat Input`, `input_outputChat Output` testids.
- Canvas: `.react-flow__pane` (drop target), `.react-flow__node`,
  `rf__node-<Type>-<hash>`, `title-<Component>`, `textarea_str_input_value`.
- `GET /api/v1/all` — the component catalog the default comparison reads from.
  A component renamed or moved out of the `input_output` category fails test 3 by
  design (it is the source of truth for what "default settings" means).
- `POST /api/v1/flows/` + `GET /api/v1/flows/{id}` — flow creation and the
  persisted-node read (after `waitForFlowSaveSettled`, polled to the expected
  node count so the assert never runs on a stale read).

No provider API key, no LLM call, no flow build.

Flow cleanup: each test creates its own flow through the API (empty
`nodes`/`edges`, identity viewport) and deletes it by id in `afterEach` — never a
wipe. The previous version of this spec created flows by clicking `blank-flow`
after `awaitBootstrapTest` and deleted nothing.

## Scenarios

### 15.2.1 Double-click in the sidebar adds the component [-]

- **File:** `tests/tests-automations/regression/ui-ux/sidebar-add-component.spec.ts`
- **Objective:** prove the double-click gesture on a sidebar result adds that
  component to the canvas.
- **Precondition:** running instance; empty flow created via API; editor open at
  `/flow/{id}`; canvas empty.
- **Step by step:**
  1. Assert `.react-flow__node` count is 0.
  2. Fill `sidebar-search-input` with `chat input`; wait for
     `input_outputChat Input`.
  3. Double-click it.
- **Validation:** exactly one `.react-flow__node`, its testid starts with
  `rf__node-ChatInput-`, and `title-Chat Input` is visible.

### 15.2.2 Drag from the sidebar drops the component at the pointer [-]

- **File:** same
- **Objective:** prove dragging a sidebar component onto the canvas adds it **at
  the drop position**.
- **Precondition:** as above.
- **Step by step:**
  1. Assert the canvas is empty; read the pane rect and the viewport transform.
  2. Search `chat output`; drag `input_outputChat Output` onto
     `.react-flow__pane` with an explicit `targetPosition`.
  3. Wait for the node, then for persistence (`GET /api/v1/flows/{id}` polled
     until it reports 1 node).
- **Validation:** exactly one node, testid starting with `rf__node-ChatOutput-`,
  and the persisted `position` within 20 px of the drop point converted to flow
  space with the live transform.

### 15.2.3 The added component arrives with its catalog defaults [-]

- **File:** same
- **Objective:** prove a freshly added component is built from the component
  catalog's defaults, not from an empty or stale template.
- **Precondition:** as above.
- **Step by step:**
  1. Fetch `GET /api/v1/all` and take `input_output.ChatInput`.
  2. Add Chat Input via double-click; wait for persistence.
  3. Read the persisted node and compare template field names and every field
     `value` against the catalog; compare `display_name`.
  4. Read the node's `textarea_str_input_value` in the UI.
- **Validation:** field sets equal, every catalog `value` present verbatim on the
  node, `display_name` equal, `title-Chat Input` visible and the textarea empty.

## Last validated

1.12.x (nightly `1.12.0.dev6`)
