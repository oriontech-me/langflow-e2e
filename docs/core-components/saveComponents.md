# Spec: Save flow components as template

**Test file:** `tests/tests-automations/regression/core-components/saveComponents.spec.ts`

**Last validated:** Langflow 1.12.x (nightly `1.12.0.dev23`)

---

## What this test validates

A user can **save a component from the canvas as a reusable template**: after
adding a component to a flow, selecting it and choosing **Save** (the
`SaveAll` action in the node's more-options menu) persists it as a saved
component that (a) shows up in the sidebar's **Saved** section as a draggable
item and (b) is stored as a flow with `is_component = true`, so it can be reused
in any flow.

This is the §12.5 "Save flow components as template" behaviour. The action is
driven off the node more-options menu (`more-options-modal` → `icon-SaveAll`) and
surfaces in the sidebar under the `disclosure-saved` disclosure.

---

## Setup & determinism

- A **blank flow** is created via the REST API (`createFlow`, `is_component:
  false`) and opened at `/flow/<id>` — deterministic, no empty-page bootstrap
  race.
- A **Chat Input** component is added from the sidebar. The add button is scoped
  to the built-in Input & Output entry
  (`input_output_chat input_draggable` → `add-component-button-chat-input`)
  because when a saved component named "Chat Input" also exists, a homonymous
  `add-component-button-chat-input` renders under the Saved section and the bare
  testid is ambiguous. The node is then selected (`title-Chat Input`) and saved
  via `more-options-modal` → `icon-SaveAll`.
- **The scoping ancestor is the `group/draggable` wrapper, not the row div**
  (#1384). Upstream's a11y pass (`langflow-ai/langflow#14250`, `46d25720c2`, on
  the `release-1.12.0` line) moved the `flex shrink-0` container holding the "+"
  **out** of `data-testid={sectionName + display_name}` and made it that div's
  sibling. The old chain `input_outputChat Input → add-component-button-chat-input`
  therefore matched nothing and the click timed out (20 s) on the 2026-08-10
  daily. The wrapper (`<section>_<name>_draggable`) is still one per section —
  `saved_components_chat input_draggable` for the saved homonym — so it
  disambiguates exactly as the row div used to. This spec only needs to *add* a
  Chat Input; the button is a means, not the subject, so the change is a locator
  fix with no assertion moved.
- **Saving does not replace a same-named component — it suffixes it**
  ("Chat Input" → "Chat Input (1)") and opens a modal, which would break a clean
  save. The Saved-components namespace is global per user, and the node's inline
  title is not editable (`node-name` carries the `nodoubleclick` class;
  more-options has no rename), so the saved name cannot be made per-run unique on
  the canvas. Instead, the spec **pre-cleans** any leftover "Chat Input"/"Chat
  Input (N)" saved components (id-scoped) as a deterministic precondition — this
  is the only spec that saves a "Chat Input" component and it is a single,
  non-self-parallel test, so that name family is exclusively its own.
- The saved component created by the save is identified by **diffing the
  saved-component id set** before and after the save (exactly one new id),
  captured for id-scoped cleanup, and the sidebar draggable testid is derived
  from that flow's actual name. Both created flows (host + saved component) are
  deleted id-scoped in `afterEach`.

### Tests

1. **Saving a canvas component as a template makes it reusable from the
   sidebar.** Pre-clean stale "Chat Input" saved components, add Chat Input to a
   blank flow, select it, and Save via `more-options-modal` → `icon-SaveAll`.
   Then assert:
   - **API:** exactly one new saved component appears (id-diff vs the pre-save
     set) and it has `is_component === true` — the persisted, reusable template.
     Its id is captured for id-scoped cleanup.
   - **UI:** the sidebar **Saved** disclosure (`disclosure-saved`) is visible and
     the saved component renders as a draggable item
     (`saved_components_<name>_draggable`, name derived from the created flow) —
     the reuse affordance.

---

## Tags

`@stable` `@regression` `@components` `@ui-ux`

`@components` (canvas/sidebar component configuration) + `@ui-ux` (functional).
`@stable` is added on promotion after the deterministic-run and force-fail
validation below. The inherited spec was a disabled `test.skip` with fake
`expect(true).toBeTruthy()` assertions referencing a missing fixture
(`flow_group_test.json`) — replaced wholesale.

---

## Validation criterion

| # | State | Locator / call | Expected |
|---|---|---|---|
| 1 | After Save | new saved components (id-diff vs pre-save set) | exactly `1`, with `is_component === true` (persisted template) |
| 1 | After Save | `getByTestId("disclosure-saved")` | `toBeVisible()` — Saved section present |
| 1 | After Save | `getByTestId("saved_components_<name>_draggable")` | `toBeVisible()` — saved component draggable (reuse affordance) |

Each assertion fails if the save-as-template behaviour regresses: the Save action
no longer persists the component, the Saved sidebar section stops rendering the
item, or the saved entity is not stored as an `is_component` flow.

---

## External dependencies

- `tests/helpers/flows/create-flow.ts` — API blank-flow creation;
  `tests/helpers/flows/delete-flow.ts` — id-scoped cleanup / pre-clean;
  `tests/helpers/auth/get-auth-token.ts` — auth.
- Sidebar add (scoped): `input_output_chat input_draggable` → `add-component-button-chat-input`.
- `src/frontend/src/pages/FlowPage/components/flowSidebarComponent/components/sidebarDraggableComponent.tsx` — owns which ancestor the "+" button hangs off; moving it again breaks the scoped add (#1384).
- Node more-options save affordance: `more-options-modal`, `icon-SaveAll`.
- Sidebar Saved section: `disclosure-saved`, `saved_components_<name>_draggable`.
- Saved-component API: `GET /api/v1/flows/?components_only=true` (list, diff, cleanup).
- No model-provider credentials required — no flow is executed.

Testids were confirmed live against `langflow-nightly 1.11.0.dev44` via a
throwaway scout before authoring (`disclosure-saved`,
`saved_components_chat input_draggable`, `saved_componentsChat Input`, and the
`components_only=true` API returning the `is_component` flow).

---

## Preconditions

- Langflow running at `PLAYWRIGHT_BASE_URL` on a recent nightly (1.12.x).
- Auth via `auto_login` (repo default).

---

## Relationship to existing coverage

Replaces the inherited `saveComponents.spec.ts` "save group component tests",
which was `test.skip`ped, asserted nothing real (`expect(true).toBeTruthy()`
inside `if (count > 0)` guards), and depended on a fixture that no longer exists.
The **group**-save variant (select multiple, Group, then Save the group) is not
reintroduced here — this spec covers the single-component save-as-template path,
which is the §12.5 bullet.

---

## What this test does not cover

- **Group** component save (multi-select → Group → Save) — a separate variant.
- **Dragging** the saved component back onto a canvas and running it — the
  draggable's presence in the Saved section is asserted as the reuse affordance,
  but a full drag-and-run is out of scope (flaky, and a distinct behaviour).
- Overwriting/replacing an existing saved component (the suffix-and-modal path
  when a same-named component already exists) — the spec pre-cleans that state
  instead of exercising it.

---

## Notes

- **Force-fail probes (executed during validation):** documented in the PR
  Validation block — one mutation per test, observed failing, then reverted.
- Both created flows (the blank flow and the saved component) are deleted
  id-scoped in `afterEach` — the saved component is itself an `is_component` flow
  and must be removed so it does not pollute the global Saved namespace.
